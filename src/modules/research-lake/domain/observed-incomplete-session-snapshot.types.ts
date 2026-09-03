import { Prisma } from '@prisma/client';
import { CanonicalHistoricalCandle } from './canonical-historical-candle';
import { canonicalManifestJson, sha256Hex } from './dataset-manifest-canonical-json';
import { ManifestCandleContent, sortManifestCandles } from './dataset-manifest.types';
import { SessionWindow } from './exchange-calendar.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { contentAddressedJsonRelativePath, ContentAddressedJsonStoreResult, readContentAddressedJson, storeContentAddressedJson } from './content-addressed-json-store';

/**
 * B-M7.1: `ObservedIncompleteSessionSnapshotV1` -- an IMMUTABLE, deterministic
 * research artifact representing exactly the QUALIFIED 372-row provider
 * observation for one incomplete session (task section 5). This is NOT
 * canonical market data (`HistoricalCandle` remains untouched -- see
 * `NiftyIndexGapImputationService`, which never writes to it) and NOT a
 * repaired provider session (`NiftyUnderlyingGapRepairService` is a wholly
 * separate, unmodified concept -- see that service's own doc). It exists
 * only as the traceable, re-hashable SOURCE of an explicitly-authorized
 * derived research dataset (`DerivedImputedResearchSessionV1`).
 *
 * IDENTITY RULE (task section 5): `snapshotContentChecksum` is a SEMANTIC
 * content checksum over exactly the fields below -- deliberately excludes
 * any capture timestamp, random UUID, machine path, git revision, or process
 * ID. Two snapshots built from the identical qualified observation always
 * produce the identical checksum, regardless of when/where they were built.
 */
export const OBSERVED_INCOMPLETE_SESSION_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * Version of the READ-ONLY historical-incomplete-evidence QUALIFICATION
 * semantics (task section 3: provider/identity/timeframe/date/calendar-
 * disposition/expected-count/health/checksum-presence/terminal-evidence
 * checks) this snapshot was produced under. Bump this if that rule set ever
 * changes, so an old snapshot's checksum never silently compares equal to
 * one produced under a materially different qualification contract.
 */
export const OBSERVED_SNAPSHOT_QUALIFICATION_SEMANTICS_VERSION = 1;

export const OBSERVED_INCOMPLETE_SESSION_SNAPSHOT_STORAGE_ROOT = 'artifacts/research-lake';
export const OBSERVED_INCOMPLETE_SESSION_SNAPSHOT_STORAGE_SUBDIR = 'observed-incomplete-session-snapshots';

export interface ObservedIncompleteSessionSnapshotIdentity {
  readonly providerId: HistoricalProviderId;
  readonly instrumentKey: string;
  readonly timeframe: string;
  readonly tradingDate: string;
}

export interface ObservedIncompleteSessionSnapshotV1 {
  readonly schemaVersion: number;
  readonly qualificationSemanticsVersion: number;
  readonly identity: ObservedIncompleteSessionSnapshotIdentity;
  /** The authoritative calendar session window(s) this observation was projected/validated against. */
  readonly sessionWindows: readonly SessionWindow[];
  readonly expectedMinuteCount: number;
  readonly observedRowCount: number;
  /** Exactly `observedRowCount` entries, sorted ascending by `candleTime` before hashing (see `computeObservedSnapshotContentChecksum`). */
  readonly rows: readonly ManifestCandleContent[];
  /** Ascending minute-of-day (IST) values missing from `expectedMinuteCount`. */
  readonly missingExpectedMinutesIst: readonly number[];
  /** `computeSourceRowsSemanticChecksum` over the RAW re-observed provider rows (task section 4) -- the SAME checksum semantics the durable B-F2C evidence row itself was computed with, so this snapshot's re-observation can be directly compared against durable evidence by value. */
  readonly sourceRowsSemanticChecksum: string;
  /** The qualified durable `HistoricalDataRetrievalSession.evidenceSemanticChecksum` this snapshot was qualified against (task section 3/5) -- links the snapshot back to the exact historical evidence row without embedding that row's own mutable/opaque database ID. */
  readonly durableHistoricalEvidenceSemanticChecksum: string;
  readonly snapshotContentChecksum: string;
}

export type ObservedIncompleteSessionSnapshotContentPayload = Omit<ObservedIncompleteSessionSnapshotV1, 'snapshotContentChecksum'>;

export function computeObservedSnapshotContentChecksum(payload: ObservedIncompleteSessionSnapshotContentPayload): string {
  const sorted: ObservedIncompleteSessionSnapshotContentPayload = { ...payload, rows: sortManifestCandles(payload.rows) };
  return sha256Hex(canonicalManifestJson(sorted));
}

export function buildObservedIncompleteSessionSnapshot(payload: ObservedIncompleteSessionSnapshotContentPayload): ObservedIncompleteSessionSnapshotV1 {
  return { ...payload, snapshotContentChecksum: computeObservedSnapshotContentChecksum(payload) };
}

/**
 * Maps one qualified/accepted canonical candle into the SAME `ManifestCandleContent`
 * shape B-F5/B-F6 already hash/store (task section 5: "reuse canonicalManifestJson
 * + sha256Hex"). `CanonicalHistoricalCandle.open/high/low/close` are plain
 * `number` (the projector/validator's own domain type) -- normalized through
 * `Prisma.Decimal(...).toFixed()`, the SAME decimal-normalization path
 * `HistoricalCandleResearchPersistenceService` already uses when persisting
 * a candle's OHLC, so this snapshot's decimal strings agree byte-for-byte
 * with what canonical persistence would have produced for the identical
 * value.
 */
export function canonicalHistoricalCandleToManifestContent(candle: CanonicalHistoricalCandle): ManifestCandleContent {
  return {
    candleTime: candle.candleTime.toISOString(),
    open: new Prisma.Decimal(candle.open).toFixed(),
    high: new Prisma.Decimal(candle.high).toFixed(),
    low: new Prisma.Decimal(candle.low).toFixed(),
    close: new Prisma.Decimal(candle.close).toFixed(),
    volume: candle.volume.toString(),
    openInterest: candle.openInterest === null ? null : candle.openInterest.toString(),
  };
}

export function observedIncompleteSessionSnapshotRelativePath(snapshotContentChecksum: string): string {
  return contentAddressedJsonRelativePath(OBSERVED_INCOMPLETE_SESSION_SNAPSHOT_STORAGE_SUBDIR, snapshotContentChecksum);
}

/**
 * Persists `snapshot` at its content-addressed path (task section 5: "If
 * persisted to disk, make it content-addressed and immutable"). Idempotent:
 * an existing snapshot at the same checksum-derived path is verified, never
 * blindly overwritten (`storeContentAddressedJson`'s own contract).
 */
export function storeObservedIncompleteSessionSnapshot(root: string, snapshot: ObservedIncompleteSessionSnapshotV1): ContentAddressedJsonStoreResult {
  return storeContentAddressedJson(
    root,
    OBSERVED_INCOMPLETE_SESSION_SNAPSHOT_STORAGE_SUBDIR,
    snapshot.snapshotContentChecksum,
    snapshot,
    (parsed) => computeObservedSnapshotContentChecksum(stripSnapshotChecksum(parsed))
  );
}

export function readObservedIncompleteSessionSnapshot(root: string, snapshotContentChecksum: string): ObservedIncompleteSessionSnapshotV1 {
  return readContentAddressedJson<ObservedIncompleteSessionSnapshotV1>(root, OBSERVED_INCOMPLETE_SESSION_SNAPSHOT_STORAGE_SUBDIR, snapshotContentChecksum);
}

function stripSnapshotChecksum(snapshot: ObservedIncompleteSessionSnapshotV1): ObservedIncompleteSessionSnapshotContentPayload {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it from `payload`
  const { snapshotContentChecksum, ...payload } = snapshot;
  return payload;
}
