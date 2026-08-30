import { crc32, inflateRawSync } from 'node:zlib';
import { MAX_RAW_SOURCE_BYTES } from './raw-source-content-validator';

/**
 * B-F7A-SOURCE-EVIDENCE-1/FIX-1 zip-envelope unwrapping. Some official NSE
 * circulars are published at their approved
 * `nsearchives.nseindia.com/content/circulars/` path as a `.zip` bundle
 * (the circular PDF itself plus government-notification annexures) rather
 * than as a bare PDF -- confirmed live for `NSE/CMTR/57285` and
 * `NSE/CMTR/60338` via NSE's own official circular-search API and by
 * inspecting the actual archive contents, not guessed.
 *
 * This module extracts ONLY the single member whose name is proven to
 * match the reference's own expected basename (the `.zip` URL's basename
 * with `.zip` swapped for `.pdf` -- exactly the sibling of the existing
 * `<DEPT><NUMBER>.pdf` binding rule in `raw-source-manifest-url-binding.ts`)
 * -- never an arbitrary "first entry" or a fuzzy name match, and never a
 * nested path (`folder/CMTR57285.pdf` does NOT satisfy `CMTR57285.pdf`,
 * since ZIP entry-name comparison here is exact-string, not basename-only).
 * The extracted bytes are handed to the SAME `assertValidRawPdfBytes`
 * real-PDF-parse validation and the SAME `sha256HexOfBuffer` hashing every
 * other source document goes through; no archive invariant is weakened,
 * only the envelope this narrow set of documents arrives in is unwrapped
 * first.
 *
 * A minimal, dependency-free, fail-closed ZIP central-directory reader
 * (PKZIP APPNOTE fixed-field offsets) rather than a new npm dependency --
 * this repository already draws the line at "no native bindings, minimal
 * footprint" for `pdf-lib`; a full-featured ZIP library is unnecessary for
 * "extract one exactly-named, non-ZIP64, non-encrypted, size-bounded
 * STORE/DEFLATE member". Every entry is additionally CRC-32 verified
 * (Node's built-in `zlib.crc32`, matching the standard IEEE 802.3
 * algorithm) against the value recorded in the ZIP's own central directory
 * before being trusted -- a parsing bug here fails closed (extraction error
 * or a corrupted result that the downstream PDF parser/CRC check rejects),
 * it can never silently hand back the wrong bytes.
 *
 * TERRA DEFECT B correction (decompression-bomb bound): the declared
 * uncompressed size is checked BEFORE any inflate is attempted, and the
 * actual inflate call itself is bounded via Node's `zlib` `maxOutputLength`
 * option -- output is never allowed to grow past `MAX_RAW_SOURCE_BYTES`
 * regardless of how small the compressed input is. Both bounds reuse the
 * SAME existing raw-document size ceiling `raw-source-content-validator.ts`
 * already enforces on every other response, rather than inventing a second
 * limit.
 *
 * TERRA DEFECT C-adjacent structural hardening: the EOCD's own comment
 * length must exactly explain the file's remaining trailing bytes (no
 * unaccounted trailing junk, no truncation), the declared central-directory
 * offset+size must land exactly at the EOCD's own start (no gap/overlap),
 * the number of entries actually parsed must exactly consume the declared
 * central-directory byte range, and a multi-disk archive is rejected
 * outright (this narrow extractor only ever handles a single-file HTTP
 * response body, never a spanned archive).
 */

export type RawSourceZipEnvelopeErrorCode =
  | 'NOT_A_ZIP_URL'
  | 'ZIP_ENVELOPE_MALFORMED'
  | 'ZIP_EOCD_TRAILING_DATA_MISMATCH'
  | 'ZIP_CENTRAL_DIRECTORY_SIZE_MISMATCH'
  | 'ZIP_MULTI_DISK_NOT_SUPPORTED'
  | 'ZIP64_NOT_SUPPORTED'
  | 'ZIP_MEMBER_NOT_FOUND'
  | 'ZIP_MEMBER_AMBIGUOUS'
  | 'ZIP_MEMBER_ENCRYPTED'
  | 'ZIP_MEMBER_UNSUPPORTED_COMPRESSION'
  | 'ZIP_MEMBER_DECLARED_SIZE_TOO_LARGE'
  | 'ZIP_MEMBER_DECOMPRESSED_SIZE_TOO_LARGE'
  | 'ZIP_MEMBER_SIZE_MISMATCH'
  | 'ZIP_MEMBER_INFLATE_FAILED'
  | 'ZIP_MEMBER_CRC_MISMATCH';

export class RawSourceZipEnvelopeError extends Error {
  constructor(
    public readonly code: RawSourceZipEnvelopeErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'RawSourceZipEnvelopeError';
  }
}

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const EOCD_FIXED_SIZE = 22;
/** ZIP end-of-central-directory comment is at most 16 bits long -- bounds how far back from EOF the EOCD signature can legitimately be. */
const MAX_ZIP_COMMENT_LENGTH = 65535;
/** The classic ZIP32 "this field doesn't fit, see the ZIP64 extra field instead" sentinel -- any occurrence means ZIP64, which this narrow extractor refuses rather than mis-parse. */
const ZIP64_SENTINEL_32 = 0xffffffff;
const ZIP64_SENTINEL_16 = 0xffff;

/** `true` iff `bytes` begins with a ZIP local-file-header signature (task section 4: a response body actually returned as a ZIP, detected by its own magic bytes -- never inferred from the request URL's extension alone). */
export function looksLikeZipEnvelope(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === LOCAL_FILE_HEADER_SIGNATURE;
}

/**
 * `.../CMTR60338.zip` -> `CMTR60338.pdf`: the sibling rule to
 * `deriveExpectedRawSourceUrlBasename` for the zip-envelope case. Only the
 * final path segment is inspected; throws `NOT_A_ZIP_URL` if it does not end
 * in `.zip` (case-sensitive, matching NSE's own consistently-lowercase
 * convention observed for every zip-wrapped circular retrieved so far).
 */
export function deriveExpectedZipMemberBasename(zipUrl: string): string {
  const parsed = new URL(zipUrl);
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  const basename = segments.at(-1) ?? '';
  if (!basename.endsWith('.zip')) {
    throw new RawSourceZipEnvelopeError('NOT_A_ZIP_URL', `'${zipUrl}' does not end in '.zip'; cannot derive an expected inner PDF member name from it.`);
  }
  return `${basename.slice(0, basename.length - '.zip'.length)}.pdf`;
}

interface ZipCentralDirectoryEntry {
  readonly fileName: string;
  readonly generalPurposeFlag: number;
  readonly compressionMethod: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

interface EndOfCentralDirectory {
  readonly eocdOffset: number;
  readonly totalEntries: number;
  readonly centralDirectorySize: number;
  readonly centralDirectoryOffset: number;
}

/**
 * Locates the EOCD record by scanning backward from EOF (the right-most,
 * i.e. LAST, occurrence of the signature is always the real one in a
 * well-formed non-spanned archive -- this function never falls back to an
 * earlier candidate if the right-most one fails validation, which would
 * reopen exactly the kind of EOCD-spoofing/trailing-junk ambiguity task
 * section 14 requires rejecting). Validates that the record's own declared
 * comment length exactly accounts for every remaining byte to EOF (no
 * truncation, no unaccounted trailing junk) and rejects any multi-disk /
 * ZIP64-sentinel EOCD outright.
 */
function findEndOfCentralDirectory(bytes: Buffer): EndOfCentralDirectory {
  const scanFloor = Math.max(0, bytes.length - EOCD_FIXED_SIZE - MAX_ZIP_COMMENT_LENGTH);
  let eocdOffset = -1;
  for (let offset = bytes.length - EOCD_FIXED_SIZE; offset >= scanFloor; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new RawSourceZipEnvelopeError('ZIP_ENVELOPE_MALFORMED', 'No End Of Central Directory record found -- this is not a well-formed ZIP archive.');
  }

  const thisDiskNumber = bytes.readUInt16LE(eocdOffset + 4);
  const centralDirectoryStartDisk = bytes.readUInt16LE(eocdOffset + 6);
  const recordsOnThisDisk = bytes.readUInt16LE(eocdOffset + 8);
  const totalEntries = bytes.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = bytes.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = bytes.readUInt32LE(eocdOffset + 16);
  const commentLength = bytes.readUInt16LE(eocdOffset + 20);

  if (eocdOffset + EOCD_FIXED_SIZE + commentLength !== bytes.length) {
    throw new RawSourceZipEnvelopeError(
      'ZIP_EOCD_TRAILING_DATA_MISMATCH',
      `EOCD declares a comment of ${commentLength} byte(s), which does not exactly account for the archive's remaining ${bytes.length - (eocdOffset + EOCD_FIXED_SIZE)} trailing byte(s) -- rejecting rather than trusting truncated or trailing-junk-appended ZIP bytes.`
    );
  }
  if (thisDiskNumber !== 0 || centralDirectoryStartDisk !== 0 || recordsOnThisDisk !== totalEntries) {
    throw new RawSourceZipEnvelopeError('ZIP_MULTI_DISK_NOT_SUPPORTED', 'This ZIP archive is a multi-disk/spanned archive, which this single-HTTP-response extractor does not support.');
  }
  if (totalEntries === ZIP64_SENTINEL_16 || centralDirectorySize === ZIP64_SENTINEL_32 || centralDirectoryOffset === ZIP64_SENTINEL_32) {
    throw new RawSourceZipEnvelopeError('ZIP64_NOT_SUPPORTED', 'This ZIP archive uses ZIP64 extensions, which this narrow single-member extractor does not support.');
  }
  if (centralDirectoryOffset + centralDirectorySize !== eocdOffset) {
    throw new RawSourceZipEnvelopeError(
      'ZIP_CENTRAL_DIRECTORY_SIZE_MISMATCH',
      `Declared central directory [offset ${centralDirectoryOffset}, size ${centralDirectorySize}] does not end exactly where the EOCD record begins (${eocdOffset}).`
    );
  }

  return { eocdOffset, totalEntries, centralDirectorySize, centralDirectoryOffset };
}

function parseCentralDirectory(bytes: Buffer, eocd: EndOfCentralDirectory): readonly ZipCentralDirectoryEntry[] {
  const entries: ZipCentralDirectoryEntry[] = [];
  let offset = eocd.centralDirectoryOffset;
  for (let index = 0; index < eocd.totalEntries; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new RawSourceZipEnvelopeError('ZIP_ENVELOPE_MALFORMED', `Central directory entry ${index} does not start with the expected signature.`);
    }
    const generalPurposeFlag = bytes.readUInt16LE(offset + 8);
    const compressionMethod = bytes.readUInt16LE(offset + 10);
    const entryCrc32 = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const fileNameLength = bytes.readUInt16LE(offset + 28);
    const extraFieldLength = bytes.readUInt16LE(offset + 30);
    const fileCommentLength = bytes.readUInt16LE(offset + 32);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    const fileNameStart = offset + 46;
    if (fileNameStart + fileNameLength > bytes.length) {
      throw new RawSourceZipEnvelopeError('ZIP_ENVELOPE_MALFORMED', `Central directory entry ${index} file name extends past the end of the archive.`);
    }
    if (compressedSize === ZIP64_SENTINEL_32 || uncompressedSize === ZIP64_SENTINEL_32 || localHeaderOffset === ZIP64_SENTINEL_32) {
      throw new RawSourceZipEnvelopeError('ZIP64_NOT_SUPPORTED', `Central directory entry ${index} uses a ZIP64 sentinel size/offset field, which this narrow extractor does not support.`);
    }
    const fileName = bytes.toString('utf8', fileNameStart, fileNameStart + fileNameLength);

    entries.push({ fileName, generalPurposeFlag, compressionMethod, crc32: entryCrc32, compressedSize, uncompressedSize, localHeaderOffset });
    offset = fileNameStart + fileNameLength + extraFieldLength + fileCommentLength;
  }

  if (offset !== eocd.centralDirectoryOffset + eocd.centralDirectorySize) {
    throw new RawSourceZipEnvelopeError(
      'ZIP_CENTRAL_DIRECTORY_SIZE_MISMATCH',
      `Parsing all ${eocd.totalEntries} declared central directory entries consumed ${offset - eocd.centralDirectoryOffset} byte(s), not the declared ${eocd.centralDirectorySize} byte(s).`
    );
  }
  return entries;
}

/**
 * Extracts and CRC-verifies exactly the member named `expectedMemberName`
 * from `zipBytes` (task section 4/15: proven exact-name binding, never a
 * positional "first entry" guess, never satisfied by a nested path or a
 * case-folded/fuzzy match -- comparison is exact string equality against
 * the ZIP's own central-directory file name). Fails closed on: no/malformed
 * EOCD, trailing junk, multi-disk or ZIP64 extensions, a central-directory
 * size/entry-count mismatch, the member missing, the member name appearing
 * more than once, the member being encrypted (general-purpose bit 0 set),
 * an unsupported compression method (only STORE=0 and DEFLATE=8 are
 * handled -- NSE's archive tool reports "made by v2.0", which predates any
 * ZIP64/AES extension), a declared or actual decompressed size exceeding
 * `MAX_RAW_SOURCE_BYTES` (Terra Defect B -- checked BEFORE and DURING
 * decompression, never only after a full inflate), a STORE/DEFLATE size
 * inconsistency, a malformed DEFLATE stream, or a CRC-32 mismatch after
 * decompression.
 */
function findExactlyOneMatchingEntry(entries: readonly ZipCentralDirectoryEntry[], expectedMemberName: string): ZipCentralDirectoryEntry {
  const matches = entries.filter((entry) => entry.fileName === expectedMemberName);
  if (matches.length === 0) {
    throw new RawSourceZipEnvelopeError(
      'ZIP_MEMBER_NOT_FOUND',
      `No entry named '${expectedMemberName}' found in this ZIP archive. Entries present: [${entries.map((entry) => entry.fileName).join(', ')}].`
    );
  }
  if (matches.length > 1) {
    throw new RawSourceZipEnvelopeError('ZIP_MEMBER_AMBIGUOUS', `Entry name '${expectedMemberName}' appears ${matches.length} times in this ZIP archive's central directory.`);
  }
  return matches[0];
}

/** Rejects encryption, unsupported compression, an over-large declared size (Terra Defect B, checked BEFORE any decompression), and a STORE method whose declared sizes disagree. */
function assertEntrySafeToDecompress(entry: ZipCentralDirectoryEntry, expectedMemberName: string): void {
  if ((entry.generalPurposeFlag & 0x1) !== 0) {
    throw new RawSourceZipEnvelopeError('ZIP_MEMBER_ENCRYPTED', `Entry '${expectedMemberName}' is encrypted (general-purpose bit 0 set); refusing to extract.`);
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new RawSourceZipEnvelopeError(
      'ZIP_MEMBER_UNSUPPORTED_COMPRESSION',
      `Entry '${expectedMemberName}' uses unsupported ZIP compression method ${entry.compressionMethod} (only STORE=0 and DEFLATE=8 are supported).`
    );
  }
  if (entry.uncompressedSize > MAX_RAW_SOURCE_BYTES) {
    throw new RawSourceZipEnvelopeError(
      'ZIP_MEMBER_DECLARED_SIZE_TOO_LARGE',
      `Entry '${expectedMemberName}' declares an uncompressed size of ${entry.uncompressedSize} bytes, exceeding the ${MAX_RAW_SOURCE_BYTES}-byte limit -- refusing to decompress.`
    );
  }
  if (entry.compressionMethod === 0 && entry.compressedSize !== entry.uncompressedSize) {
    throw new RawSourceZipEnvelopeError(
      'ZIP_MEMBER_SIZE_MISMATCH',
      `Entry '${expectedMemberName}' uses STORE (no compression) but declares compressedSize ${entry.compressedSize} != uncompressedSize ${entry.uncompressedSize}.`
    );
  }
}

function readCompressedData(zipBytes: Buffer, entry: ZipCentralDirectoryEntry, expectedMemberName: string): Buffer {
  const localOffset = entry.localHeaderOffset;
  if (localOffset + 30 > zipBytes.length || zipBytes.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    throw new RawSourceZipEnvelopeError('ZIP_ENVELOPE_MALFORMED', `Local file header for '${expectedMemberName}' is missing or malformed.`);
  }
  const localFileNameLength = zipBytes.readUInt16LE(localOffset + 26);
  const localExtraFieldLength = zipBytes.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + localFileNameLength + localExtraFieldLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > zipBytes.length) {
    throw new RawSourceZipEnvelopeError('ZIP_ENVELOPE_MALFORMED', `Entry '${expectedMemberName}' compressed data extends past the end of the archive.`);
  }
  return zipBytes.subarray(dataStart, dataEnd);
}

/**
 * Terra Defect B: bounded at the runtime/API level, not merely checked
 * after the fact -- `maxOutputLength` makes Node itself abort the inflate
 * once output would exceed the bound, so a maliciously crafted high-ratio
 * DEFLATE stream can never allocate more than this regardless of what
 * `uncompressedSize` claimed. `assertEntrySafeToDecompress` already
 * rejected STORE-method size disagreement, so STORE simply copies here.
 */
function decompressEntry(compressedData: Buffer, entry: ZipCentralDirectoryEntry, expectedMemberName: string): Buffer {
  if (entry.compressionMethod === 0) return Buffer.from(compressedData);
  try {
    return inflateRawSync(compressedData, { maxOutputLength: MAX_RAW_SOURCE_BYTES });
  } catch (error) {
    const isOutputTooLarge = (error as NodeJS.ErrnoException | undefined)?.code === 'ERR_BUFFER_TOO_LARGE';
    throw new RawSourceZipEnvelopeError(
      isOutputTooLarge ? 'ZIP_MEMBER_DECOMPRESSED_SIZE_TOO_LARGE' : 'ZIP_MEMBER_INFLATE_FAILED',
      `Entry '${expectedMemberName}' failed to decompress: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function extractZipMember(zipBytes: Buffer, expectedMemberName: string): Buffer {
  const eocd = findEndOfCentralDirectory(zipBytes);
  const entries = parseCentralDirectory(zipBytes, eocd);
  const entry = findExactlyOneMatchingEntry(entries, expectedMemberName);

  assertEntrySafeToDecompress(entry, expectedMemberName);
  const compressedData = readCompressedData(zipBytes, entry, expectedMemberName);
  const extracted = decompressEntry(compressedData, entry, expectedMemberName);

  if (extracted.length !== entry.uncompressedSize) {
    throw new RawSourceZipEnvelopeError(
      'ZIP_MEMBER_SIZE_MISMATCH',
      `Entry '${expectedMemberName}' decompressed to ${extracted.length} byte(s), not the declared uncompressedSize ${entry.uncompressedSize}.`
    );
  }

  const actualCrc32 = crc32(extracted) >>> 0;
  if (actualCrc32 !== entry.crc32) {
    throw new RawSourceZipEnvelopeError(
      'ZIP_MEMBER_CRC_MISMATCH',
      `Extracted bytes for '${expectedMemberName}' do not match the CRC-32 recorded in the ZIP central directory (expected ${entry.crc32.toString(16)}, got ${actualCrc32.toString(16)}) -- refusing to trust a corrupted/tampered extraction.`
    );
  }

  return extracted;
}
