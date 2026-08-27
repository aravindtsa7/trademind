import { decodeParquetBufferToManifestCandles } from '../domain/canonical-candle-parquet-codec';
import { readFileBuffer } from '../domain/atomic-file-writer';
import { sha256HexOfBuffer } from '../domain/file-checksum';
import { ManifestCandleContent, SessionContentIdentity, computeSessionContentChecksum } from '../domain/dataset-manifest.types';

export interface ReadSessionResult {
  readonly candles: readonly ManifestCandleContent[];
  readonly physicalFileChecksum: string;
  readonly fileSizeBytes: number;
}

export interface VerifySessionAgainstLogicalIdentityRequest {
  readonly parquetFilePath: string;
  readonly identity: SessionContentIdentity;
  readonly canonicalizationVersion: number;
  readonly healthSemanticsVersion: number;
  readonly expectedContentChecksum: string;
  readonly expectedRowCount: number;
  readonly expectedPhysicalFileChecksum: string;
}

export interface VerifySessionAgainstLogicalIdentityResult {
  readonly candles: readonly ManifestCandleContent[];
  readonly physicalFileChecksum: string;
  readonly physicalChecksumMatches: boolean;
  readonly recomputedContentChecksum: string;
  readonly contentChecksumMatches: boolean;
  readonly rowCount: number;
  readonly rowCountMatches: boolean;
}

/**
 * Narrow, provider/library-neutral abstraction over B-F6 Parquet session
 * files (task section 14: "Future replay/backtesting should not need to
 * know the chosen Parquet package's raw API"). Every public method returns
 * `ManifestCandleContent`-shaped rows (the SAME B-F5 content type
 * `computeSessionContentChecksum` hashes) in deterministic ascending
 * `candleTime` order -- callers never see a raw hyparquet row/column or a
 * Prisma-specific type.
 *
 * Deliberately does NOT build a backtest engine, a resampler, or a replay
 * driver (task section 14/26) -- it only reads one session's file and,
 * optionally, proves it against an expected logical identity.
 */
export default class ResearchLakeParquetReaderService {
  /** Reads one session Parquet file and returns its canonical candle rows, ascending, plus the physical file's own SHA-256/size. Throws (fails closed) if the file is missing, unparseable, or has an unsupported schema. */
  async readSession(parquetFilePath: string): Promise<ReadSessionResult> {
    const buffer = readFileBuffer(parquetFilePath);
    const physicalFileChecksum = sha256HexOfBuffer(buffer);
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    const candles = await decodeParquetBufferToManifestCandles(arrayBuffer);
    return { candles, physicalFileChecksum, fileSizeBytes: buffer.byteLength };
  }

  /**
   * Reads one session Parquet file AND proves it against an expected B-F5
   * logical identity/checksum plus expected physical checksum -- the single
   * function `research:parquet:verify` and any future replay/backtest
   * consumer should call rather than re-implementing the physical-then-
   * logical verification sequence (task section 8: "file exists -> physical
   * SHA-256 matches -> Parquet parses -> schema supported -> rows
   * canonicalize -> row count matches -> B-F5 logical session checksum
   * matches"). Never throws on a mismatch -- returns booleans so a caller
   * can report ALL mismatches for a dataset rather than stopping at the
   * first one.
   */
  async readAndVerifySession(request: VerifySessionAgainstLogicalIdentityRequest): Promise<VerifySessionAgainstLogicalIdentityResult> {
    const { candles, physicalFileChecksum } = await this.readSession(request.parquetFilePath);
    const recomputedContentChecksum = computeSessionContentChecksum({
      identity: request.identity,
      canonicalizationVersion: request.canonicalizationVersion,
      healthSemanticsVersion: request.healthSemanticsVersion,
      candles,
    });
    return {
      candles,
      physicalFileChecksum,
      physicalChecksumMatches: physicalFileChecksum === request.expectedPhysicalFileChecksum,
      recomputedContentChecksum,
      contentChecksumMatches: recomputedContentChecksum === request.expectedContentChecksum,
      rowCount: candles.length,
      rowCountMatches: candles.length === request.expectedRowCount,
    };
  }
}
