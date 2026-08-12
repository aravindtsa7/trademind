import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  DirectionalOptionSessionRequirement,
  deduplicateDirectionalOptionSessions,
} from './helpers/v3-option-cache-diagnostics';

const runner = 'src/tests/test-trend-down-pe-multitimeframe-research.ts';
const marker = 'RESEARCH DATA PREPARATION MANIFEST JSON ';

function runDirection(direction: 'DOWN' | 'UP'): DirectionalOptionSessionRequirement[] {
  const result = spawnSync(process.execPath, ['--import', 'tsx', runner], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      RESEARCH_UNDERLYING_INSTRUMENT_KEY: 'BSE_INDEX|SENSEX',
      RESEARCH_DIRECTION: direction,
      RESEARCH_V3_FAST_AUDIT: 'true',
      RESEARCH_PREPARE_ONLY: 'true',
      RESEARCH_PREPARE_DIAGNOSTICS: 'true',
      RESEARCH_LOCAL_ONLY: 'true',
      RESEARCH_OPTION_METADATA_CONCURRENCY: '3',
    },
  });
  if (process.env.SENSEX_V3_GLOBAL_SUMMARY_ONLY !== 'true') {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) throw new Error(`SENSEX ${direction} diagnostics exited with status ${result.status ?? 'unknown'}.`);
  const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith(marker));
  if (!line) throw new Error(`SENSEX ${direction} diagnostics did not emit its machine-readable manifest.`);
  return (JSON.parse(line.slice(marker.length)) as { requiredSessions: DirectionalOptionSessionRequirement[] }).requiredSessions;
}

function run(): void {
  const pe = runDirection('DOWN');
  const ce = runDirection('UP');
  const global = deduplicateDirectionalOptionSessions([...pe, ...ce]);
  const missing = global.filter((session) => session.completenessState === 'MISSING');
  const incomplete = global.filter((session) => session.completenessState === 'INCOMPLETE');
  const shared = global.filter((session) => session.directions.length > 1);
  console.log('SENSEX V3 GLOBAL OPTION CACHE DIAGNOSTICS', {
    uniqueRequiredSessions: global.length,
    completeLocalSessions: global.filter((session) => session.completenessState === 'COMPLETE').length,
    incompleteOrOverfullSessions: incomplete.length,
    missingLocalSessions: missing.length,
    peOnlyMissingSessions: missing.filter((session) => session.directions.length === 1 && session.directions[0] === 'PE').length,
    ceOnlyMissingSessions: missing.filter((session) => session.directions.length === 1 && session.directions[0] === 'CE').length,
    sharedDirectionalSessions: shared.length,
    exactRemoteFetchesRequired: missing.length,
    expectedNewCandleRows: missing.length * 375,
    optionCandleDownloads: 0,
  });
  console.log('SENSEX V3 GLOBAL MISSING-SESSION MANIFEST JSON', JSON.stringify({
    missingSessions: missing,
    incompleteSessions: incomplete,
  }));
  if (process.env.SENSEX_V3_WRITE_MANIFEST === 'true') {
    const requestedPath = process.env.SENSEX_V3_MANIFEST_OUTPUT_PATH?.trim() || 'artifacts/sensex-v3-global-missing-session-manifest.json';
    const outputPath = resolve(process.cwd(), requestedPath);
    const outputRelativePath = relative(process.cwd(), outputPath);
    if (!outputRelativePath || outputRelativePath.startsWith('..') || isAbsolute(outputRelativePath))
      throw new Error('SENSEX_V3_MANIFEST_OUTPUT_PATH must stay inside the repository workspace.');
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify({
      schemaVersion: 1,
      underlyingInstrumentKey: 'BSE_INDEX|SENSEX',
      researchEndDate: process.env.RESEARCH_END_DATE ?? null,
      uniqueRequiredSessions: global.length,
      missingSessions: missing,
      incompleteSessions: incomplete,
    }, null, 2)}\n`, 'utf8');
    console.log('SENSEX V3 GLOBAL MISSING-SESSION MANIFEST WRITTEN', { outputRelativePath, sessions: missing.length });
  }
}

try {
  run();
} catch (error) {
  console.error('SENSEX V3 option-cache diagnostics failed.', error);
  process.exitCode = 1;
}
