import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafeIsolatedTestDatabaseUrl, UnsafeIsolatedTestDatabaseTargetError } from './isolated-test-database-guard';

const APP_URL = 'mysql://root:secret@localhost:3306/trademind';

test('rejects an undefined candidate URL', () => {
  assert.throws(() => assertSafeIsolatedTestDatabaseUrl(undefined, APP_URL), UnsafeIsolatedTestDatabaseTargetError);
});

test('rejects an empty-string candidate URL', () => {
  assert.throws(() => assertSafeIsolatedTestDatabaseUrl('', APP_URL), UnsafeIsolatedTestDatabaseTargetError);
});

test('rejects a candidate identical to the application DATABASE_URL', () => {
  assert.throws(() => assertSafeIsolatedTestDatabaseUrl(APP_URL, APP_URL), UnsafeIsolatedTestDatabaseTargetError);
});

test('rejects a candidate whose database name is literally "trademind", even on a different host', () => {
  assert.throws(() => assertSafeIsolatedTestDatabaseUrl('mysql://root:x@otherhost:3306/trademind', APP_URL), UnsafeIsolatedTestDatabaseTargetError);
});

test('rejects a candidate whose database name is "TradeMind" (case-insensitive match)', () => {
  assert.throws(() => assertSafeIsolatedTestDatabaseUrl('mysql://root:x@localhost:3306/TradeMind', APP_URL), UnsafeIsolatedTestDatabaseTargetError);
});

test('rejects a malformed (non-URL) candidate', () => {
  assert.throws(() => assertSafeIsolatedTestDatabaseUrl('not-a-url', APP_URL), UnsafeIsolatedTestDatabaseTargetError);
});

test('accepts a genuinely distinct, differently-named candidate URL', () => {
  assert.doesNotThrow(() => assertSafeIsolatedTestDatabaseUrl('mysql://root:secret@localhost:3306/research_gap_repair_fixture_verify_abc123', APP_URL));
});

test('accepts a distinct candidate even when applicationDatabaseUrl itself is undefined (defense in depth)', () => {
  assert.doesNotThrow(() => assertSafeIsolatedTestDatabaseUrl('mysql://root:secret@localhost:3306/research_gap_repair_fixture_verify_abc123', undefined));
});

// ============================================================================
// MEDIUM 4 (post-Terra-review correction): stronger, URL-parsed normalization
// ============================================================================

test('MEDIUM-4: rejects a candidate that names the SAME database but with DIFFERENT credentials', () => {
  assert.throws(() => assertSafeIsolatedTestDatabaseUrl('mysql://someoneelse:otherpassword@localhost:3306/trademind', APP_URL), UnsafeIsolatedTestDatabaseTargetError);
});

test('MEDIUM-4: rejects a candidate that names the SAME non-trademind target database as the app, differing only by credentials', () => {
  const appOtherUrl = 'mysql://root:secret@localhost:3306/some_other_app_db';
  assert.throws(() => assertSafeIsolatedTestDatabaseUrl('mysql://different:creds@localhost:3306/some_other_app_db', appOtherUrl), UnsafeIsolatedTestDatabaseTargetError);
});

test('MEDIUM-4: rejects a candidate that names the SAME database as the app but with a DIFFERENT query string', () => {
  assert.throws(() => assertSafeIsolatedTestDatabaseUrl('mysql://root:secret@localhost:3306/trademind?connection_limit=5', APP_URL), UnsafeIsolatedTestDatabaseTargetError);
});

test('MEDIUM-4: rejects a candidate using the DEFAULT MySQL port (omitted) when the app URL uses the EXPLICIT default port -- both resolve to the same target', () => {
  assert.throws(() => assertSafeIsolatedTestDatabaseUrl('mysql://root:secret@localhost/trademind', APP_URL), UnsafeIsolatedTestDatabaseTargetError);
});

test('MEDIUM-4: rejects a candidate whose database name is percent-encoded to decode to "trademind" (e.g. %74rademind)', () => {
  assert.throws(() => assertSafeIsolatedTestDatabaseUrl('mysql://root:x@localhost:3306/%74rademind', APP_URL), UnsafeIsolatedTestDatabaseTargetError);
});

test('MEDIUM-4: rejects a candidate whose database name is a mixed-case percent-encoded variant of "trademind"', () => {
  assert.throws(() => assertSafeIsolatedTestDatabaseUrl('mysql://root:x@localhost:3306/%54rade%4dind', APP_URL), UnsafeIsolatedTestDatabaseTargetError);
});

test('MEDIUM-4: accepts a genuinely DIFFERENT, safely-generated throwaway database name', () => {
  assert.doesNotThrow(() => assertSafeIsolatedTestDatabaseUrl('mysql://root:secret@localhost:3306/research_gap_repair_fixture_verify_d92ac168e8f445e0', APP_URL));
});

test('MEDIUM-4: rejects a malformed percent-encoded database-name path segment', () => {
  assert.throws(() => assertSafeIsolatedTestDatabaseUrl('mysql://root:x@localhost:3306/%', APP_URL), UnsafeIsolatedTestDatabaseTargetError);
});

test('MEDIUM-4: an EMPTY database-name path segment (admin connection target, no specific database selected) is allowed -- it never resolves to "trademind" or to any specific application database', () => {
  assert.doesNotThrow(() => assertSafeIsolatedTestDatabaseUrl('mysql://root:secret@localhost:3306/', APP_URL));
});

test('MEDIUM-4: an EMPTY database-name path segment on the SAME host/port as the app URL is still safe -- the app URL always names a real, non-empty database', () => {
  assert.doesNotThrow(() => assertSafeIsolatedTestDatabaseUrl('mysql://root:secret@localhost:3306/', APP_URL));
});

test('MEDIUM-4: rejects an empty-pathname candidate if the application URL itself ALSO has an empty database-name path segment (both resolve to the same admin target)', () => {
  assert.throws(() => assertSafeIsolatedTestDatabaseUrl('mysql://root:secret@localhost:3306/', 'mysql://root:secret@localhost:3306/'), UnsafeIsolatedTestDatabaseTargetError);
});

test('MEDIUM-4: hostname casing never allows a same-target candidate to appear different', () => {
  assert.throws(() => assertSafeIsolatedTestDatabaseUrl('mysql://root:secret@LOCALHOST:3306/trademind', APP_URL), UnsafeIsolatedTestDatabaseTargetError);
});
