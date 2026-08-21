import {
  HistoricalCandle,
  HistoricalCandleSyncLog,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import logger from '../../../core/logger/logger';

const defaultPrismaClient = new PrismaClient();

/**
 * A price value that legitimately represents a plain decimal quantity: a
 * JS number/string, a real `Prisma.Decimal` instance, or a genuine
 * `DecimalJsLike` structural value (the exact `{ d, e, s, toFixed() }`
 * shape the installed Prisma runtime declares -- see
 * `isDecimalJsLikeShape`, not merely any object with a callable
 * `toFixed()`). This is narrower than Prisma's generated
 * `DecimalFieldUpdateOperationsInput`, which also permits
 * mutation-operator objects (`{ increment }`, `{ multiply }`, ...) this
 * table has never needed and that a raw `ON DUPLICATE KEY UPDATE`
 * statement cannot express as a single SET value.
 */
export type HistoricalCandleDecimalInput = number | string | Prisma.Decimal | Prisma.DecimalJsLike;

/**
 * Repository-specific create contract: plain domain values only, not
 * Prisma's full mutation surface. Every field here is exactly what the
 * three real callers (`LivePaperFreshWarmupService`,
 * `HistoricalCandleSyncService`, `prepare-banknifty-underlying-history.ts`)
 * already construct -- narrowing to this shape drops nothing any caller
 * uses.
 */
export interface HistoricalCandleCreateValues {
  instrumentKey: string;
  timeframe: string;
  candleTime: Date;
  open: HistoricalCandleDecimalInput;
  high: HistoricalCandleDecimalInput;
  low: HistoricalCandleDecimalInput;
  close: HistoricalCandleDecimalInput;
  volume: bigint | number;
  openInterest?: bigint | number | null;
  source: string;
  /**
   * Overrides the schema's `DEFAULT CURRENT_TIMESTAMP(3)` (see
   * prisma/migrations/20260805102657_add_historical_candle_models). Omit to
   * let MySQL populate it from the database server's own clock at insert
   * time -- the same clock source the schema already relied on before this
   * fix; the atomic writer does not substitute the application's clock for
   * this by default. Never touched by an ON DUPLICATE KEY UPDATE.
   */
  createdAt?: Date;
  /** Omit to stamp "now" at write time (there is no DB-level default for this column). */
  updatedAt?: Date;
}

/**
 * Repository-specific update contract for the `ON DUPLICATE KEY UPDATE`
 * branch. Deliberately excludes `instrumentKey`, `timeframe`, `candleTime`,
 * `id`, and `createdAt` -- these anchor the row's identity (or, for
 * `createdAt`, its original insert time) and must never be part of an
 * update. A caller that reaches this repository through a cast rather than
 * this type is still rejected at runtime (see `assertNoUnsupportedUpdateFields`).
 */
export interface HistoricalCandleUpdateValues {
  open?: HistoricalCandleDecimalInput;
  high?: HistoricalCandleDecimalInput;
  low?: HistoricalCandleDecimalInput;
  close?: HistoricalCandleDecimalInput;
  volume?: bigint | number;
  openInterest?: bigint | number | null;
  source?: string;
  updatedAt?: Date;
}

export interface HistoricalCandleUpsertInput {
  create: HistoricalCandleCreateValues;
  update: HistoricalCandleUpdateValues;
}

/**
 * The complete, exact set of keys `HistoricalCandleUpdateValues` supports.
 * Validated as an ALLOWLIST (every key in the caller's `update` object must
 * be one of these), not a blacklist of specifically-forbidden names -- an
 * allowlist also catches an arbitrary typo/unknown field (e.g.
 * `typoSource`) that a blacklist of only the identity/createdAt fields
 * would silently let through untouched.
 */
const allowedUpdateFields = new Set<string>(['open', 'high', 'low', 'close', 'volume', 'openInterest', 'source', 'updatedAt']);

/**
 * Defense in depth: `HistoricalCandleUpdateValues` already excludes
 * identity/createdAt fields (and any other unknown key) at compile time,
 * but a caller can still reach this method with an `as any`/cast carrying
 * one (most importantly `createdAt` or a plain typo, neither of which may
 * ever be silently ignored). Every key actually present on `update` --
 * checked via `Object.keys`, so an explicit `{ field: undefined }` still
 * counts as "present" for this check even though it behaves as omitted
 * for the SQL SET clause built later -- must be in the allowed set, or
 * this throws. Called before any transaction/SQL is issued so invalid
 * caller input never produces DB work.
 */
function assertOnlyAllowedUpdateFields(update: Record<string, unknown>): void {
  for (const key of Object.keys(update)) {
    if (!allowedUpdateFields.has(key)) {
      throw new Error(
        `HistoricalCandleRepository atomic upsert does not support the update field '${key}'. Allowed update fields are: ${[...allowedUpdateFields].sort().join(', ')}.`
      );
    }
  }
}

function assertPlainDate(field: string, value: unknown): Date {
  if (!(value instanceof Date)) {
    throw new Error(`HistoricalCandleRepository atomic upsert only supports a plain Date for '${field}'; received ${typeof value}.`);
  }
  if (Number.isNaN(value.getTime())) {
    throw new Error(`HistoricalCandleRepository atomic upsert received an invalid date for '${field}'.`);
  }
  return value;
}

function assertOptionalPlainDate(field: string, value: unknown): Date | undefined {
  return value === undefined ? undefined : assertPlainDate(field, value);
}

function assertPlainString(field: string, value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`HistoricalCandleRepository atomic upsert only supports a plain string for '${field}'; received ${typeof value}.`);
  }
  return value;
}

/**
 * The exact structural shape the installed Prisma 5.22.0 runtime declares
 * for `DecimalJsLike` -- verified directly against
 * `node_modules/@prisma/client/runtime/library.d.ts`:
 *   export declare interface DecimalJsLike { d: number[]; e: number; s: number; toFixed(): string; }
 * An object satisfying only `toFixed()` (e.g. `{ toFixed: () => '123.456' }`)
 * is NOT a genuine DecimalJsLike value under this contract and must be
 * rejected here, before its `toFixed()` is ever invoked -- `d`/`e`/`s` are
 * decimal.js's own internal digit/exponent/sign representation, and while
 * this check does not re-validate their internal numeric encoding (the
 * second-stage `constructCanonicalDecimal` below is what actually proves
 * the resulting string is a valid decimal), requiring all four members to
 * be present with the declared primitive types closes the gap where any
 * arbitrary object exposing just a callable `toFixed()` could masquerade
 * as this structural type.
 */
function isDecimalJsLikeShape(value: unknown): value is Prisma.DecimalJsLike {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.d) &&
    candidate.d.every((digit) => typeof digit === 'number') &&
    typeof candidate.e === 'number' &&
    typeof candidate.s === 'number' &&
    typeof candidate.toFixed === 'function'
  );
}

/**
 * Extracts a construction candidate for `Prisma.Decimal` from a value that
 * is either already a primitive decimal representation (`number`/`string`),
 * an actual `Prisma.Decimal` instance, or a genuine `DecimalJsLike`
 * structural value (see `isDecimalJsLikeShape`). A `DecimalJsLike` object's
 * own `toFixed()` is never trusted directly as the final bound value -- it
 * is used only, after the structural check above passes, to obtain a
 * candidate STRING, which `constructCanonicalDecimal` below then
 * independently re-validates by feeding it back through the real
 * `Prisma.Decimal` constructor, exactly as it would validate any other
 * caller-supplied string. An object whose `toFixed()` returns garbage
 * (e.g. non-decimal text) is therefore rejected at construction, not
 * blindly bound into SQL.
 */
function extractDecimalCandidate(field: string, value: unknown): number | string | Prisma.Decimal {
  if (typeof value === 'number' || typeof value === 'string' || value instanceof Prisma.Decimal) {
    return value;
  }
  if (isDecimalJsLikeShape(value)) {
    const candidate = value.toFixed();
    if (typeof candidate !== 'string') {
      throw new Error(`HistoricalCandleRepository atomic upsert received a Decimal-like value for '${field}' whose toFixed() did not return a string.`);
    }
    return candidate;
  }
  throw new Error(
    `HistoricalCandleRepository atomic upsert only supports a plain number/string or a Decimal-compatible value for '${field}'; received ${typeof value}.`
  );
}

/**
 * Canonicalizes a decimal construction candidate through the actual
 * `Prisma.Decimal` (decimal.js) implementation from the installed Prisma
 * 5.22.0 runtime -- the same library Prisma itself uses to represent
 * DECIMAL columns -- rather than trusting the caller's own string/object
 * formatting. `new Prisma.Decimal(...)` throws for a malformed/non-decimal
 * value (e.g. `'not-a-number'`, `{}`, `null`); decimal.js's constructor
 * itself accepts `NaN`/`Infinity`/`-Infinity` without throwing (both as
 * numbers and as the strings `'NaN'`/`'Infinity'`), so those are rejected
 * separately via `isFinite()` -- neither is a value MySQL's DECIMAL column
 * type, or this repository's contract, can represent.
 */
function constructCanonicalDecimal(field: string, candidate: number | string | Prisma.Decimal): Prisma.Decimal {
  let decimal: Prisma.Decimal;
  try {
    decimal = new Prisma.Decimal(candidate);
  } catch {
    throw new Error(`HistoricalCandleRepository atomic upsert received a value for '${field}' that Prisma.Decimal cannot represent (malformed decimal input).`);
  }
  if (!decimal.isFinite()) {
    throw new Error(`HistoricalCandleRepository atomic upsert received a non-finite value for '${field}' (NaN/Infinity are not valid decimal quantities).`);
  }
  return decimal;
}

/**
 * Accepts a plain number/string or any Decimal-compatible value and
 * returns the canonical decimal instance's own exact string
 * representation via `toFixed()` -- decimal.js's lossless stringification
 * of ITS OWN validated/canonicalized instance, never the caller's raw
 * object, and never routed through JS `Number`, so a high-precision value
 * keeps every digit when bound as the raw SQL parameter. A plain `number`
 * carries no more precision than a JS double already has, so canonicalizing
 * it introduces no loss beyond what the caller's own `number` already has.
 * Prisma's scalar-update-operator objects (`{ increment }`, `{ multiply }`,
 * ...) have no `toFixed` method and are correctly rejected in
 * `extractDecimalCandidate`.
 */
function assertPlainDecimal(field: string, value: unknown): string {
  const candidate = extractDecimalCandidate(field, value);
  const decimal = constructCanonicalDecimal(field, candidate);
  return decimal.toFixed();
}

function assertPlainBigInt(field: string, value: unknown): bigint | number {
  if (typeof value !== 'bigint' && typeof value !== 'number') {
    throw new Error(`HistoricalCandleRepository atomic upsert only supports a plain bigint/number for '${field}'; received ${typeof value}.`);
  }
  return value;
}

function assertPlainNullableBigInt(field: string, value: unknown): bigint | number | null {
  if (value !== null && typeof value !== 'bigint' && typeof value !== 'number') {
    throw new Error(`HistoricalCandleRepository atomic upsert only supports a plain bigint/number/null for '${field}'; received ${typeof value}.`);
  }
  return value;
}

/**
 * `HistoricalCandleSyncLog.errorMessage` is `VARCHAR(191)` (see
 * prisma/migrations/20260805102657_add_historical_candle_models/
 * migration.sql:38). This database runs with STRICT_TRANS_TABLES
 * (confirmed against the local MySQL server in
 * historical-candle.repository.test.ts's "genuinely unrelated database
 * error" test), so MySQL REJECTS an over-length value at write time
 * (error 1406, surfaced by Prisma as P2000) rather than silently
 * truncating it -- a longer-than-191-character error message therefore
 * makes the write that was supposed to record the failure itself fail,
 * leaving the sync log row stuck at whatever status it already had
 * (RUNNING, if this happens on the FAILED transition) instead of durably
 * recording FAILED.
 */
export const HISTORICAL_CANDLE_SYNC_LOG_ERROR_MESSAGE_MAX_LENGTH = 191;

/**
 * Truncates a too-long `errorMessage` down to the real column capacity,
 * keeping as much of the original diagnostic content as fits and adding a
 * single trailing "…" (counted within the 191-character budget) only when
 * truncation actually happens, so a reader can tell content was cut
 * rather than mistaking a message that stops mid-sentence for a complete
 * one. Never splits a UTF-16 surrogate pair. Only a plain `string` value
 * is normalized -- `null`/`undefined` pass through unchanged, and so does
 * any other shape (e.g. a Prisma scalar-update-operator object): no
 * caller in this codebase has ever needed the latter, and guessing at
 * truncation semantics for a shape this repository has never seen is out
 * of scope for this fix.
 */
export function normalizeSyncLogErrorMessage<T extends { errorMessage?: unknown }>(data: T): T {
  if (typeof data.errorMessage !== 'string') return data;
  const message = data.errorMessage;
  if (message.length <= HISTORICAL_CANDLE_SYNC_LOG_ERROR_MESSAGE_MAX_LENGTH) return data;

  let head = message.slice(0, HISTORICAL_CANDLE_SYNC_LOG_ERROR_MESSAGE_MAX_LENGTH - 1);
  const lastCode = head.charCodeAt(head.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) head = head.slice(0, -1); // never split a surrogate pair

  return { ...data, errorMessage: `${head}…` };
}

export default class HistoricalCandleRepository {
  /**
   * Defaults to the shared, module-level Prisma client -- every existing
   * caller (`new HistoricalCandleRepository()`, no arguments) gets exactly
   * the same behavior and connection as before. The optional override exists
   * only so regression tests can point a repository instance at an isolated
   * throwaway MySQL database instead of the real, configured one.
   */
  constructor(private readonly prisma: PrismaClient = defaultPrismaClient) {}

  async create(data: Prisma.HistoricalCandleCreateInput): Promise<HistoricalCandle> {
    return this.execute('create', () => this.prisma.historicalCandle.create({ data }));
  }

  async update(id: string, data: Prisma.HistoricalCandleUpdateInput): Promise<HistoricalCandle> {
    return this.execute('update', () =>
      this.prisma.historicalCandle.update({
        where: { id },
        data,
      })
    );
  }

  async upsert(input: HistoricalCandleUpsertInput): Promise<HistoricalCandle> {
    return this.execute('upsert', () => {
      // Validated before the transaction opens (before any BEGIN is even
      // sent) so invalid caller input never produces DB work.
      assertOnlyAllowedUpdateFields(input.update as unknown as Record<string, unknown>);
      return this.prisma.$transaction((tx) => this.atomicUpsert(tx, input));
    });
  }

  async bulkCreate(data: Prisma.HistoricalCandleCreateManyInput[]): Promise<Prisma.BatchPayload> {
    return this.execute('bulk create', () => this.prisma.historicalCandle.createMany({ data }));
  }

  async bulkUpsert(inputs: HistoricalCandleUpsertInput[]): Promise<HistoricalCandle[]> {
    return this.execute('bulk upsert', () => {
      // Every input's update-field keys are validated before the
      // transaction opens, so a single invalid entry anywhere in the batch
      // never produces any DB work for the whole call.
      for (const input of inputs) {
        assertOnlyAllowedUpdateFields(input.update as unknown as Record<string, unknown>);
      }
      return this.prisma.$transaction(
        async (tx) => {
          const results: HistoricalCandle[] = [];
          for (const input of inputs) {
            results.push(await this.atomicUpsert(tx, input));
          }
          return results;
        },
        // A full trading day is ~375 one-minute candles; give the batch
        // transaction room beyond Prisma's 5s default so a large recovery
        // backfill does not spuriously time out mid-batch.
        { timeout: 30_000 }
      );
    });
  }

  async findLatest(instrumentKey: string, timeframe: string): Promise<HistoricalCandle | null> {
    return this.execute('find latest', () =>
      this.prisma.historicalCandle.findFirst({
        where: { instrumentKey, timeframe },
        orderBy: { candleTime: 'desc' },
      })
    );
  }

  async findRange(
    instrumentKey: string,
    timeframe: string,
    startTime: Date,
    endTime: Date
  ): Promise<HistoricalCandle[]> {
    return this.execute('find range', () =>
      this.prisma.historicalCandle.findMany({
        where: {
          instrumentKey,
          timeframe,
          candleTime: {
            gte: startTime,
            lte: endTime,
          },
        },
        orderBy: { candleTime: 'asc' },
      })
    );
  }

  async findByInstrument(instrumentKey: string): Promise<HistoricalCandle[]> {
    return this.execute('find by instrument', () =>
      this.prisma.historicalCandle.findMany({
        where: { instrumentKey },
        orderBy: { candleTime: 'asc' },
      })
    );
  }

  async findByInstrumentAndTimeframe(
    instrumentKey: string,
    timeframe: string
  ): Promise<HistoricalCandle[]> {
    return this.execute('find by instrument and timeframe', () =>
      this.prisma.historicalCandle.findMany({
        where: { instrumentKey, timeframe },
        orderBy: { candleTime: 'asc' },
      })
    );
  }

  async count(where?: Prisma.HistoricalCandleWhereInput): Promise<number> {
    return this.execute('count', () => this.prisma.historicalCandle.count({ where }));
  }

  async deleteOlderThan(
    candleTime: Date,
    where?: Prisma.HistoricalCandleWhereInput
  ): Promise<Prisma.BatchPayload> {
    return this.execute('delete older than', () =>
      this.prisma.historicalCandle.deleteMany({
        where: {
          ...where,
          candleTime: {
            lt: candleTime,
          },
        },
      })
    );
  }

  async createSyncLog(
    data: Prisma.HistoricalCandleSyncLogCreateInput
  ): Promise<HistoricalCandleSyncLog> {
    return this.execute('create sync log', () =>
      this.prisma.historicalCandleSyncLog.create({ data: normalizeSyncLogErrorMessage(data) })
    );
  }

  async updateSyncLog(
    id: string,
    data: Prisma.HistoricalCandleSyncLogUpdateInput
  ): Promise<HistoricalCandleSyncLog> {
    return this.execute('update sync log', () =>
      this.prisma.historicalCandleSyncLog.update({
        where: { id },
        data: normalizeSyncLogErrorMessage(data),
      })
    );
  }

  /**
   * Writes one row using a single atomic MySQL `INSERT ... ON DUPLICATE KEY
   * UPDATE` statement instead of Prisma's `upsert()`, which compiles (verified
   * against the installed Prisma 5.22.0 engine via query-log capture) to a
   * non-atomic `SELECT` existence check followed by a separate `INSERT` or
   * `UPDATE`. That gap is exactly what let V2 and V4 -- independent OS
   * processes, each with its own Prisma connection -- both see "no row" for
   * the same NIFTY 1-minute key and both attempt `INSERT`, with the loser
   * surfacing P2002.
   *
   * `INSERT ... ON DUPLICATE KEY UPDATE` is a single statement: MySQL takes
   * the unique index's own row lock for its full duration, so two concurrent
   * writers for the same key always serialize -- one inserts, the other then
   * sees the row and updates it -- and neither can observe "not found" for a
   * key the other has already committed. This is race-safe across any number
   * of separate processes/connections, not just within one Node process.
   *
   * The Prisma model type has no atomic-write result shape on MySQL, so the
   * row is re-read by its unique key inside the *same* transaction as the
   * write to preserve the repository's existing `Promise<HistoricalCandle>`
   * contract. Because it is the same transaction, this read is guaranteed to
   * see this write. It is not, however, guaranteed to still equal it by the
   * time the caller inspects the return value: a third writer could commit a
   * newer write for the same key immediately after this transaction commits
   * and before the caller reads the resolved value. That is an accepted,
   * pre-existing property (Prisma's own `upsert()` had the same read-after-
   * write staleness window against later, independent writes) and neither
   * current caller (`LivePaperFreshWarmupService`, `HistoricalCandleSyncService`)
   * uses the returned row for anything beyond optional diagnostics. What is
   * guaranteed unconditionally is that the row is always a complete,
   * atomically committed row -- MySQL/InnoDB never exposes a partially
   * written row.
   */
  private async atomicUpsert(
    tx: Prisma.TransactionClient,
    input: HistoricalCandleUpsertInput
  ): Promise<HistoricalCandle> {
    // Update-field key validation already happened in upsert()/bulkUpsert()
    // before this transaction was opened (see assertOnlyAllowedUpdateFields).
    const instrumentKey = assertPlainString('create.instrumentKey', input.create.instrumentKey);
    const timeframe = assertPlainString('create.timeframe', input.create.timeframe);
    const candleTime = assertPlainDate('create.candleTime', input.create.candleTime);

    const id = randomUUID();
    const now = new Date();
    // `createdAt` is intentionally NOT defaulted to the application's clock:
    // when omitted, the raw SQL below inserts the literal `DEFAULT` keyword
    // for this column so MySQL's own `DEFAULT CURRENT_TIMESTAMP(3)` (the
    // same schema default the prior Prisma-managed inserts relied on)
    // populates it from the database server's clock, not Node's. It is
    // never included in the ON DUPLICATE KEY UPDATE SET clause, so an
    // existing row's original createdAt is always preserved.
    const explicitCreatedAt = assertOptionalPlainDate('create.createdAt', input.create.createdAt);
    const insertUpdatedAt = assertOptionalPlainDate('create.updatedAt', input.create.updatedAt) ?? now;
    const updateUpdatedAt = assertOptionalPlainDate('update.updatedAt', input.update.updatedAt) ?? now;

    const open = assertPlainDecimal('create.open', input.create.open);
    const high = assertPlainDecimal('create.high', input.create.high);
    const low = assertPlainDecimal('create.low', input.create.low);
    const close = assertPlainDecimal('create.close', input.create.close);
    const volume = assertPlainBigInt('create.volume', input.create.volume);
    const openInterest = input.create.openInterest === undefined
      ? null
      : assertPlainNullableBigInt('create.openInterest', input.create.openInterest);
    const source = assertPlainString('create.source', input.create.source);

    // Prisma parity: a field omitted from `update` (or explicitly `undefined`,
    // which Prisma treats the same as omitted) must leave the existing column
    // untouched on the UPDATE branch -- it must NOT be reset to the create-side
    // value. Each assignment is therefore only added to the SET clause when the
    // caller actually supplied that field in `update`.
    const setFragments: Prisma.Sql[] = [];
    if (input.update.open !== undefined) setFragments.push(Prisma.sql`\`open\` = ${assertPlainDecimal('update.open', input.update.open)}`);
    if (input.update.high !== undefined) setFragments.push(Prisma.sql`\`high\` = ${assertPlainDecimal('update.high', input.update.high)}`);
    if (input.update.low !== undefined) setFragments.push(Prisma.sql`\`low\` = ${assertPlainDecimal('update.low', input.update.low)}`);
    if (input.update.close !== undefined) setFragments.push(Prisma.sql`\`close\` = ${assertPlainDecimal('update.close', input.update.close)}`);
    if (input.update.volume !== undefined) setFragments.push(Prisma.sql`\`volume\` = ${assertPlainBigInt('update.volume', input.update.volume)}`);
    if (input.update.openInterest !== undefined) setFragments.push(Prisma.sql`\`openInterest\` = ${assertPlainNullableBigInt('update.openInterest', input.update.openInterest)}`);
    if (input.update.source !== undefined) setFragments.push(Prisma.sql`\`source\` = ${assertPlainString('update.source', input.update.source)}`);
    setFragments.push(Prisma.sql`\`updatedAt\` = ${updateUpdatedAt}`);

    // `DEFAULT` here is a fixed, compile-time-constant SQL keyword literal
    // (never derived from caller input) requesting MySQL's own column
    // default for this one VALUES() slot when the caller did not supply an
    // explicit createdAt -- this keeps the statement's column list and
    // overall shape fixed/static, with only this single value conditionally
    // parameterized vs. defaulted, rather than restructuring the query.
    const createdAtValue = explicitCreatedAt !== undefined ? Prisma.sql`${explicitCreatedAt}` : Prisma.raw('DEFAULT');

    // Parameterized via Prisma's tagged-template raw SQL: every value above is
    // passed through `${...}` interpolation, which Prisma binds as a query
    // parameter (never concatenated or manually escaped into the SQL text).
    // The only non-parameterized fragments are backtick-quoted column names
    // and the `DEFAULT` keyword, all fixed string literals in this file,
    // never caller-supplied.
    //
    // affected-rows from this statement is intentionally not inspected: MySQL
    // returns 1 for an insert, 2 for a changed update, or 0 for a no-op
    // update (unless CLIENT_FOUND_ROWS changes that), so it cannot reliably
    // distinguish insert vs. update vs. no-op, nor identify which row was
    // affected. The follow-up SELECT below is the sole source of truth for
    // the returned row.
    await tx.$executeRaw`
      INSERT INTO \`HistoricalCandle\`
        (\`id\`, \`instrumentKey\`, \`timeframe\`, \`candleTime\`, \`open\`, \`high\`, \`low\`, \`close\`, \`volume\`, \`openInterest\`, \`source\`, \`createdAt\`, \`updatedAt\`)
      VALUES
        (${id}, ${instrumentKey}, ${timeframe}, ${candleTime}, ${open}, ${high}, ${low}, ${close}, ${volume}, ${openInterest}, ${source}, ${createdAtValue}, ${insertUpdatedAt})
      ON DUPLICATE KEY UPDATE
        ${Prisma.join(setFragments, ', ')}
    `;

    return tx.historicalCandle.findUniqueOrThrow({
      where: {
        instrumentKey_timeframe_candleTime: { instrumentKey, timeframe, candleTime },
      },
    });
  }

  private async execute<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        logger.error('Historical candle repository Prisma request failed', {
          operation,
          code: error.code,
          meta: error.meta,
          message: error.message,
        });
      } else if (error instanceof Prisma.PrismaClientValidationError) {
        logger.error('Historical candle repository Prisma validation failed', {
          operation,
          message: error.message,
        });
      } else {
        logger.error('Historical candle repository operation failed', { operation, error });
      }

      throw error;
    }
  }
}
