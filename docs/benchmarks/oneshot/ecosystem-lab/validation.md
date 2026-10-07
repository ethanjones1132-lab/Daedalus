# Ecosystem Lab: validation before any model build (2026-10-07)

All validation is from spec §2. Checks run with `checks.mjs` through Playwright 1.64 and the installed Chrome. There are 70 checks across 10 areas.

| Validation | Result |
|---|---|
| Reference, dev set, 3 runs | 70/70 each time; all 70 check results identical across the runs ✓ |
| Reference, sealed set | 70/70 ✓ |
| Empty page | 0/70 ✓, after the fix below |
| Independent implementation from `prompt.md` only (fresh subagent; final version) | 70/70 ✓ |

## Planted bugs

Each variant comes from `make_bugs.py`. Each must be caught by at least one check in its area.

| Variant | Expected area | Caught by | Score |
|---|---|---|---|
| `tick-order` (grass grows at the end of the tick) | algo | all 10 algo checks | 0.917 |
| `breed-off-by-one` (`>` instead of `>=`) | algo | all 10 algo checks | 0.917 |
| `euler` (RK4 replaced by Euler) | domain | `ode-values` ×3, `ode-steps-rounding`, `drift-small`, `ode-ui-run` | 0.925 |
| `no-label` (slider labels unlinked) | a11y | `sliders-labelled` | 0.986 |
| `csv-no-header` | data | `csv-exact` | 0.986 |

## Changes made during validation

All of them were made before any model saw the prompt.

1. **The check for Space-to-pause** read the tick before pausing. Pausing correctly banks the partial tick, so the check now reads the tick after pausing.
2. **Free points for an empty page.** It passed the two no-horizontal-scroll checks (2/70). Those checks now also require the two panels and the canvas to exist.
3. **Prompt §10, shortcuts.** "Active when focus is not in a text input…" let a focused button's Space also toggle play. The independent implementation read it that way and failed `buttons-keyboard`.
   - The new wording: shortcuts are active only when no input, textarea, select or button has focus.
   - With it, the independent implementation passed.
4. **Prompt §1, defaults.** With the first defaults, every population died out by tick 35–52. Long-run checks were then nearly trivial: the `tick-order` bug passed every 100- and 500-step count check.
   - A scan over 162 parameter sets × 8 seeds picked new defaults: `grassMax` 4, `rabbits0` 100, `foxes0` 6, `foxGain` 4, `foxCost` 2, `foxBreed` 40.
   - Both species then survive 1,000 ticks on all 8 scan seeds, and 500 ticks on all 20 check cases.
   - Both simulation bugs now fail every algo check.
5. **Check cases** were updated to match: dev cases (42: rabbits0 150, foxes0 10; 2026: 30×20, rabbitBreed 10), with matching sealed cases. The sealed file's sha256 was recomputed.

## The independent implementation's notes on ambiguity

These don't affect any check. They are kept here for any later edit of the prompt.

1. A full grid at placement: nothing is created and nothing is drawn.
2. Whether `lab.reset` and `loadScenario` should update the seed input and sliders. Unspecified; not checked.
3. Pressing Pause while already paused still sets the announcer text.
4. Reset while playing keeps playing. Unspecified; not checked.
5. Space on a focused button. Fixed by change 3 above.
6. Non-numeric params fall back to defaults. Unspecified; not checked.
7. `exportScenario`'s seed is the integer the generator uses.
8. `scenario-error` is cleared only on a successful load. That matches the checks.
9. `cell()` outside the grid, a non-positive `ode` step count, blank preset names. Unspecified; not checked.
10. Display precision: the shortest exact form, padded to 10 significant digits. Satisfies "at least 8".
