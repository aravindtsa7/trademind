import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import logger from '../core/logger/logger';
import NiftyUnderlyingGapRepairService, { NiftyGapRepairResult } from '../modules/research-lake/services/nifty-underlying-gap-repair.service';
import { HistoricalDataProvider } from '../modules/research-lake/interfaces/historical-data-provider.interface';
import { HistoricalCandleRepairOutcome } from '../modules/research-lake/domain';

dotenv.config();
logger.silent = true;

const ARTIFACT_DIR = 'artifacts/research-lake';
const ARTIFACT_PATH = `${ARTIFACT_DIR}/nifty-underlying-gap-repair-result.json`;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * B-F8 CORRECTION (post-Terra-review blocker 3): the ONE place this
 * OPERATIONAL entrypoint may ever obtain a repair provider. Returns
 * `undefined` today -- see the B-F8 correction report section 16 -- because
 * no real, proven, production-suitable secondary NIFTY 1-minute provider
 * adapter exists anywhere in this repository (confirmed: Groww's
 * `fetchCompletedUnderlyingRange` throws unconditionally, no Dhan/other
 * underlying-history adapter exists). This function MUST NEVER return a
 * deterministic, fixture-driven, or otherwise test-only adapter -- that
 * boundary is enforced structurally (this file imports no such adapter at
 * all, verified by a source-text regression test; see the SEPARATE,
 * isolated-test-DB-only, manual verification entrypoint script instead, one
 * directory over, for controlled fixture-driven verification). When a real
 * adapter is built and proven
 * suitable, wiring it here is the smallest, reviewable follow-up change.
 */
export function resolveProductionRepairProvider(): HistoricalDataProvider | undefined {
  return undefined;
}

/**
 * Research-only B-F8 entrypoint. Never wired into `server.ts`, any live
 * startup path, `research:year`, or any existing acquisition CLI script --
 * gap repair is a wholly separate, deliberately-invoked, DATE-SCOPED
 * operation (task invariant J: "no hidden third retry loop", "accidental
 * broad repair runs should be guarded").
 *
 * Usage (PowerShell):
 *   $env:RESEARCH_REPAIR_TRADING_DATE = '2022-03-07'
 *   npm run research:nifty-gap-repair
 *
 * SAFETY (task invariant J/M, corrected per blocker 3): this script can
 * NEVER write fixture-generated candles into `HistoricalCandle` -- it has no
 * fixture-provider import at all, and `resolveProductionRepairProvider()`
 * above always returns `undefined` today. `NiftyUnderlyingGapRepairService`
 * itself refuses to make a single provider call or DB write when no repair
 * provider is configured (see its own invariant-A gate), so running this
 * script against the ordinary application `DATABASE_URL` always reports
 * `REPAIR_NOT_ATTEMPTED` / `NO_REPAIR_PROVIDER_CONFIGURED` and touches
 * nothing.
 */
async function run(): Promise<void> {
  const tradingDate = process.env.RESEARCH_REPAIR_TRADING_DATE?.trim();
  if (!tradingDate) {
    throw new Error('RESEARCH_REPAIR_TRADING_DATE is required (YYYY-MM-DD). This script never defaults to a range or to "today" -- gap repair is always date-scoped and explicit.');
  }
  if (!DATE_PATTERN.test(tradingDate)) {
    throw new Error(`RESEARCH_REPAIR_TRADING_DATE must be YYYY-MM-DD; received '${tradingDate}'.`);
  }

  const repairProvider = resolveProductionRepairProvider();
  console.log(
    JSON.stringify({
      event: 'research:nifty-gap-repair starting',
      tradingDate,
      repairProviderConfigured: repairProvider !== undefined,
    })
  );
  if (!repairProvider) {
    console.error(
      'NO_REAL_REPAIR_PROVIDER_CONFIGURED: no production secondary NIFTY 1-minute provider adapter is registered in this repository ' +
        '(see the B-F8 correction report, section 16). This is expected and safe -- the service will report REPAIR_NOT_ATTEMPTED and ' +
        'make zero provider calls / zero database writes. For controlled, manual, isolated-test-database-only verification with a ' +
        'deterministic fixture adapter, use `npm run research:nifty-gap-repair:fixture-verify` instead (never this script).'
    );
  }

  const service = new NiftyUnderlyingGapRepairService({ repairProvider });
  const result: NiftyGapRepairResult = await service.repairSession({ tradingDate });

  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ...result, artifact: ARTIFACT_PATH }, null, 2));

  if (result.outcome !== HistoricalCandleRepairOutcome.REPAIR_ACCEPTED && result.outcome !== HistoricalCandleRepairOutcome.REPAIR_NOT_ATTEMPTED) {
    process.exitCode = 1;
  }
}

// Only auto-executes when run directly (`tsx research-nifty-underlying-gap-repair.ts` / `npm run
// research:nifty-gap-repair`) -- never when imported, e.g. by the CLI-safety regression test that
// imports `resolveProductionRepairProvider` from this module without wanting `run()` to fire.
if (require.main === module) {
  run().catch((error) => {
    console.error('B-F8 NIFTY underlying gap repair failed.', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
