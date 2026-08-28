import assert from 'node:assert/strict';
import test from 'node:test';
import { NormalizedCoverageContent, computeCoverageSourceBundleChecksum } from './exchange-calendar-checksum';

function baseContent(overrides: Partial<NormalizedCoverageContent> = {}): NormalizedCoverageContent {
  return {
    exchange: 'NSE',
    segment: 'EQUITY',
    calendarYear: 2031,
    coverageFrom: '2031-01-01',
    coverageTo: '2031-12-31',
    version: 1,
    sourceAuthority: 'NSE',
    sourceDocuments: [
      { documentReference: 'SYN-DOC-A', documentType: 'ANNUAL_HOLIDAY_CIRCULAR', contentChecksumSha256: 'a'.repeat(64), referenceUrl: null },
      { documentReference: 'SYN-DOC-B', documentType: 'AMENDMENT', contentChecksumSha256: 'b'.repeat(64), referenceUrl: null },
    ],
    days: [
      { tradingDate: '2031-01-01', classification: 'EXCHANGE_HOLIDAY', reason: 'Synthetic holiday', sourceDocumentReference: 'SYN-DOC-A', windows: [] },
      {
        tradingDate: '2031-01-04',
        classification: 'SPECIAL_SESSION',
        reason: 'Synthetic special Saturday session',
        sourceDocumentReference: 'SYN-DOC-B',
        windows: [
          { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
          { windowIndex: 1, openMinuteIst: 660, closeMinuteIst: 720 },
        ],
      },
    ],
    ...overrides,
  };
}

test('(U) source-document input order does not affect the checksum', () => {
  const forward = computeCoverageSourceBundleChecksum(baseContent());
  const reversed = computeCoverageSourceBundleChecksum(baseContent({ sourceDocuments: [...baseContent().sourceDocuments].reverse() }));
  assert.equal(forward, reversed);
});

test('(V) explicit day input order does not affect the checksum', () => {
  const forward = computeCoverageSourceBundleChecksum(baseContent());
  const reversed = computeCoverageSourceBundleChecksum(baseContent({ days: [...baseContent().days].reverse() }));
  assert.equal(forward, reversed);
});

test('(W) session-window input order does not affect the checksum when windowIndex assignments are unchanged', () => {
  const content = baseContent();
  const reorderedWindowsContent = baseContent({
    days: content.days.map((day) => (day.windows.length > 0 ? { ...day, windows: [...day.windows].reverse() } : day)),
  });
  assert.equal(computeCoverageSourceBundleChecksum(content), computeCoverageSourceBundleChecksum(reorderedWindowsContent));
});

test('identical content produces identical checksum', () => {
  assert.equal(computeCoverageSourceBundleChecksum(baseContent()), computeCoverageSourceBundleChecksum(baseContent()));
});

test('a changed explicit date changes the checksum', () => {
  const changed = baseContent({ days: [{ ...baseContent().days[0], tradingDate: '2031-01-02' }, baseContent().days[1]] });
  assert.notEqual(computeCoverageSourceBundleChecksum(baseContent()), computeCoverageSourceBundleChecksum(changed));
});

test('a changed classification changes the checksum', () => {
  const changed = baseContent({ days: [{ ...baseContent().days[0], classification: 'EXCEPTIONAL_CLOSURE' }, baseContent().days[1]] });
  assert.notEqual(computeCoverageSourceBundleChecksum(baseContent()), computeCoverageSourceBundleChecksum(changed));
});

test('a changed window boundary changes the checksum', () => {
  const content = baseContent();
  const changed = baseContent({
    days: [content.days[0], { ...content.days[1], windows: [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 601 }, content.days[1].windows[1]] }],
  });
  assert.notEqual(computeCoverageSourceBundleChecksum(content), computeCoverageSourceBundleChecksum(changed));
});

test('a changed version changes the checksum even for otherwise identical content', () => {
  assert.notEqual(computeCoverageSourceBundleChecksum(baseContent()), computeCoverageSourceBundleChecksum(baseContent({ version: 2 })));
});

test('adding or removing a source document changes the checksum', () => {
  const content = baseContent();
  const fewerDocs = baseContent({ sourceDocuments: [content.sourceDocuments[0]] });
  assert.notEqual(computeCoverageSourceBundleChecksum(content), computeCoverageSourceBundleChecksum(fewerDocs));
});

test('calendarYear is part of the year-scoped semantic identity', () => {
  assert.notEqual(computeCoverageSourceBundleChecksum(baseContent()), computeCoverageSourceBundleChecksum(baseContent({ calendarYear: 2032 })));
});

test('referenceUrl is navigation-only and does not change semantic source identity', () => {
  const content = baseContent();
  const changed = baseContent({
    sourceDocuments: [{ ...content.sourceDocuments[0], referenceUrl: 'https://synthetic.invalid/moved' }, content.sourceDocuments[1]],
  });
  assert.equal(computeCoverageSourceBundleChecksum(content), computeCoverageSourceBundleChecksum(changed));
});

test('source document content checksum changes semantic source identity', () => {
  const content = baseContent();
  const changed = baseContent({
    sourceDocuments: [{ ...content.sourceDocuments[0], contentChecksumSha256: 'c'.repeat(64) }, content.sourceDocuments[1]],
  });
  assert.notEqual(computeCoverageSourceBundleChecksum(content), computeCoverageSourceBundleChecksum(changed));
});

test('human reason prose is observability-only and does not change semantic identity', () => {
  const content = baseContent();
  const changed = baseContent({ days: [{ ...content.days[0], reason: 'Different synthetic prose' }, content.days[1]] });
  assert.equal(computeCoverageSourceBundleChecksum(content), computeCoverageSourceBundleChecksum(changed));
});

test('changing the supporting source-document association changes semantic identity', () => {
  const content = baseContent();
  const changed = baseContent({ days: [{ ...content.days[0], sourceDocumentReference: 'SYN-DOC-B' }, content.days[1]] });
  assert.notEqual(computeCoverageSourceBundleChecksum(content), computeCoverageSourceBundleChecksum(changed));
});
