import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchSessionSourcePrecedenceTier } from './derived-imputed-research-session.types';
import { ResampleTargetTimeframe } from './resampled-candle.types';
import { ResearchResampleSessionDescriptor, ResearchResampleSessionStatus } from './research-underlying-resampled-candle.types';
import {
  buildResearchUnderlyingResamplingManifest,
  BuildResearchUnderlyingResamplingManifestInput,
  RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_SCHEMA_VERSION,
  RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES,
  ResearchUnderlyingResamplingManifestIntegrityError,
  ResearchUnderlyingResamplingManifestSessionEntry,
  readResearchUnderlyingResamplingManifest,
  researchUnderlyingResamplingManifestRelativePath,
  storeResearchUnderlyingResamplingManifest,
} from './research-underlying-resampling-manifest.types';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'resampling-manifest-test-'));
}

function fakeDescriptor(tradingDate: string, targetTimeframe: ResampleTargetTimeframe, overrides: Partial<ResearchResampleSessionDescriptor> = {}): ResearchResampleSessionDescriptor {
  return {
    researchResamplingSchemaVersion: 1,
    researchResamplingSemanticsVersion: 1,
    sourceAssemblyChecksum: '8'.repeat(64),
    tradingDate,
    sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION,
    sourceContentChecksum: 'c'.repeat(64),
    targetTimeframe,
    sessionWindows: [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 }],
    sourceRowCount: 375,
    expectedSourceMinuteCount: 375,
    outputCandleCount: targetTimeframe === ResampleTargetTimeframe.TWO_MINUTE ? 187 : targetTimeframe === ResampleTargetTimeframe.THREE_MINUTE ? 125 : 75,
    structuralTrailingRowCount: targetTimeframe === ResampleTargetTimeframe.TWO_MINUTE ? 1 : 0,
    missingSourceMinuteCount: 0,
    realCanonicalConstituentRowCount: 375,
    derivedObservedConstituentRowCount: 0,
    derivedImputedConstituentRowCount: 0,
    candlesContainingImputation: 0,
    researchDerivedContentChecksum: 'd'.repeat(64),
    status: ResearchResampleSessionStatus.COMPLETE_RESEARCH_SESSION,
    ...overrides,
  };
}

function sessionEntry(tradingDate: string): ResearchUnderlyingResamplingManifestSessionEntry {
  return {
    tradingDate,
    targets: {
      [ResampleTargetTimeframe.TWO_MINUTE]: fakeDescriptor(tradingDate, ResampleTargetTimeframe.TWO_MINUTE),
      [ResampleTargetTimeframe.THREE_MINUTE]: fakeDescriptor(tradingDate, ResampleTargetTimeframe.THREE_MINUTE),
      [ResampleTargetTimeframe.FIVE_MINUTE]: fakeDescriptor(tradingDate, ResampleTargetTimeframe.FIVE_MINUTE),
    },
  };
}

function baseInput(overrides: Partial<BuildResearchUnderlyingResamplingManifestInput> = {}): BuildResearchUnderlyingResamplingManifestInput {
  return {
    schemaVersion: RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_SCHEMA_VERSION,
    resamplingSemanticsVersion: 1,
    sourceAssemblyChecksum: '8'.repeat(64),
    identity: { instrumentKey: 'NSE_INDEX|Nifty 50', sourceTimeframe: '1minute', year: 2022 },
    targetTimeframes: RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES,
    sourceSessionCounts: { expectedSessions: 3, unavailableSessions: 0 },
    sessions: [sessionEntry('2022-01-03'), sessionEntry('2022-01-04'), sessionEntry('2022-03-07')],
    ...overrides,
  };
}

// ---- 44/48: determinism / input ordering ----

test('same input -> identical manifestContentChecksum', () => {
  const a = buildResearchUnderlyingResamplingManifest(baseInput());
  const b = buildResearchUnderlyingResamplingManifest(baseInput());
  assert.equal(a.manifestContentChecksum, b.manifestContentChecksum);
});

test('session input ordering does not change manifestContentChecksum', () => {
  const input = baseInput();
  const a = buildResearchUnderlyingResamplingManifest(input);
  const b = buildResearchUnderlyingResamplingManifest({ ...input, sessions: [...input.sessions].reverse() });
  assert.equal(a.manifestContentChecksum, b.manifestContentChecksum);
});

test('sessions are always stored sorted ascending by tradingDate regardless of input order', () => {
  const input = baseInput({ sessions: [sessionEntry('2022-03-07'), sessionEntry('2022-01-03'), sessionEntry('2022-01-04')] });
  const manifest = buildResearchUnderlyingResamplingManifest(input);
  assert.deepEqual(
    manifest.sessions.map((s) => s.tradingDate),
    ['2022-01-03', '2022-01-04', '2022-03-07']
  );
});

// ---- 43: duplicate date fails ----

test('duplicate trading-date session entries fail closed', () => {
  assert.throws(() => buildResearchUnderlyingResamplingManifest(baseInput({ sessions: [sessionEntry('2022-01-03'), sessionEntry('2022-01-03')] })), /duplicate trading-date entry/);
});

// ---- 45: summary coherence ----

test('summary is coherent: resolvedSessions = sessions.length, byTarget derived from descriptors', () => {
  const manifest = buildResearchUnderlyingResamplingManifest(baseInput());
  assert.equal(manifest.summary.expectedSessions, 3);
  assert.equal(manifest.summary.resolvedSessions, 3);
  assert.equal(manifest.summary.unavailableSessions, 0);
  assert.equal(manifest.summary.byTarget[ResampleTargetTimeframe.TWO_MINUTE].sessionCount, 3);
  assert.equal(manifest.summary.byTarget[ResampleTargetTimeframe.TWO_MINUTE].totalOutputCandles, 187 * 3);
  assert.equal(manifest.summary.byTarget[ResampleTargetTimeframe.TWO_MINUTE].totalStructuralTrailingRows, 1 * 3);
  assert.equal(manifest.summary.byTarget[ResampleTargetTimeframe.THREE_MINUTE].totalOutputCandles, 125 * 3);
  assert.equal(manifest.summary.byTarget[ResampleTargetTimeframe.FIVE_MINUTE].totalOutputCandles, 75 * 3);
});

// ---- checksum sensitivity ----

test('changing a descriptor field (e.g. researchDerivedContentChecksum) changes manifestContentChecksum', () => {
  const base = buildResearchUnderlyingResamplingManifest(baseInput());
  const mutatedSessions = baseInput().sessions.map((session, index) =>
    index === 0 ? { ...session, targets: { ...session.targets, [ResampleTargetTimeframe.TWO_MINUTE]: fakeDescriptor(session.tradingDate, ResampleTargetTimeframe.TWO_MINUTE, { researchDerivedContentChecksum: 'f'.repeat(64) }) } } : session
  );
  const changed = buildResearchUnderlyingResamplingManifest(baseInput({ sessions: mutatedSessions }));
  assert.notEqual(base.manifestContentChecksum, changed.manifestContentChecksum);
});

test('changing sourceSessionCounts changes manifestContentChecksum', () => {
  const base = buildResearchUnderlyingResamplingManifest(baseInput());
  const changed = buildResearchUnderlyingResamplingManifest(baseInput({ sourceSessionCounts: { expectedSessions: 3, unavailableSessions: 1 } }));
  assert.notEqual(base.manifestContentChecksum, changed.manifestContentChecksum);
});

// ---- 46/47: content-addressed idempotency ----

test('storing a manifest is a new write the first time, and an idempotent no-op-conflict the second time', () => {
  const root = tempRoot();
  try {
    const manifest = buildResearchUnderlyingResamplingManifest(baseInput());
    const first = storeResearchUnderlyingResamplingManifest(root, manifest);
    assert.equal(first.wasNewlyWritten, true);
    const second = storeResearchUnderlyingResamplingManifest(root, manifest);
    assert.equal(second.wasNewlyWritten, false);
    assert.equal(first.relativePath, second.relativePath);
    assert.equal(first.relativePath, researchUnderlyingResamplingManifestRelativePath(manifest.manifestContentChecksum));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 48: two builds at different wall clocks -> byte-identical JSON ----

test('two builds (simulating different wall clocks) produce byte-identical stored JSON', () => {
  const root = tempRoot();
  try {
    const manifestA = buildResearchUnderlyingResamplingManifest(baseInput());
    const storedA = storeResearchUnderlyingResamplingManifest(root, manifestA);
    const bytesA = readFileSync(storedA.absolutePath, 'utf8');

    // A second, independent build call -- simulates a re-run at a different wall-clock time.
    const manifestB = buildResearchUnderlyingResamplingManifest(baseInput());
    const rootB = tempRoot();
    try {
      const storedB = storeResearchUnderlyingResamplingManifest(rootB, manifestB);
      const bytesB = readFileSync(storedB.absolutePath, 'utf8');
      assert.equal(bytesA, bytesB);
    } finally {
      rmSync(rootB, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- 49: no generatedAt / timestamp / UUID / path field ----

test('no generatedAt/timestamp/UUID/machine-path field exists anywhere in the manifest', () => {
  const manifest = buildResearchUnderlyingResamplingManifest(baseInput());
  const serialized = JSON.stringify(manifest);
  assert.equal(/generatedAt/i.test(serialized), false);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(serialized), false, 'no UUID-shaped value');
  assert.equal(/[A-Z]:\\|\/tmp\/|\/home\//i.test(serialized), false, 'no machine path');
});

// ---- 50/51-ish: read-time integrity re-verification ----

test('reading back a stored manifest re-verifies checksum, duplicate dates, and summary coherence', () => {
  const root = tempRoot();
  try {
    const manifest = buildResearchUnderlyingResamplingManifest(baseInput());
    storeResearchUnderlyingResamplingManifest(root, manifest);
    const readBack = readResearchUnderlyingResamplingManifest(root, manifest.manifestContentChecksum);
    assert.equal(readBack.manifestContentChecksum, manifest.manifestContentChecksum);
    assert.deepEqual(readBack.summary, manifest.summary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a tampered stored manifest (summary silently edited, sessions unchanged) fails closed on read', () => {
  const root = tempRoot();
  try {
    const manifest = buildResearchUnderlyingResamplingManifest(baseInput());
    const stored = storeResearchUnderlyingResamplingManifest(root, manifest);
    const tampered = { ...manifest, summary: { ...manifest.summary, resolvedSessions: 999 } };
    writeFileSync(stored.absolutePath, JSON.stringify(tampered, null, 2), 'utf8');
    assert.throws(() => readResearchUnderlyingResamplingManifest(root, manifest.manifestContentChecksum), ResearchUnderlyingResamplingManifestIntegrityError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a tampered sourceSessionCounts (identity material) changes the recomputed checksum and fails closed on read', () => {
  const root = tempRoot();
  try {
    const manifest = buildResearchUnderlyingResamplingManifest(baseInput());
    const stored = storeResearchUnderlyingResamplingManifest(root, manifest);
    const tampered = { ...manifest, sourceSessionCounts: { expectedSessions: 999, unavailableSessions: 0 } };
    writeFileSync(stored.absolutePath, JSON.stringify(tampered, null, 2), 'utf8');
    assert.throws(() => readResearchUnderlyingResamplingManifest(root, manifest.manifestContentChecksum), ResearchUnderlyingResamplingManifestIntegrityError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
