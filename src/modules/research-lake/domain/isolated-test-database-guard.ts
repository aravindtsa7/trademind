/**
 * B-F8 CORRECTION (post-Terra-review blocker 3): the SAME "never reuse the
 * shared application database for a throwaway/fixture-driven operation"
 * safety rule already established by the existing B-F2C integration test
 * harnesses (`historical-candle.repository.test.ts`,
 * `historical-candle-research-persistence.service.integration.test.ts`),
 * extracted into one reusable, independently-testable pure function so a
 * CLI script (not just a `node:test` file) can enforce it too --
 * `research-nifty-underlying-gap-repair-fixture-verify.ts` calls this BEFORE
 * connecting to anything. Pure and side-effect-free: no DB connection, no
 * filesystem access -- only string/URL comparison.
 */
export class UnsafeIsolatedTestDatabaseTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeIsolatedTestDatabaseTargetError';
  }
}

const FORBIDDEN_DATABASE_NAMES = new Set(['trademind']);

/**
 * MEDIUM 4 CORRECTION (post-Terra-review): decodes and lower-cases a MySQL
 * connection URL's database-name path segment. `URL#pathname` returns the
 * RAW, still-percent-encoded path (WHATWG URL parsing never auto-decodes
 * percent-escapes in a path segment) -- so, without this, a candidate like
 * `mysql://root:x@localhost:3306/%74rademind` (`%74` decodes to `t`, i.e.
 * literally `trademind`) would sail past a naive `pathname`-only comparison
 * even though MySQL itself resolves it to the real `trademind` database.
 * `decodeURIComponent` can throw on a malformed escape sequence (e.g. a
 * lone `%`) -- treated as a normalization failure, never silently ignored.
 */
function decodedDatabaseName(url: URL): string {
  const rawPath = url.pathname.replace(/^\//, '');
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new UnsafeIsolatedTestDatabaseTargetError('The isolated test database URL has a malformed percent-encoded database-name path segment.');
  }
  return decoded.toLowerCase();
}

/**
 * MEDIUM 4 CORRECTION: a single normalized identity for a MySQL connection
 * TARGET DATABASE -- host (case-insensitive per DNS convention) + explicit
 * port (defaulted to MySQL's standard 3306 when omitted, so `:3306` and no
 * port at all compare equal) + decoded, lower-cased database name.
 * Deliberately excludes credentials and query-string parameters: two URLs
 * that differ only by username/password or by an added query parameter
 * (e.g. `?connection_limit=5`) still point at the exact same physical
 * database and must never be treated as "different" merely because of that
 * -- the safety property this guard exists to enforce is about the TARGET
 * DATABASE identity, never about incidental connection-string decoration.
 */
function normalizedDatabaseTargetKey(url: URL): string {
  const host = url.hostname.toLowerCase();
  const port = url.port || '3306';
  const databaseName = decodedDatabaseName(url);
  return `${host}:${port}/${databaseName}`;
}

function parseUrlOrThrow(candidateUrl: string, label: string): URL {
  try {
    return new URL(candidateUrl);
  } catch {
    throw new UnsafeIsolatedTestDatabaseTargetError(`${label} is not a valid connection URL.`);
  }
}

/**
 * Throws unless `candidateUrl` is genuinely a DIFFERENT, non-production
 * connection target from `applicationDatabaseUrl` (the app's own
 * `DATABASE_URL`). Rejects: an empty/missing candidate, a candidate whose
 * NORMALIZED target (host + port + decoded database name -- see
 * `normalizedDatabaseTargetKey`) matches `applicationDatabaseUrl`'s, and a
 * candidate whose decoded database name is the literal `trademind` (the real
 * application database name) -- regardless of host/port/credentials/query
 * string, so pointing at a DIFFERENT MySQL server that still happens to be
 * named `trademind` is rejected too.
 *
 * Credential differences, query-string differences, and default-vs-explicit
 * port never make two otherwise-identical targets look "different" to this
 * guard (MEDIUM 4: those are exactly the properties an attacker/mistake could
 * vary while still pointing at the real database). This function does NOT
 * attempt DNS-level host-alias resolution (e.g. `localhost` vs `127.0.0.1`
 * vs a machine's real hostname) -- it cannot safely prove two different
 * hostnames resolve to the same server without a network call, and a pure,
 * side-effect-free guard must never perform one; operators must ensure
 * `HISTORICAL_CANDLE_TEST_DATABASE_URL`'s host is not merely a DNS alias for
 * the same server `DATABASE_URL` uses.
 *
 * MEDIUM 4 CORRECTION (ADMIN CONNECTION TARGET vs ACTUAL TEST DATABASE): an
 * EMPTY database-name path segment (e.g. `mysql://root:x@localhost:3306/`)
 * is deliberately ALLOWED here -- it names no database at all (never
 * `trademind`, never equal to any application target that itself names a
 * real database), and is exactly the shape of an admin-capable connection a
 * caller uses only to `CREATE DATABASE`/`DROP DATABASE` a uniquely generated
 * throwaway database, never to write a table row directly. Callers that then
 * derive an actual WRITABLE test-database URL from such an admin URL (e.g.
 * `research-nifty-underlying-gap-repair-fixture-verify.ts`) MUST call this
 * function AGAIN on that derived URL before issuing any table write -- the
 * derived URL's non-empty, uniquely-generated database name is what this
 * function's `trademind`/target-collision checks actually protect.
 */
export function assertSafeIsolatedTestDatabaseUrl(candidateUrl: string | undefined, applicationDatabaseUrl: string | undefined): void {
  if (!candidateUrl) {
    throw new UnsafeIsolatedTestDatabaseTargetError(
      'No isolated test database URL was provided. This operation refuses to fall back to the application DATABASE_URL.'
    );
  }

  const candidate = parseUrlOrThrow(candidateUrl, 'The isolated test database URL');
  const candidateDatabaseName = decodedDatabaseName(candidate);

  if (applicationDatabaseUrl) {
    const application = parseUrlOrThrow(applicationDatabaseUrl, 'The application DATABASE_URL');
    if (normalizedDatabaseTargetKey(candidate) === normalizedDatabaseTargetKey(application)) {
      throw new UnsafeIsolatedTestDatabaseTargetError(
        'The isolated test database URL must not resolve to the same host/port/database as the application DATABASE_URL -- this operation requires a dedicated, disposable connection target. (Credentials and query-string parameters are deliberately ignored when comparing targets.)'
      );
    }
  }

  if (FORBIDDEN_DATABASE_NAMES.has(candidateDatabaseName)) {
    throw new UnsafeIsolatedTestDatabaseTargetError(
      `The isolated test database URL must not point at the '${candidateDatabaseName}' database -- that name is reserved for the real application database, regardless of which server hosts it.`
    );
  }
}
