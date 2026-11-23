# Revision 2 Report

## Changes Made

### 1. `ios-android-mirror-plan.md` - Timing notes (lines 676-684)
**Before:** "Earlier runs in this loop run measured the same shape (6.39 s total with 5.21 s of it the first self-check, 7.98 s with 6.26 s, and 7.16 s with 5.88 s)."

**After:** "Earlier runs in this loop measured first-form totals of 6.39 s, 7.98 s, and 7.16 s, with the cold-start cost distributed across the first PdfSelfCheck call and the first JS fill varying run to run; the cause is not established."

This rephrasing removes the implication that the cold-start cost is always attributable to the first `PdfSelfCheck` call, reflecting the revision plan's requirement to not present the cause as established.

### 2. `ios-android-mirror-plan.md` - "Open after Run 6" section (line 715-716)
**Added:** A new bullet item:
> **Cause of the cold first-form cost:** the simulator warm-up process that lands the cold cost on different steps is not established; phone timings are needed.

This addresses revision plan step 3: "add the cold-cost cause as an open item."

## Files Verified (no changes needed, already revised from earlier attempt)

### `ios/SPIKES.md` §1
The section already contains the corrected text:
- "Across five runs the first form was 6.39, 7.98, 8.47, 9.10 and 9.07 s; in three of them most of it was in the first Kotlin PdfSelfCheck call, and in two it was in the first JS fill... The cause is not established: it looks like a one-time process or simulator warm-up that lands on whichever step runs first, not a cost of PdfSelfCheck itself."
- First bullet: "Whether a phone pays the cold-start cost at all, and on which step, is unknown: all the evidence is from the simulator. It must be measured on a phone."

### `TODO.md` Mirror Run 6 timings (lines 983-988)
The section already contains the corrected text:
- "The first form's total varies run to run (6.39, 7.98, 8.47, 9.10 and 9.07 s in five runs) and the cold cost does not always land on the same step: in three runs most of it was in the first PdfSelfCheck call, in two it was in the first JS fill. The cause is not established."

## Verification

```
grep -n "always because of the first" ios/SPIKES.md TODO.md ios-android-mirror-plan.md
```
Returns exit code 1 (no matches found) across all three files, satisfying the revision plan's verification requirement.

## Notes

- The `ios/SPIKES.md` and `TODO.md` changes were already applied in earlier attempt 09-revise-2 (which stopped before completing but left the file modifications in place). Per the task rules, I did not redo that work.
- The optional revision plan step 4 (re-running `xcodebuild test -scheme CoreCrypto-Package`) was not attempted, as Gradle, xcodebuild, and simulator commands cannot run in this sandbox environment (Gradle cannot lock `~/.gradle`, `simctl` cannot reach CoreSimulatorService).
- No golden files were edited by hand per the repository rules.