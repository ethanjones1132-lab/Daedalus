# Final report, 2026-10-04: gpt-oss pruning, the speed lab, sampling, and the drives

**Machine:**
- CPU: i5-14400F (6 P-cores + 4 E-cores)
- RAM: **one** 16 GB DDR5-5200 stick, so single channel
- GPU: RTX 4060 8 GB
- C: Kingston NV2 1 TB NVMe, firmware CBG04418
- D: Seagate Game Drive 2 TB, USB

**Benchmark:** tier2b, 39 single-file coding tasks × 3 samples = 117, scored by running the tests.
- Run-to-run noise is about ±4. Per-category results are given wherever they matter. The categories:
  - A: algorithm fixes
  - B: fix a package whose other module is hidden
  - C: robustness fixes
  - D: file I/O
  - E: use a specific library
- llama.cpp master `836d571`, CUDA 13.4.
- The Versutus gate was paused for every measurement after 13:55 (`node gate\cli.mjs service stop`). Restore it with `service start`.

The overnight results are in `2026-10-04-overnight-results.md`. This report covers the work that followed.

---

## 1. Bottom line

| Model, best config | tier2b | Probe speed | Benchmark wall time | Real tok/s on the benchmark |
|---|---|---|---|---|
| gpt-oss-20b full, n-gram, greedy | **108/117** | 46.3 tok/s | 14.3 min | 32 |
| gpt-oss-20b keep24, n-gram, greedy | **105/117** (107 earlier at temp 0.2, no speculation) | 86.9 tok/s | **10.6 min** | 51 |
| Gemma 4 26B-A4B IQ2_M, MTP + n-gram, greedy | **105/117** | 101.7 tok/s | 5.7 min | 45* |
| Qwen3.6-35B-A3B keep96, MTP + n-gram, temperature 0.2 | 101/117 | **274.5 tok/s** | **1.7 min** | 107* |

\*Gemma and Qwen answer with the file only (median 67–76 tokens), so per-task overhead dominates their wall time.

1. **N-gram lookup is today's biggest win.** It's llama.cpp's `--spec-type ngram-mod`, which guesses tokens by copying matching text from the prompt.
   - Stacked on Gemma's and Qwen's own MTP heads, it doubles their probe speed (2.1–2.2×).
   - For gpt-oss, the win came from **dropping the EAGLE3 draft**. The draft's 0.92 GB of VRAM forced 3 more expert layers onto single-channel RAM, only 36% of its guesses were accepted, and it collapsed at long context.
2. **Pruning works for gpt-oss only mildly.**
   - 24 of 32 experts keeps 102–107/117 (105 at greedy), against 107–109 for the full model, and it runs 1.8–3.3× faster.
   - 16 of 32 loses library and API knowledge (77/117).
   - Calibrating on the model's **own transcripts** is essential. Plain-code calibration broke its reasoning.
3. **Sampling:** greedy suits gpt-oss and Gemma. Qwen wants temperature 0.2; its model-card settings cost 6–8 points.
4. **Hidden-package tasks (category B) are where every model loses points**, and the first thing pruning damages:
   - gpt-oss 14–16 of 21
   - Gemma 13–15
   - Qwen 6
5. **Hardware sets the ceiling.**
   - The single RAM stick halves bandwidth for every CPU-held expert layer.
   - **The C: SSD crashed the PC twice today** (bug check 0x124 raised by its storage driver, `stornvme`).
   - D: is readable again but not fully repaired. See section 6.

## 2. gpt-oss-20b expert pruning

**Method:**
- Same as the Qwen pilot: experts are ranked per layer by llama-imatrix activation energy (`slice_experts.py`), then the stacked expert tensors and router are sliced exactly.
- gpt-oss has bias tensors on its experts and router; the slicer now cuts those too.
- New: calibration on the full model's **own answers**, in its exact chat format. That's 64 prompts built from Python standard-library functions (fix an injected bug, implement from a docstring, write tests), run at the benchmark's settings.

**gpt-oss spreads its routing far more evenly than Qwen.** Activation energy kept on the calibration set:

| Experts kept | 75% | 50% | 37.5% | 25% |
|---|---|---|---|---|
| gpt-oss (of 32) | 95.6% (24) | 83.6% (16) | 73.4% (12) | 58.8% (8) |
| Qwen3.6 (of 256) | 98.2% | 93.7% | 89.4% | 82.2% |

| Variant | Calibration | Score | A | B | C | D | E | Speed | Note |
|---|---|---|---|---|---|---|---|---|---|
| full, 32 experts | – | 109 | 34/36 | 16/21 | 21/21 | 20/21 | 18/18 | 22.5 (EAGLE3) | Overnight baseline |
| **keep24** | own transcripts | **107** | 36 | 12 | 21 | 21 | 17 | 40.8 (7 CPU layers, no draft) | B is the only real loss |
| keep16 | own transcripts | 77 | 33 | **1** | 20 | 21 | **2** | 75.8 (all on GPU) | 18 answers had no final answer; 10 hit the token cap |
| keep16 | stdlib source | 9/39, stopped | 3/15 | 0/6 | 4/9 | 2/6 | 0/3 | – | 25 of 39 never stopped reasoning |

**Lessons:**
- **Calibration decides what survives.**
  - Raw code lacks the English reasoning gpt-oss spends half its tokens on. Pruned that way, it cannot finish thinking.
  - The own-transcript set had deliberately skipped standard-library areas near tier2b's tasks (hashing, paths, formatting) to avoid leakage. Its experts for library knowledge therefore looked idle, which is why keep16 lost category E.
  - The two calibration sets pick different experts at 16 kept: 18% different, 82% overlap.
- **Category B is the canary.** It is also what Qwen's "flat" pruning result hid: its keep96 scored 99, but B fell from 9 to 6.

## 3. Speed lab

**Method:**
- Each probe is one llama-server config: a warm-up pass, then timed short generation, a 2k-token edit and a 10k-context prompt.
- Each model first gets its base placement (CPU expert layers under the 7,168 MiB cap), then one lever at a time, then the best lossless combination.
- Rows where free RAM fell below 0.5 GB are flagged. A RAM squeeze only slows a probe, so a much faster flagged row is still a real win.

**Winners**

| Model | Base | Winner | Speedup |
|---|---|---|---|
| gpt-oss-20b full | 21.3 (EAGLE3 d3, 14 CPU layers) | **46.3**: n-gram only, 11 CPU layers | 2.2× |
| gpt-oss-20b keep24 | 26.0 (EAGLE3 d3, 11 CPU layers) | **86.9**: n-gram only, 7 CPU layers | 3.3× |
| Gemma 26B IQ2_M | 46.3 (MTP d2, 16 CPU layers) | **101.7**: MTP d2 + n-gram, 16 CPU layers | 2.2× |
| Qwen3.6 keep96 | 130.3 (MTP d2, all on GPU) | **274.5**: MTP d2 + n-gram, all on GPU | 2.1× |

**Effect of each lever** (vs base):

| Lever | gpt-oss full | gpt-oss keep24 | Gemma | Qwen keep96 | Verdict |
|---|---|---|---|---|---|
| N-gram stacked on own draft | +101% (EAGLE3+ngram) | +102% | **+120%** | **+111%** | Large; lossless |
| N-gram, no draft | **+117%** (11 CPU layers) | **+234%** (7 CPU layers) | – | +58% | Best for gpt-oss |
| No speculation at all | +60% (fewer CPU layers) | +65% | – | −43% | EAGLE3 is a net loss here |
| Draft depth | d2 +15%, d4/d5 worse | d2 +8% | d3 +4% | d3 +4% | Small |
| KV cache f16 | +5% (+13% at 10k ctx) | +2% | +6% | −1% | Small; costs ~150–200 MiB VRAM |
| 10 threads | +4% | +1% | +4% | – | Noise level |
| 6 P-core threads | −12% | −13% | −8% | – | Worse; E-cores help |
| `--no-mmap` | fails to load | fails | fails | – | Not possible with 16 GB RAM |
| Fewer experts per token (lossy) | +25% (top-3) | +30% | +21% (top-6) | +2% | Not adopted; quality not measured |
| ubatch 1024 | prefill +37% | prefill −14% | prefill +58% | prefill +13% | Prompt reading only (generation unchanged); worth it except on keep24 |

**A caution on n-gram numbers.** Lookup speed depends on how much an answer copies its prompt, so single-run means are noisy.
- Gemma's MTP+n-gram config measured 101.7 tok/s once, and 75.8 with f16 KV added.
- The tier2b wall time is the robust figure. gpt-oss's reasoning text can't be copied, so on the real benchmark n-gram added little beyond dropping EAGLE3: keep24 ran at 41.1 tok/s without speculation and 42.9 with it.

Full per-probe tables: `docs/benchmarks/2026-10-04/report-tables-2026-10-04.md`.

## 4. Sampling (tier2b at each speed-lab winner)

| Model | Current (0.2 / 0.95) | Model card | Greedy (temp 0) | **Best** |
|---|---|---|---|---|
| gpt-oss-20b full | 107 (16.9 min) | 107 (18.4 min; temp 1.0, top-p 1.0) | **108 (14.3 min)** | Greedy |
| gpt-oss-20b keep24 | 103 (12.8 min) | 102 (temp 1.0, top-p 1.0; timing invalid, the first 47 samples ran under a RAM squeeze) | **105 (10.6 min)** | Greedy |
| Gemma 26B | 103 (4.9 min) | 102 (6.3 min; temp 1.0, top-k 64, top-p 0.95) | **105 (5.7 min)** | Greedy |
| Qwen3.6 keep96 | **101 (1.7 min)** | 93 (temp 0.7, top-p 0.8, top-k 20, presence 1.5); 95 without presence penalty | 93 (1.4 min) | Temperature 0.2 |

**pass@3** is the tasks solved by at least one of 3 tries, out of 39. It's the ceiling for best-of-N with a test oracle:

| | gpt-oss full | gpt-oss keep24 | Gemma | Qwen keep96 |
|---|---|---|---|---|
| pass@3 | 38 (temp 0.2/1.0), 37 (greedy) | 36 (temp 0.2 and greedy), 35 (temp 1.0) | 35 | 35 (temp 0.2), 31 (greedy) |

**What this shows:**
- gpt-oss and Gemma are insensitive to temperature. Greedy is as good and faster.
- Qwen needs some randomness. At greedy, the same wrong hidden-package answer repeats (B 0/21). At temperature 0.2 it reaches pass@3 35/39 in **1.7 minutes per benchmark**.

## 5. Config audit (did our runtime setup handicap any model?)

- **Cut-off answers and empty output:** none in any unpruned run. Low scores (Xing 56, Tiel 83) are wrong code under our protocol, not capture problems. The only empty answers came from the pruned gpt-oss.
- **Sampling** mattered for one model only: Qwen at its card settings (−6 to −8). Every earlier run used temperature 0.2, which is near-optimal for all three.
- **8-bit KV cache:** f16 is 1–6% faster where the model is CPU-bound, and helps long context. Its effect on quality wasn't separately measured. The n-gram sampling runs, at q8_0, matched the earlier scores within noise.

## 6. Hardware and drives

**RAM.** One DDR5 stick means single-channel bandwidth. Every expert layer held on the CPU runs at half the speed a second matching stick (16 GB DDR5-5200) would give. That bottleneck is why gpt-oss and Gemma lag Qwen, whose experts all sit on the GPU. 32 GB would also end the RAM squeeze and paging seen all day.

**C: SSD (Kingston NV2), crashed twice, reset once.**
- **The incidents:**
  - 04:10: controller reset (stornvme 129).
  - 11:13: bug check 0x124. The WHEA record decodes to STORPORT/stornvme on the KINGSTON SNV2S1000G.
  - About 18:04: the same bug check, again.
- **Under what load:** each time, a multi-GB model file had just been written or was being read, while RAM was nearly full and Windows was paging. C: was 98%, then 91%, full.
- **Health readings:**
  - Wear 0%.
  - 40 °C idle; peak 56 °C under today's runs, so heat isn't the cause.
  - Worst read stall 2.7 s.
- **Mitigations in place:** 3-minute pauses after big writes, 30-second pauses between model loads, a 70 °C guard, and deleting tested slices.
- **Suggested:**
  1. Kingston SSD Manager firmware check.
  2. Keep 10%+ of C: free.
  3. Don't game during runs. A game's 3.4 GB pushed the model's pages out of RAM and onto the SSD at 19:50.
  4. A test worth trying: in Windows' power plan, set *PCI Express → Link State Power Management* to **Off**. NVMe power-state transitions are a known cause of this kind of stornvme fault. That's a system setting, so it's your call.
  5. Back up anything on C: that isn't on GitHub. C: is now effectively your only working drive.

**D: (Seagate Game Drive), mostly back.**
- **SMART:** passed; 0 reallocated; 0 interface errors. Pending sectors went 96 → 88 after Fix All Fast, then → 32 after Fix All Long.
- **Mount state:** NTFS, flagged "Full Repair Needed". Folders open with admin rights; for your normal user they still say "access denied".
- **Last offline repair:** it got through the file table, indexes and permissions store. It then failed reading the NTFS journal (volume offset 0xb8876000), and file-table entries 36–43 are still unreadable.
- **Next:** another ~5-minute SeaTools Fix All Long pass. Then run `Repair-Volume -OfflineScanAndFix` again (`scripts\d_repair_volume.ps1`), and restore normal-user access if it's still admin-only.
- **Afterwards:** copy irreplaceable folders (e.g. a personal-documents folder) off, and use the drive only for re-downloadable data.
- **Status at 21:10:** unchanged after a clean restart.
  - Still 32 pending sectors. Windows keeps retrying two spots: LBA 0x5C4BB0 (the journal) and LBA 0x600800 (where reads run into file-table entries 36–43).
  - That is 343 errors in the first 16 minutes after boot. Unplug the drive until the SeaTools step is done.

## 7. Recommended serving configs

Assumes the Versutus gate is paused. With it running, move about 3 more expert layers to the CPU for gpt-oss and Gemma. Common flags:

```
llama-server -ngl 99 -c 16384 -ctk q8_0 -ctv q8_0 --flash-attn on -b 512 -ub 512 -np 1 --jinja --cache-ram 0
```

| Model | Model-specific flags | Request settings |
|---|---|---|
| gpt-oss-20b full | `-m gpt-oss-20b-MXFP4.gguf --n-cpu-moe 11 --reasoning-budget -1 --spec-type ngram-mod --spec-draft-n-max 16` | temperature 0, `reasoning_effort: low` |
| gpt-oss-20b keep24 | same, with `-m gpt-oss-20b-MXFP4-keep24-selfgen.gguf --n-cpu-moe 7` | temperature 0, `reasoning_effort: low` |
| Gemma 26B IQ2_M | `-m google_gemma-4-26B-A4B-it-IQ2_M.gguf --n-cpu-moe 16 --reasoning-budget 0 --spec-type draft-mtp,ngram-mod --spec-draft-n-max 2 -md mtp-gemma-4-26B-A4B-it.gguf` | temperature 0 |
| Qwen3.6 keep96 | `-m Qwen3.6-35B-A3B-UD-IQ2_M-keep96.gguf --n-cpu-moe 0 --reasoning-budget 0 --spec-type draft-mtp,ngram-mod --spec-draft-n-max 2` | temperature 0.2, top-p 0.95 |

`scripts/moe-bench/serve-qwen36-35b.ps1` now serves keep96 with MTP + n-gram by default.

## 8. Next

1. **Best-of-N with an execution check, on Qwen keep96.** At 1.7 min per benchmark and pass@3 35/39, 5–10 samples with test feedback should beat every single-shot score here. This is the "verifier-first" idea from the 2026-10-02 design doc, now cheap.
2. **A second RAM stick.** It's the cheapest large speedup for gpt-oss and Gemma, and it removes the paging that stresses C:.
3. **Category B.** Every model's weak spot. Try prompts or scaffolding that make the model infer the hidden module's API before editing.
4. **Pruning follow-ups:** keep28 for gpt-oss; calibration sets that also cover library and API use; measure the lossy "fewer experts per token" lever on quality.

## Files

- **Scripts:** `scripts/moe-bench/` (added today):
  - `prune_gptoss.py`, `make_keep24.py`
  - `speedlab.py`, `sampling_sweep.py`, `report_tables.py`
  - `ssd_watch.ps1`, `ssd_guard.ps1`, `run_rest.ps1`
  - plus updates to `slice_experts.py` (bias tensors, multiple imatrix files), `moe_sweep.py` and `tier2b_llama.py` (`--sampling`)
- **Raw results:** `docs/benchmarks/2026-10-04/`
  - `prune-gptoss-results.jsonl`, `speedlab-*.jsonl`, `speedlab-best-2026-10-04.json`, `sampling-results-2026-10-04.jsonl`
  - every tier2b run, with raw answers
