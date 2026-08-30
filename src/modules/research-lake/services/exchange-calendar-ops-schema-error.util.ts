/**
 * B-F7A-FIXTURES-1 schema-precondition classifier (task section 28).
 * Duck-typed rather than an `instanceof Prisma.PrismaClientKnownRequestError`
 * check, deliberately: it never imports `@prisma/client` at all, so it
 * stays trivially unit-testable against a plain `{code, message}` object
 * (no real Prisma error needs to be constructed in a test) while still
 * matching the real shape Prisma actually throws.
 *
 * Prisma's stable error code for "table does not exist in the current
 * database" is P2021 -- reproduced live against this exact repository's
 * local database during the B-F7A-OPS-PREFLIGHT task (the calendar
 * migration was pending, and every calendar-table query failed with
 * exactly this code/message shape). The message-substring check is
 * defense-in-depth only, in case a future Prisma version ever changes the
 * code for this condition without changing the message.
 *
 * This function NEVER converts a schema-not-deployed error into
 * `UNCERTIFIED` or any other successful-looking result (task section 28)
 * -- it only classifies; the caller decides what to do with that
 * classification.
 */
export function isCalendarSchemaNotDeployedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === 'P2021') return true;
  return typeof candidate.message === 'string' && /does not exist in the current database/i.test(candidate.message);
}

export const CALENDAR_SCHEMA_NOT_DEPLOYED = 'CALENDAR_SCHEMA_NOT_DEPLOYED';
