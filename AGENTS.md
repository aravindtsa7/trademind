\# TradeMind Bot — Agent Instructions



All coding/review agents working in this repository must follow these rules.



\## Core Rules

\- Inspect actual repository code before making claims.

\- Never invent repository structure or behavior.

\- Make the smallest production-safe change.

\- Reuse existing architecture.

\- Keep unrelated defects/tasks separate.

\- Preserve fail-closed safety behavior.

\- Do not suppress validation or database errors to make tests pass.

\- Do not commit or push without explicit user approval.



\## Frozen Strategies

Do not alter strategy behavior or thresholds unless explicitly authorized.



Required fingerprints:



\- V2: `f8a0ee53d6fdeb8a`

\- V4: `549aacaca3149ffd`

\- V8: `c815f819acd71e98`



\## Protected Separate Work

Do not modify unless explicitly included in the current task:



\- A4 current-generation market-data readiness/startup ordering

\- MarketDataRecoveryCoordinator BACKFILLING re-entrancy

\- real broker execution

\- frozen strategy thresholds



\## Bug Investigation

For investigation-only tasks:

\- make no code changes

\- trace the real call path

\- report file:line evidence

\- use runtime/data evidence

\- distinguish CONFIRMED / PLAUSIBLE / RULED OUT

\- identify remaining uncertainty

\- do not commit or push



\## Implementation

Before editing:

\- confirm root cause

\- inspect all affected callers/contracts

\- preserve existing behavior outside the defect

\- add deterministic regression coverage



After editing:

\- run targeted tests

\- run TypeScript build/noEmit

\- run targeted lint

\- run `git diff --check`

\- verify V2/V4/V8 fingerprints

\- run broader suite when practical



\## Runtime/Data Safety

\- Do not restart live/shadow processes unless explicitly requested.

\- Do not mutate production trading data during investigation.

\- Use isolated test databases for destructive/integration tests.

\- Do not stage runtime artifacts, reports, or diagnostics in unrelated commits.

