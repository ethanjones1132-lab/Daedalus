# Adapters phase 1: pre-registration

- **Committed:** 2026-10-06 15:14, before any adapters judge run.
- **Spec:** `2026-10-05-adapters-design.md` §5. **Plan:** `plans/2026-10-05-adapters-phase1.md`.

**The patch:**
- expert variant: `swap108`
- steering vector: `none` (method-layers@relative scale; the applied scale is the relative scale times the method's unit, {'mean': 0.05, 'pca': 0.2, 'why': "llama-cvector-generator writes unit-norm directions per layer, so the spec's scales 0.25 / 0.5 / 1.0 are relative: applied scale = relative x unit. The unit is the largest scale that kept keep96's output coherent with the vector on all layers, on one toy fix prompt (no task scoring).", 'coherence_screen_all_layers': {'mean': {'0.025': 'ok', '0.05': 'ok', '0.1': 'empty output', '0.2': 'token salad'}, 'pca': {'0.025': 'ok', '0.05': 'ok', '0.1': 'ok', '0.2': 'ok', '0.4': 'token salad', '0.8': 'token salad', '1.6': 'token salad'}}, 'pairs': "201 same-prompt pairs from the calibration pool's rows (steer.py make_pairs)", 'measured': '2026-10-06 01:15'})

**Chosen on the calibration pool only.** The numbers are in `docs/benchmarks/adapters/decisions.json`.

**The bar:**
- the patched recipe (3 candidates + 1 self-test suite, temperatures 0.2 / 0.7 / 0.7, the recipe's seeds) solves more of the sealed judge set's 180 samples than keep96's recipe, in a paired exact McNemar test (p < 0.10);
- tok/s at least 95% of keep96's;
- the patch at most +0.5 GB;
- no category drops by more than 3 of its 36 samples.

**Baseline:** keep96's recipe on the judge set, run by this chain with the same harness and seeds. It is paired per (task, trial). Sub-project A can reuse it.
