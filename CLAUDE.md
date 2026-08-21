\# TradeMind Bot — Claude Code Instructions



\## Project

TradeMind Bot is a personal, single-user trading system.

Initial broker: Upstox.

Backend: Node.js + TypeScript + Express + MySQL + Prisma.

Paper/shadow/research first. Do not enable real broker order execution unless explicitly requested.



\## Working Rules

\- Inspect the repository before making assumptions.

\- Do not invent filenames, functions, call paths, schemas, or architecture.

\- Reuse existing modules and infrastructure. Do not create duplicate architecture unnecessarily.

\- Prefer the smallest production-safe change.

\- Preserve fail-closed behavior for market-data, persistence, risk, and recovery failures.

\- Do not mask, disable, swallow, or blindly retry validation/database errors.

\- Do not commit or push unless explicitly instructed.

\- Do not stop/restart live or shadow processes unless explicitly instructed.

\- Do not modify runtime artifacts unless explicitly requested.



\## Frozen Strategy Protection

These fingerprints must remain exactly unchanged unless the user explicitly authorizes a strategy-rule change:



\- V2: `f8a0ee53d6fdeb8a`

\- V4: `549aacaca3149ffd`

\- V8: `c815f819acd71e98`



Do not change frozen V2/V4/V8 thresholds during infrastructure, safety, persistence, market-data, or research work.



\## Scope Boundaries

\- A4 startup/readiness ordering is a separate task. Do not modify A4 unless the current task explicitly asks for it.

\- The MarketDataRecoveryCoordinator BACKFILLING re-entrancy issue is a separate task. Do not modify it unless explicitly requested.

\- Do not mix unrelated defects into one implementation.

\- HistoricalCandle P2002 cross-process persistence defect is already fixed/checkpointed. Do not redesign it during unrelated work.



\## Defect Workflow

For a new defect, unless explicitly told to implement immediately:



1\. Investigate first.

2\. Trace the actual call path.

3\. Use runtime/data evidence where available.

4\. Report exact file:line references.

5\. Separate confirmed facts from hypotheses.

6\. Rule out credible alternatives.

7\. Do not change code during an investigation-only task.

8\. Only propose the smallest fix after the root cause is sufficiently supported.



\## Validation

For production-code changes, run relevant tests plus:



\- TypeScript build / noEmit

\- targeted ESLint

\- `git diff --check`

\- relevant regression tests

\- frozen V2/V4/V8 fingerprint checks



Run the full discovered test suite when practical.



Never write test data into the real TradeMind database when an isolated test database can be used.



\## Git

Before committing:

\- review `git status --short`

\- stage only intended files

\- keep runtime artifacts/reports/diagnostics out of unrelated commits



Never commit or push unless explicitly instructed.

