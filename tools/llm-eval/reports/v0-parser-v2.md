# LLM eval v0: parser v2 baseline

Ran parser v2 (src/parse.js parseLocal) over the routing, adversarial and coverage sets at the golden time 2026-09-19T12:00:00.000Z. Audio was not run.

| set | total | result |
| --- | ---: | --- |
| routing | 164 | 164/164 correct |
| adversarial | 73 | 73/73 deferred, 0 wrong values |
| coverage: choice | 248 | 137/248 answered |
| coverage: monthyear | 100 | 41/100 answered |
| coverage: number | 50 | 23/50 answered |
| coverage: text | 712 | 712/712 answered |
| audio | 9 | not run (needs speech-to-text; run tools/stt-eval.mjs) |

## Gates

- routingUnchanged: pass
- adversarialZeroWrong: pass
- recoveredAtLeast40pct: not evaluated (needs LLM)
- textWrongAtMostHalfPct: not evaluated (needs LLM)
- latency: not evaluated (needs LLM)

Verdict: baseline only: LLM go/no-go not decided (no backend)
