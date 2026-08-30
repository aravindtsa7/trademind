import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  RawSourceZipEnvelopeError,
  deriveExpectedZipMemberBasename,
  extractZipMember,
  looksLikeZipEnvelope,
} from './raw-source-zip-envelope.util';
import { MAX_RAW_SOURCE_BYTES } from './raw-source-content-validator';

/**
 * Hand-assembled minimal ZIP archives (PKZIP APPNOTE fixed-field offsets),
 * built directly from `Buffer`s here -- NOT produced by `extractZipMember`
 * itself or any zip library -- so this suite proves the real parser against
 * independently-constructed structures, matching this repo's existing
 * "avoid a circular test that proves only the library accepts its own
 * output" convention (see `raw-source-content-validator.test.ts`).
 */

interface ZipMemberSpec {
  readonly name: string;
  readonly content: Buffer;
  readonly compress: boolean;
  readonly encrypted?: boolean;
  readonly corruptCrc?: boolean;
  readonly compressionMethodOverride?: number;
  /** Lies about the declared uncompressed size in BOTH local and central headers, independent of `content.length` -- used to construct declared-size-bound and declared/actual-mismatch tests without needing genuinely huge buffers. */
  readonly declaredUncompressedSizeOverride?: number;
  /** Lies about the declared compressed size (STORE-method inconsistency tests). */
  readonly declaredCompressedSizeOverride?: number;
}

interface BuildZipOptions {
  readonly trailingJunkBytes?: number;
  readonly commentLengthOverride?: number;
  readonly diskFieldsOverride?: { readonly thisDisk?: number; readonly startDisk?: number; readonly recordsOnThisDisk?: number };
  readonly centralDirectorySizeOverride?: number;
}

function buildMinimalZip(members: readonly ZipMemberSpec[], options: BuildZipOptions = {}): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let cursor = 0;

  for (const member of members) {
    const nameBytes = Buffer.from(member.name, 'utf8');
    const uncompressed = member.content;
    const data = member.compress ? deflateRawSync(uncompressed) : uncompressed;
    const method = member.compressionMethodOverride ?? (member.compress ? 8 : 0);
    const actualCrc = crc32(uncompressed) >>> 0;
    const storedCrc = member.corruptCrc ? (actualCrc ^ 0xffffffff) >>> 0 : actualCrc;
    const flag = member.encrypted ? 0x1 : 0x0;
    const declaredCompressedSize = member.declaredCompressedSizeOverride ?? data.length;
    const declaredUncompressedSize = member.declaredUncompressedSizeOverride ?? uncompressed.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(flag, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(storedCrc, 14);
    localHeader.writeUInt32LE(declaredCompressedSize, 18);
    localHeader.writeUInt32LE(declaredUncompressedSize, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    const localHeaderOffset = cursor;
    localChunks.push(localHeader, nameBytes, data);
    cursor += localHeader.length + nameBytes.length + data.length;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(flag, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(storedCrc, 16);
    centralHeader.writeUInt32LE(declaredCompressedSize, 20);
    centralHeader.writeUInt32LE(declaredUncompressedSize, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(localHeaderOffset, 42);
    centralChunks.push(centralHeader, nameBytes);
  }

  const localSection = Buffer.concat(localChunks);
  const centralSection = Buffer.concat(centralChunks);
  const centralDirectoryOffset = localSection.length;
  const disk = options.diskFieldsOverride;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(disk?.thisDisk ?? 0, 4);
  eocd.writeUInt16LE(disk?.startDisk ?? 0, 6);
  eocd.writeUInt16LE(disk?.recordsOnThisDisk ?? members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(options.centralDirectorySizeOverride ?? centralSection.length, 12);
  eocd.writeUInt32LE(centralDirectoryOffset, 16);
  eocd.writeUInt16LE(options.commentLengthOverride ?? 0, 20);

  const trailingJunk = options.trailingJunkBytes ? Buffer.alloc(options.trailingJunkBytes, 0x41) : Buffer.alloc(0);
  return Buffer.concat([localSection, centralSection, eocd, trailingJunk]);
}

test('looksLikeZipEnvelope detects the ZIP local-file-header magic bytes and rejects a plain PDF', () => {
  const zip = buildMinimalZip([{ name: 'CMTR60338.pdf', content: Buffer.from('%PDF-1.4 fake pdf body'), compress: false }]);
  assert.equal(looksLikeZipEnvelope(zip), true);
  assert.equal(looksLikeZipEnvelope(Buffer.from('%PDF-1.4 not a zip at all')), false);
  assert.equal(looksLikeZipEnvelope(Buffer.alloc(0)), false);
});

test('deriveExpectedZipMemberBasename swaps .zip for .pdf on the URL basename', () => {
  assert.equal(deriveExpectedZipMemberBasename('https://nsearchives.nseindia.com/content/circulars/CMTR60338.zip'), 'CMTR60338.pdf');
});

test('deriveExpectedZipMemberBasename rejects a URL that does not end in .zip', () => {
  assert.throws(
    () => deriveExpectedZipMemberBasename('https://nsearchives.nseindia.com/content/circulars/CMTR60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'NOT_A_ZIP_URL'
  );
});

test('extractZipMember extracts a DEFLATE-compressed member and CRC-verifies it', () => {
  const content = Buffer.from('%PDF-1.7 real circular content '.repeat(20));
  const zip = buildMinimalZip([
    { name: 'GazetteNotification.pdf', content: Buffer.from('unrelated annexure bytes'), compress: true },
    { name: 'CMTR57285.pdf', content, compress: true },
  ]);
  const extracted = extractZipMember(zip, 'CMTR57285.pdf');
  assert.deepEqual(extracted, content);
});

test('extractZipMember extracts a STORE (uncompressed) member', () => {
  const content = Buffer.from('%PDF-1.7 stored, not deflated');
  const zip = buildMinimalZip([{ name: 'CMTR60338.pdf', content, compress: false }]);
  assert.deepEqual(extractZipMember(zip, 'CMTR60338.pdf'), content);
});

test('extractZipMember fails closed when the expected member name is absent', () => {
  const zip = buildMinimalZip([{ name: 'SomeOtherFile.pdf', content: Buffer.from('x'), compress: false }]);
  assert.throws(
    () => extractZipMember(zip, 'CMTR60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP_MEMBER_NOT_FOUND'
  );
});

test('extractZipMember fails closed on a duplicate member name', () => {
  const zip = buildMinimalZip([
    { name: 'CMTR60338.pdf', content: Buffer.from('first'), compress: false },
    { name: 'CMTR60338.pdf', content: Buffer.from('second'), compress: false },
  ]);
  assert.throws(
    () => extractZipMember(zip, 'CMTR60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP_MEMBER_AMBIGUOUS'
  );
});

test('extractZipMember fails closed on an encrypted member', () => {
  const zip = buildMinimalZip([{ name: 'CMTR60338.pdf', content: Buffer.from('secret'), compress: false, encrypted: true }]);
  assert.throws(
    () => extractZipMember(zip, 'CMTR60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP_MEMBER_ENCRYPTED'
  );
});

test('extractZipMember fails closed on an unsupported compression method', () => {
  const zip = buildMinimalZip([{ name: 'CMTR60338.pdf', content: Buffer.from('x'), compress: false, compressionMethodOverride: 99 }]);
  assert.throws(
    () => extractZipMember(zip, 'CMTR60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP_MEMBER_UNSUPPORTED_COMPRESSION'
  );
});

test('extractZipMember fails closed when the recorded CRC-32 does not match the actual bytes -- refuses a corrupted/tampered extraction', () => {
  const zip = buildMinimalZip([{ name: 'CMTR60338.pdf', content: Buffer.from('%PDF-1.7 tampered'), compress: false, corruptCrc: true }]);
  assert.throws(
    () => extractZipMember(zip, 'CMTR60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP_MEMBER_CRC_MISMATCH'
  );
});

test('extractZipMember fails closed on bytes with no End Of Central Directory record at all', () => {
  assert.throws(
    () => extractZipMember(Buffer.from('not a zip file whatsoever, just plain bytes padded out'.repeat(3)), 'CMTR60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP_ENVELOPE_MALFORMED'
  );
});

test('extractZipMember fails closed on a ZIP64 archive (totalEntries AND recordsOnThisDisk both at the 0xffff sentinel, matching what a genuine ZIP64 EOCD actually looks like)', () => {
  const zip = buildMinimalZip([{ name: 'CMTR60338.pdf', content: Buffer.from('x'), compress: false }], { diskFieldsOverride: { recordsOnThisDisk: 0xffff } });
  const corrupted = Buffer.from(zip);
  corrupted.writeUInt16LE(0xffff, corrupted.length - 12); // EOCD offset+10 == total-entries field
  assert.throws(
    () => extractZipMember(corrupted, 'CMTR60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP64_NOT_SUPPORTED'
  );
});

test('extractZipMember member-name matching is exact and case-sensitive, not a substring/fuzzy match', () => {
  const zip = buildMinimalZip([{ name: 'CMTR60338.pdf', content: Buffer.from('x'), compress: false }]);
  assert.throws(
    () => extractZipMember(zip, 'cmtr60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP_MEMBER_NOT_FOUND'
  );
});

test('(task section 15) a nested-path member name inside the zip does NOT satisfy the expected flat basename', () => {
  const zip = buildMinimalZip([{ name: 'folder/CMTR57285.pdf', content: Buffer.from('nested'), compress: false }]);
  assert.throws(
    () => extractZipMember(zip, 'CMTR57285.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP_MEMBER_NOT_FOUND'
  );
});

// ============================================================
// Terra Defect B: decompression-bound tests (task section 10-12/30)
// ============================================================

test('(30 declared-size) a member whose DECLARED uncompressed size already exceeds MAX_RAW_SOURCE_BYTES is rejected before any decompression is attempted', () => {
  const zip = buildMinimalZip([
    { name: 'CMTR60338.pdf', content: Buffer.from('tiny real bytes'), compress: true, declaredUncompressedSizeOverride: MAX_RAW_SOURCE_BYTES + 1 },
  ]);
  assert.throws(
    () => extractZipMember(zip, 'CMTR60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP_MEMBER_DECLARED_SIZE_TOO_LARGE'
  );
});

test('(30 actual-output) a member that UNDERSTATES its declared size but genuinely decompresses past MAX_RAW_SOURCE_BYTES is stopped DURING decompression (zlib maxOutputLength), never after a full unbounded inflate', () => {
  // A highly compressible ~27MB payload -- deflates to a tiny stream, but the true decompressed size exceeds the bound.
  const hugeContent = Buffer.alloc(MAX_RAW_SOURCE_BYTES + 2 * 1024 * 1024, 0x42);
  const zip = buildMinimalZip([
    {
      name: 'CMTR60338.pdf',
      content: hugeContent,
      compress: true,
      // Lie: claim a small declared size so the pre-inflate declared-size gate does not itself catch this -- only the bounded inflate call can.
      declaredUncompressedSizeOverride: 1000,
    },
  ]);
  assert.throws(
    () => extractZipMember(zip, 'CMTR60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP_MEMBER_DECOMPRESSED_SIZE_TOO_LARGE'
  );
});

test('(13) STORE method with inconsistent declared compressed/uncompressed sizes is rejected', () => {
  const content = Buffer.from('stored bytes, no compression');
  const zip = buildMinimalZip([{ name: 'CMTR60338.pdf', content, compress: false, declaredUncompressedSizeOverride: content.length + 5 }]);
  assert.throws(
    () => extractZipMember(zip, 'CMTR60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP_MEMBER_SIZE_MISMATCH'
  );
});

test('a DEFLATE member whose actual decompressed length disagrees with its own declared uncompressedSize (but stays under the bound) is rejected as a size mismatch', () => {
  const content = Buffer.from('real content that will actually decompress to its real length'.repeat(5));
  const zip = buildMinimalZip([{ name: 'CMTR60338.pdf', content, compress: true, declaredUncompressedSizeOverride: content.length - 10 }]);
  assert.throws(
    () => extractZipMember(zip, 'CMTR60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP_MEMBER_SIZE_MISMATCH'
  );
});

test('a malformed DEFLATE stream (compressed bytes are not real deflate output) is rejected as ZIP_MEMBER_INFLATE_FAILED, not silently treated as empty/garbage output', () => {
  const zip = buildMinimalZip([{ name: 'CMTR60338.pdf', content: Buffer.from('not actually deflate data at all, just plain text'), compress: false, compressionMethodOverride: 8 }]);
  assert.throws(
    () => extractZipMember(zip, 'CMTR60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP_MEMBER_INFLATE_FAILED'
  );
});

// ============================================================
// Structural hardening (task section 14/31)
// ============================================================

test('(31) EOCD comment length that does not exactly account for the file remaining bytes is rejected -- trailing junk beyond a truncated/short comment', () => {
  const zip = buildMinimalZip([{ name: 'CMTR60338.pdf', content: Buffer.from('x'), compress: false }], { trailingJunkBytes: 10 });
  assert.throws(
    () => extractZipMember(zip, 'CMTR60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP_EOCD_TRAILING_DATA_MISMATCH'
  );
});

test('(31) an EOCD comment length field that overstates the actual remaining bytes (would read past EOF) is rejected', () => {
  const zip = buildMinimalZip([{ name: 'CMTR60338.pdf', content: Buffer.from('x'), compress: false }], { commentLengthOverride: 5000 });
  assert.throws(
    () => extractZipMember(zip, 'CMTR60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP_EOCD_TRAILING_DATA_MISMATCH'
  );
});

test('(31) a declared central-directory size that disagrees with where the EOCD record actually begins is rejected', () => {
  const zip = buildMinimalZip([{ name: 'CMTR60338.pdf', content: Buffer.from('x'), compress: false }], { centralDirectorySizeOverride: 10 });
  assert.throws(
    () => extractZipMember(zip, 'CMTR60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP_CENTRAL_DIRECTORY_SIZE_MISMATCH'
  );
});

test('(31) truncated central directory (fewer real entries than the EOCD declares) is rejected', () => {
  const zip = buildMinimalZip([{ name: 'CMTR60338.pdf', content: Buffer.from('x'), compress: false }]);
  const corrupted = Buffer.from(zip);
  corrupted.writeUInt16LE(2, corrupted.length - 10); // EOCD offset+10: claim 2 entries when only 1 was written
  assert.throws(
    () => extractZipMember(corrupted, 'CMTR60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && (error.code === 'ZIP_ENVELOPE_MALFORMED' || error.code === 'ZIP_CENTRAL_DIRECTORY_SIZE_MISMATCH')
  );
});

test('(31) inconsistent multi-disk EOCD fields (this-disk/start-disk/records-on-this-disk not all consistent with a single-disk archive) are rejected', () => {
  const zip = buildMinimalZip([{ name: 'CMTR60338.pdf', content: Buffer.from('x'), compress: false }], { diskFieldsOverride: { thisDisk: 1 } });
  assert.throws(
    () => extractZipMember(zip, 'CMTR60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP_MULTI_DISK_NOT_SUPPORTED'
  );
});

test('(31) a local-file-header offset pointing past the end of the archive is rejected rather than reading out of bounds', () => {
  const zip = buildMinimalZip([{ name: 'CMTR60338.pdf', content: Buffer.from('x'), compress: false }]);
  const corrupted = Buffer.from(zip);
  // Central directory entry's local-header-offset field is at (fixed 46-byte header) + fileName, at offset 42 within that header.
  // The single entry's central header starts right after the local section.
  const localSectionLength = 30 + 'CMTR60338.pdf'.length + 1; // header + name + 1-byte STORE content
  const centralHeaderOffset = localSectionLength;
  corrupted.writeUInt32LE(999999, centralHeaderOffset + 42);
  assert.throws(
    () => extractZipMember(corrupted, 'CMTR60338.pdf'),
    (error: unknown) => error instanceof RawSourceZipEnvelopeError && error.code === 'ZIP_ENVELOPE_MALFORMED'
  );
});
