# diff-speed

[![make.fun](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![Rank](https://make.fun/badge/diff-speed-01-run-20261126/AuruumAshcroft/diff-speed/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)
[![Reward](https://make.fun/badge/diff-speed-01-run-20261126/AuruumAshcroft/diff-speed/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126?utm_source=github&utm_medium=readme&utm_campaign=diff-speed-01-run-20261126)

A faster drop-in for makefun-diff 1.0.0: `solve.js` returns byte-for-byte the
same patch string for every input `{ old, new }`, but runs much faster.

How it is faster: the reference builds a fresh path object (plus a fresh
component object) for every `(d, k)` cell of Myers's greedy search — millions
of allocations per case. This module instead keeps the furthest `x` per
diagonal in one flat `Int32Array` trace and backtracks from the first cell
that reaches both ends, recomputing each step's move from the stored rows
with the very same tie-break (deletion wins) and validity rules, so the
rebuilt script is exactly the reference's. Lines are interned to integer ids
once, so every comparison in the prefix, suffix and snakes is a single int
compare instead of a string compare.

Layout: `solve.js` (the entrypoint's `run`), `main.ts` (the harness driver:
reads `/input/cases.json`, writes `/output/answers.json`), `LICENSE` (MIT).
