import assert from 'node:assert/strict';
import test from 'node:test';
import { DatasetHealthStatus } from './dataset-health.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import {
  EvidenceSemanticChecksumInput,
  HistoricalCandleSessionPersistenceOutcome,
  computeEvidenceSemanticChecksum,
} from './historical-data-retrieval.types';

function baseInput(overrides: Partial<EvidenceSemanticChecksumInput> = {}): EvidenceSemanticChecksumInput {
  return {
    providerId: HistoricalProviderId.UPSTOX,
    instrumentKey: 'NSE_INDEX|Nifty 50',
    timeframe: '1minute',
    tradingDate: '2024-01-19',
    calendarDisposition: 'REGULAR_TRADING_DAY',
    expectedMinuteCount: 375,
    providerRowCountForDate: 375,
    acceptedRowCount: 375,
    excludedRowCount: 0,
    sourceOrderAnomalyCount: 0,
    healthStatus: DatasetHealthStatus.HEALTHY,
    persistenceOutcome: HistoricalCandleSessionPersistenceOutcome.ACCEPTED_NEW,
    sourceRowsSemanticChecksum: 'abc123',
    canonicalContentChecksum: 'def456',
    ...overrides,
  };
}

// ---- B-F2C invariant 13: manifest/evidence stability -- semantic content only, never wall-clock/random IDs ----

test('computeEvidenceSemanticChecksum: identical semantic input produces the identical checksum -- the function signature itself has no retrievalId/id/createdAt/retrievedAt/UUID field to vary', () => {
  assert.equal(computeEvidenceSemanticChecksum(baseInput()), computeEvidenceSemanticChecksum(baseInput()));
});

test('computeEvidenceSemanticChecksum: two "retrievals" computed at different wall-clock moments (simulated by a delay) still produce the identical checksum for the identical semantic content', async () => {
  const first = computeEvidenceSemanticChecksum(baseInput());
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = computeEvidenceSemanticChecksum(baseInput());
  assert.equal(first, second);
});

test('computeEvidenceSemanticChecksum: a different persistenceOutcome changes the checksum -- CONFLICT must never hash identically to ACCEPTED_NEW', () => {
  const accepted = computeEvidenceSemanticChecksum(baseInput({ persistenceOutcome: HistoricalCandleSessionPersistenceOutcome.ACCEPTED_NEW }));
  const conflict = computeEvidenceSemanticChecksum(baseInput({ persistenceOutcome: HistoricalCandleSessionPersistenceOutcome.CONFLICT }));
  assert.notEqual(accepted, conflict);
});

test('computeEvidenceSemanticChecksum: a different provider changes the checksum', () => {
  const upstox = computeEvidenceSemanticChecksum(baseInput({ providerId: HistoricalProviderId.UPSTOX }));
  const groww = computeEvidenceSemanticChecksum(baseInput({ providerId: HistoricalProviderId.GROWW }));
  assert.notEqual(upstox, groww);
});

test('computeEvidenceSemanticChecksum: a different sourceRowsSemanticChecksum (provider content drift) changes the checksum', () => {
  const a = computeEvidenceSemanticChecksum(baseInput({ sourceRowsSemanticChecksum: 'abc123' }));
  const b = computeEvidenceSemanticChecksum(baseInput({ sourceRowsSemanticChecksum: 'zzz999' }));
  assert.notEqual(a, b);
});

test('computeEvidenceSemanticChecksum: excludedRowCount/sourceOrderAnomalyCount are part of the semantic identity (exclusion/anomaly evidence remains durable, invariant 10)', () => {
  const clean = computeEvidenceSemanticChecksum(baseInput({ excludedRowCount: 0, sourceOrderAnomalyCount: 0 }));
  const withExclusions = computeEvidenceSemanticChecksum(baseInput({ excludedRowCount: 3, sourceOrderAnomalyCount: 1 }));
  assert.notEqual(clean, withExclusions);
});
