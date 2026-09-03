import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeDerivedImputedSessionChecksum,
  DERIVED_IMPUTED_RESEARCH_SESSION_SCHEMA_VERSION,
  DerivedImputedResearchSessionV1,
  DerivedResearchSessionRowV1,
  ImputationReason,
  ResearchRowProvenanceKind,
  ResearchSessionSourcePrecedenceTier,
  storeDerivedImputedResearchSession,
} from './derived-imputed-research-session.types';
import { findTrustedAuthorizedDerivedSessionEntry, lookupTrustedAuthorizedDerivedSession, TrustedDerivedSessionIntegrityError } from './trusted-authorized-derived-session-registry';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';

const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';
const TIMEFRAME = '1minute';
const TRADING_DATE = '2022-03-07';
const AUTHORIZATION_ID = 'NIFTY_2022_03_07_INDEX_GAP_V1';

let tempRoot: string;

test.beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'trusted-derived-registry-test-'));
});

test.afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function fixtureObservedRow(index: number, sourceSnapshotChecksum: string): DerivedResearchSessionRowV1 {
  const baseMs = Date.UTC(2022, 2, 7, 3, 45, 0);
  return {
    candleTime: new Date(baseMs + index * 60_000).toISOString(),
    open: '17000.00',
    high: '17000.50',
    low: '16999.50',
    close: '17000.10',
    volume: '1000',
    openInterest: null,
    availableAt: new Date(baseMs + index * 60_000 + 60_000).toISOString(),
    provenance: { kind: ResearchRowProvenanceKind.OBSERVED, sourceSnapshotChecksum },
  };
}

function fixtureImputedRows(sourceSnapshotChecksum: string): DerivedResearchSessionRowV1[] {
  const availableAt = new Date('2022-03-07T10:26:00+05:30').toISOString();
  return ['10:22:00', '10:23:00', '10:24:00'].map((time) => ({
    candleTime: new Date(`2022-03-07T${time}+05:30`).toISOString(),
    open: '17024.10',
    high: '17024.20',
    low: '17024.00',
    close: '17024.15',
    volume: '0',
    openInterest: null,
    availableAt,
    provenance: {
      kind: ResearchRowProvenanceKind.IMPUTED,
      method: 'LINEAR_BOUNDARY_INTERPOLATION',
      policyVersion: 1,
      authorizationId: AUTHORIZATION_ID,
      reason: ImputationReason.INDEX_BROADCAST_DATA_GAP,
      leftAnchor: { candleTime: new Date('2022-03-07T10:21:00+05:30').toISOString(), field: 'CLOSE', contentChecksum: 'a'.repeat(64) },
      rightAnchor: { candleTime: new Date('2022-03-07T10:25:00+05:30').toISOString(), field: 'OPEN', contentChecksum: 'b'.repeat(64) },
      sourceSnapshotChecksum,
    },
  }));
}

function buildFixtureDerivedSession(patch?: (draft: Omit<DerivedImputedResearchSessionV1, 'derivedContentChecksum'>) => Omit<DerivedImputedResearchSessionV1, 'derivedContentChecksum'>): DerivedImputedResearchSessionV1 {
  const sourceSnapshotChecksum = 'c'.repeat(64);
  const rows = [...Array.from({ length: 372 }, (_, i) => fixtureObservedRow(i, sourceSnapshotChecksum)), ...fixtureImputedRows(sourceSnapshotChecksum)];
  let payload: Omit<DerivedImputedResearchSessionV1, 'derivedContentChecksum'> = {
    schemaVersion: DERIVED_IMPUTED_RESEARCH_SESSION_SCHEMA_VERSION,
    imputationSemanticsVersion: 1,
    identity: { instrumentKey: INSTRUMENT_KEY, timeframe: TIMEFRAME, tradingDate: TRADING_DATE },
    authorizationId: AUTHORIZATION_ID,
    sourceSnapshotProviderId: HistoricalProviderId.UPSTOX,
    sourceSnapshotChecksum,
    rows,
    realRowCount: 372,
    imputedRowCount: 3,
    precedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION,
  };
  if (patch) payload = patch(payload);
  const derivedContentChecksum = computeDerivedImputedSessionChecksum(payload);
  return { ...payload, derivedContentChecksum };
}

/** Writes `session` at the REGISTRY-PINNED path (never at its own self-consistent checksum) -- used to simulate a tampered/corrupted artifact sitting at the trusted path. */
function writeAtPinnedPath(pinnedChecksum: string, session: DerivedImputedResearchSessionV1): void {
  const dir = join(tempRoot, 'derived-imputed-sessions');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${pinnedChecksum}.json`);
  writeFileSync(path, JSON.stringify(session, null, 2), { flag: 'wx' });
}

function pinnedEntry() {
  const entry = findTrustedAuthorizedDerivedSessionEntry(INSTRUMENT_KEY, TIMEFRAME, TRADING_DATE);
  assert.ok(entry, 'the March-7 registry entry must exist');
  return entry!;
}

test('findTrustedAuthorizedDerivedSessionEntry: the ONE production entry is found by exact identity', () => {
  const entry = findTrustedAuthorizedDerivedSessionEntry(INSTRUMENT_KEY, TIMEFRAME, TRADING_DATE);
  assert.ok(entry);
  assert.equal(entry?.authorizationId, AUTHORIZATION_ID);
  assert.equal(entry?.derivedContentChecksum, '088fead98e57a4337ba3ac73a3dab864b42becee6e66bf076390c33de12bdcaf');
  assert.equal(entry?.sourceSnapshotChecksum, 'ed869ef97d6c34d38249c820e36bb01ba4a5e5a7331262ff7c31c83969dea0c1');
});

test('findTrustedAuthorizedDerivedSessionEntry: an un-authorized date returns null', () => {
  assert.equal(findTrustedAuthorizedDerivedSessionEntry(INSTRUMENT_KEY, TIMEFRAME, '2022-03-08'), null);
});

test('findTrustedAuthorizedDerivedSessionEntry: an un-authorized instrument returns null', () => {
  assert.equal(findTrustedAuthorizedDerivedSessionEntry('NSE_INDEX|Bank Nifty', TIMEFRAME, TRADING_DATE), null);
});

// ---- lookupTrustedAuthorizedDerivedSession: NOT_AUTHORIZED / NOT_YET_CAPTURED / AVAILABLE ----

test('missing artifact fails closed as NOT_YET_CAPTURED (never falsely COMPLETE)', () => {
  const outcome = lookupTrustedAuthorizedDerivedSession(tempRoot, INSTRUMENT_KEY, TIMEFRAME, TRADING_DATE);
  assert.equal(outcome.kind, 'NOT_YET_CAPTURED');
});

test('no registry entry for this date -> NOT_AUTHORIZED, no file access even attempted', () => {
  const outcome = lookupTrustedAuthorizedDerivedSession(tempRoot, INSTRUMENT_KEY, TIMEFRAME, '2099-01-01');
  assert.equal(outcome.kind, 'NOT_AUTHORIZED');
});

test('a session that legitimately round-trips through store+read at ITS OWN checksum is readable (store/read primitive sanity, independent of the fixed production registry)', () => {
  const session = buildFixtureDerivedSession();
  const stored = storeDerivedImputedResearchSession(tempRoot, session);
  assert.equal(stored.wasNewlyWritten, true);
});

test('AVAILABLE happy path: the REAL committed B-M7.1 production artifact (artifacts/research-lake, read-only, never written to by this test) validates cleanly against the registry', () => {
  const outcome = lookupTrustedAuthorizedDerivedSession('artifacts/research-lake', INSTRUMENT_KEY, TIMEFRAME, TRADING_DATE);
  assert.equal(outcome.kind, 'AVAILABLE');
  if (outcome.kind === 'AVAILABLE') {
    assert.equal(outcome.session.derivedContentChecksum, '088fead98e57a4337ba3ac73a3dab864b42becee6e66bf076390c33de12bdcaf');
    assert.equal(outcome.session.realRowCount, 372);
    assert.equal(outcome.session.imputedRowCount, 3);
    assert.equal(outcome.session.rows.length, 375);
    assert.equal(outcome.relativePath, 'derived-imputed-sessions/088fead98e57a4337ba3ac73a3dab864b42becee6e66bf076390c33de12bdcaf.json');
  }
});

test('an artifact exists at the pinned path but is unparseable JSON -> hard TrustedDerivedSessionIntegrityError, never NOT_YET_CAPTURED', () => {
  const entry = pinnedEntry();
  const dir = join(tempRoot, 'derived-imputed-sessions');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${entry.derivedContentChecksum}.json`);
  writeFileSync(path, '{ this is not valid JSON', { flag: 'wx' });
  assert.throws(() => lookupTrustedAuthorizedDerivedSession(tempRoot, entry.instrumentKey, entry.timeframe, entry.tradingDate), TrustedDerivedSessionIntegrityError);
});

test('an artifact whose own content re-hashes to a DIFFERENT checksum than its pinned filename -> hard TrustedDerivedSessionIntegrityError (content checksum mismatch)', () => {
  const entry = pinnedEntry();
  const session = buildFixtureDerivedSession();
  // Deliberately corrupt one field AFTER computing the checksum, then write it under the PINNED filename -- self-consistency is now broken.
  const corrupted = { ...session, realRowCount: 999 };
  writeAtPinnedPath(entry.derivedContentChecksum, corrupted);
  assert.throws(() => lookupTrustedAuthorizedDerivedSession(tempRoot, entry.instrumentKey, entry.timeframe, entry.tradingDate), TrustedDerivedSessionIntegrityError);
});

test('wrong instrument in the artifact content -> hard integrity error', () => {
  const entry = pinnedEntry();
  const session = buildFixtureDerivedSession((draft) => ({ ...draft, identity: { ...draft.identity, instrumentKey: 'NSE_INDEX|Bank Nifty' } }));
  writeAtPinnedPath(entry.derivedContentChecksum, { ...session, derivedContentChecksum: entry.derivedContentChecksum });
  assert.throws(() => lookupTrustedAuthorizedDerivedSession(tempRoot, entry.instrumentKey, entry.timeframe, entry.tradingDate), TrustedDerivedSessionIntegrityError);
});

test('wrong timeframe in the artifact content -> hard integrity error', () => {
  const entry = pinnedEntry();
  const session = buildFixtureDerivedSession((draft) => ({ ...draft, identity: { ...draft.identity, timeframe: '5minute' } }));
  writeAtPinnedPath(entry.derivedContentChecksum, { ...session, derivedContentChecksum: entry.derivedContentChecksum });
  assert.throws(() => lookupTrustedAuthorizedDerivedSession(tempRoot, entry.instrumentKey, entry.timeframe, entry.tradingDate), TrustedDerivedSessionIntegrityError);
});

test('wrong tradingDate in the artifact content -> hard integrity error', () => {
  const entry = pinnedEntry();
  const session = buildFixtureDerivedSession((draft) => ({ ...draft, identity: { ...draft.identity, tradingDate: '2022-03-08' } }));
  writeAtPinnedPath(entry.derivedContentChecksum, { ...session, derivedContentChecksum: entry.derivedContentChecksum });
  assert.throws(() => lookupTrustedAuthorizedDerivedSession(tempRoot, entry.instrumentKey, entry.timeframe, entry.tradingDate), TrustedDerivedSessionIntegrityError);
});

test('wrong authorizationId in the artifact content -> hard integrity error', () => {
  const entry = pinnedEntry();
  const session = buildFixtureDerivedSession((draft) => ({ ...draft, authorizationId: 'SOME_OTHER_AUTHORIZATION' }));
  writeAtPinnedPath(entry.derivedContentChecksum, { ...session, derivedContentChecksum: entry.derivedContentChecksum });
  assert.throws(() => lookupTrustedAuthorizedDerivedSession(tempRoot, entry.instrumentKey, entry.timeframe, entry.tradingDate), TrustedDerivedSessionIntegrityError);
});

test('wrong precedenceTier in the artifact content -> hard integrity error', () => {
  const entry = pinnedEntry();
  const session = buildFixtureDerivedSession();
  const wrongTier = { ...session, precedenceTier: 99 as unknown as ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION, derivedContentChecksum: entry.derivedContentChecksum };
  writeAtPinnedPath(entry.derivedContentChecksum, wrongTier);
  assert.throws(() => lookupTrustedAuthorizedDerivedSession(tempRoot, entry.instrumentKey, entry.timeframe, entry.tradingDate), TrustedDerivedSessionIntegrityError);
});

test('wrong 375/372/3 counts (realRowCount) fails hard', () => {
  const entry = pinnedEntry();
  const session = buildFixtureDerivedSession((draft) => ({ ...draft, realRowCount: 371 }));
  writeAtPinnedPath(entry.derivedContentChecksum, { ...session, derivedContentChecksum: entry.derivedContentChecksum });
  assert.throws(() => lookupTrustedAuthorizedDerivedSession(tempRoot, entry.instrumentKey, entry.timeframe, entry.tradingDate), TrustedDerivedSessionIntegrityError);
});

test('wrong 375/372/3 counts (imputedRowCount) fails hard', () => {
  const entry = pinnedEntry();
  const session = buildFixtureDerivedSession((draft) => ({ ...draft, imputedRowCount: 4 }));
  writeAtPinnedPath(entry.derivedContentChecksum, { ...session, derivedContentChecksum: entry.derivedContentChecksum });
  assert.throws(() => lookupTrustedAuthorizedDerivedSession(tempRoot, entry.instrumentKey, entry.timeframe, entry.tradingDate), TrustedDerivedSessionIntegrityError);
});

test('wrong 375/372/3 counts (total rows.length) fails hard', () => {
  const entry = pinnedEntry();
  const session = buildFixtureDerivedSession((draft) => ({ ...draft, rows: draft.rows.slice(1) }));
  writeAtPinnedPath(entry.derivedContentChecksum, { ...session, derivedContentChecksum: entry.derivedContentChecksum });
  assert.throws(() => lookupTrustedAuthorizedDerivedSession(tempRoot, entry.instrumentKey, entry.timeframe, entry.tradingDate), TrustedDerivedSessionIntegrityError);
});

test('wrong sourceSnapshotChecksum fails hard', () => {
  const entry = pinnedEntry();
  const session = buildFixtureDerivedSession((draft) => ({ ...draft, sourceSnapshotChecksum: 'z'.repeat(64) }));
  writeAtPinnedPath(entry.derivedContentChecksum, { ...session, derivedContentChecksum: entry.derivedContentChecksum });
  assert.throws(() => lookupTrustedAuthorizedDerivedSession(tempRoot, entry.instrumentKey, entry.timeframe, entry.tradingDate), TrustedDerivedSessionIntegrityError);
});

test('duplicate candleTime among rows fails hard', () => {
  const entry = pinnedEntry();
  const session = buildFixtureDerivedSession((draft) => {
    const rows = [...draft.rows];
    rows[1] = { ...rows[1], candleTime: rows[0].candleTime };
    return { ...draft, rows };
  });
  writeAtPinnedPath(entry.derivedContentChecksum, { ...session, derivedContentChecksum: entry.derivedContentChecksum });
  assert.throws(() => lookupTrustedAuthorizedDerivedSession(tempRoot, entry.instrumentKey, entry.timeframe, entry.tradingDate), TrustedDerivedSessionIntegrityError);
});

test('actual OBSERVED/IMPUTED row provenance counts disagreeing with declared realRowCount/imputedRowCount fails hard', () => {
  const entry = pinnedEntry();
  const session = buildFixtureDerivedSession((draft) => {
    const rows = [...draft.rows];
    // Relabel one IMPUTED row's provenance as OBSERVED without updating the declared counts.
    const imputedIndex = rows.findIndex((row) => row.provenance.kind === ResearchRowProvenanceKind.IMPUTED);
    rows[imputedIndex] = { ...rows[imputedIndex], provenance: { kind: ResearchRowProvenanceKind.OBSERVED, sourceSnapshotChecksum: draft.sourceSnapshotChecksum } };
    return { ...draft, rows };
  });
  writeAtPinnedPath(entry.derivedContentChecksum, { ...session, derivedContentChecksum: entry.derivedContentChecksum });
  assert.throws(() => lookupTrustedAuthorizedDerivedSession(tempRoot, entry.instrumentKey, entry.timeframe, entry.tradingDate), TrustedDerivedSessionIntegrityError);
});
