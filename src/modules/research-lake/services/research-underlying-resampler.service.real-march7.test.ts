import assert from 'node:assert/strict';
import test from 'node:test';
import { ResearchSessionSourcePrecedenceTier } from '../domain/derived-imputed-research-session.types';
import { RESEARCH_UNDERLYING_ASSEMBLY_STORAGE_ROOT, readResearchUnderlyingDatasetAssembly } from '../domain/research-underlying-assembly.types';
import { ResampleTargetTimeframe } from '../domain/resampled-candle.types';
import { ResearchCandleQuality } from '../domain/research-underlying-resampled-candle.types';
import { regularSessionWindow } from '../domain/session-window-expected-minutes.util';
import ResearchUnderlying1mSessionReaderService from './research-underlying-1m-session-reader.service';
import ResearchUnderlyingResamplerService from './research-underlying-resampler.service';

/**
 * B-M7.3 real-artifact integration test: exercises the trusted, COMMITTED
 * B-M7.2 2022 assembly (`8506497d...ecdb.json`) and the trusted, COMMITTED
 * B-M7.1 March-7 derived artifact (`088fead9...decdaf.json`) READ-ONLY, via
 * the SAME `ResearchUnderlying1mSessionReaderService` boundary a real
 * production run would use. Zero writes, zero provider calls, zero
 * canonical DB reads (a tier-3 AUTHORIZED_DERIVED_IMPUTED_SESSION never
 * touches `HistoricalCandle` -- see that reader's own `resolveDerivedRows`).
 *
 * The certified calendar session window itself is NOT re-derived from a
 * live calendar-service DB call here (task: tests must use temp roots,
 * fakes, or committed artifacts READ-ONLY) -- `regularSessionWindow()` is
 * used directly, which is exactly correct for 2022-03-07 (task: "Using
 * regular-session anchoring at 09:15 IST, the trusted March-7 source must
 * produce these exact availability cases").
 */

const LOCKED_SOURCE_ASSEMBLY_CHECKSUM = '8506497dfdb15f4a1e7da08d43e64a6a21928252e251312c771d7195ba19ecdb';
const MARCH_7_DATE = '2022-03-07';
const REGULAR_WINDOW = regularSessionWindow();
const reader = new ResearchUnderlying1mSessionReaderService();
const resampler = new ResearchUnderlyingResamplerService();

function march7Minute(minuteOfDay: number): Date {
  const dayStartMs = new Date(`${MARCH_7_DATE}T00:00:00+05:30`).getTime();
  return new Date(dayStartMs + minuteOfDay * 60_000);
}

test('the real committed B-M7.2 2022 assembly resolves March-7 as tier 3 with exactly 375 real derived rows (372 OBSERVED + 3 IMPUTED)', async () => {
  const assembly = readResearchUnderlyingDatasetAssembly(RESEARCH_UNDERLYING_ASSEMBLY_STORAGE_ROOT, LOCKED_SOURCE_ASSEMBLY_CHECKSUM);
  const march7 = assembly.sessions.find((session) => session.tradingDate === MARCH_7_DATE);
  assert.ok(march7);
  assert.equal(march7!.precedenceTier, ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION);

  const outcome = await reader.resolveSessionRows(assembly.identity.instrumentKey, assembly.identity.timeframe, march7!);
  assert.equal(outcome.kind, 'RESOLVED');
  if (outcome.kind !== 'RESOLVED') return;
  assert.equal(outcome.rows.length, 375);
});

async function resampleRealMarch7(targetTimeframe: ResampleTargetTimeframe) {
  const assembly = readResearchUnderlyingDatasetAssembly(RESEARCH_UNDERLYING_ASSEMBLY_STORAGE_ROOT, LOCKED_SOURCE_ASSEMBLY_CHECKSUM);
  const march7 = assembly.sessions.find((session) => session.tradingDate === MARCH_7_DATE);
  assert.ok(march7 && march7.precedenceTier === ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION);
  if (!march7 || march7.precedenceTier !== ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION) throw new Error('unreachable');

  const outcome = await reader.resolveSessionRows(assembly.identity.instrumentKey, assembly.identity.timeframe, march7);
  if (outcome.kind !== 'RESOLVED') throw new Error('unreachable');

  return resampler.resampleSession({
    sourceAssemblyChecksum: assembly.assemblyContentChecksum,
    tradingDate: MARCH_7_DATE,
    sourcePrecedenceTier: march7.precedenceTier,
    sourceContentChecksum: march7.derivedContentChecksum,
    targetTimeframe,
    sessionWindows: [REGULAR_WINDOW],
    sourceRows: outcome.rows,
  });
}

test('real March-7 2m: outputCandleCount=187, structuralTrailingRowCount=1, candlesContainingImputation=2', async () => {
  const { descriptor } = await resampleRealMarch7(ResampleTargetTimeframe.TWO_MINUTE);
  assert.equal(descriptor.sourceRowCount, 375);
  assert.equal(descriptor.derivedImputedConstituentRowCount, 3);
  assert.equal(descriptor.outputCandleCount, 187);
  assert.equal(descriptor.structuralTrailingRowCount, 1);
  assert.equal(descriptor.candlesContainingImputation, 2);
});

test('real March-7 3m: outputCandleCount=125, structuralTrailingRowCount=0, candlesContainingImputation=2', async () => {
  const { descriptor } = await resampleRealMarch7(ResampleTargetTimeframe.THREE_MINUTE);
  assert.equal(descriptor.outputCandleCount, 125);
  assert.equal(descriptor.structuralTrailingRowCount, 0);
  assert.equal(descriptor.candlesContainingImputation, 2);
});

test('real March-7 5m: outputCandleCount=75, structuralTrailingRowCount=0, candlesContainingImputation=1', async () => {
  const { descriptor } = await resampleRealMarch7(ResampleTargetTimeframe.FIVE_MINUTE);
  assert.equal(descriptor.outputCandleCount, 75);
  assert.equal(descriptor.structuralTrailingRowCount, 0);
  assert.equal(descriptor.candlesContainingImputation, 1);
});

test('real March-7 exact no-lookahead availableAt proofs: 2m(10:21,10:23)=10:26, 3m(10:21)=10:26 3m(10:24)=10:27, 5m(10:20)=10:26', async () => {
  const twoMin = await resampleRealMarch7(ResampleTargetTimeframe.TWO_MINUTE);
  const bucket2mA = twoMin.candles.find((c) => c.bucketStart.getTime() === march7Minute(621).getTime());
  const bucket2mB = twoMin.candles.find((c) => c.bucketStart.getTime() === march7Minute(623).getTime());
  assert.equal(bucket2mA?.availableAt.getTime(), march7Minute(626).getTime());
  assert.equal(bucket2mB?.availableAt.getTime(), march7Minute(626).getTime());

  const threeMin = await resampleRealMarch7(ResampleTargetTimeframe.THREE_MINUTE);
  const bucket3mA = threeMin.candles.find((c) => c.bucketStart.getTime() === march7Minute(621).getTime());
  const bucket3mB = threeMin.candles.find((c) => c.bucketStart.getTime() === march7Minute(624).getTime());
  assert.equal(bucket3mA?.availableAt.getTime(), march7Minute(626).getTime());
  assert.equal(bucket3mB?.availableAt.getTime(), march7Minute(627).getTime(), 'the 10:24-10:26 bucket must be 10:27 (MAX rule), never 10:26');

  const fiveMin = await resampleRealMarch7(ResampleTargetTimeframe.FIVE_MINUTE);
  const bucket5m = fiveMin.candles.find((c) => c.bucketStart.getTime() === march7Minute(620).getTime());
  assert.equal(bucket5m?.availableAt.getTime(), march7Minute(626).getTime());
});

test('real March-7 affected bucket with a final IMPUTED constituent never forward-fills OI', async () => {
  const twoMin = await resampleRealMarch7(ResampleTargetTimeframe.TWO_MINUTE);
  const bucket = twoMin.candles.find((c) => c.bucketStart.getTime() === march7Minute(623).getTime());
  assert.ok(bucket);
  assert.equal(bucket!.openInterest, null);
  assert.equal(bucket!.quality, ResearchCandleQuality.CONTAINS_AUTHORIZED_IMPUTATION);
});

test('real March-7 checksum determinism: two independent resample runs of the same real artifact produce the identical researchDerivedContentChecksum', async () => {
  const a = await resampleRealMarch7(ResampleTargetTimeframe.FIVE_MINUTE);
  const b = await resampleRealMarch7(ResampleTargetTimeframe.FIVE_MINUTE);
  assert.equal(a.descriptor.researchDerivedContentChecksum, b.descriptor.researchDerivedContentChecksum);
});
