import assert from 'node:assert/strict';
import test from 'node:test';
import { isCalendarSchemaNotDeployedError } from './exchange-calendar-ops-schema-error.util';

test('a Prisma-shaped P2021 error (table does not exist) is classified as schema-not-deployed', () => {
  const error = { code: 'P2021', message: 'The table `exchangecalendarcoverage` does not exist in the current database.' };
  assert.equal(isCalendarSchemaNotDeployedError(error), true);
});

test('a plain object without a P2021 code but with the message substring is still classified (defense in depth)', () => {
  const error = { message: 'The table `exchangecalendarday` does not exist in the current database.' };
  assert.equal(isCalendarSchemaNotDeployedError(error), true);
});

test('an unrelated Prisma error code is NOT classified as schema-not-deployed', () => {
  const error = { code: 'P2002', message: 'Unique constraint failed.' };
  assert.equal(isCalendarSchemaNotDeployedError(error), false);
});

test('a plain Error with an unrelated message is not classified', () => {
  assert.equal(isCalendarSchemaNotDeployedError(new Error('some other failure')), false);
});

test('non-object/null values never throw and are classified false', () => {
  assert.equal(isCalendarSchemaNotDeployedError(null), false);
  assert.equal(isCalendarSchemaNotDeployedError(undefined), false);
  assert.equal(isCalendarSchemaNotDeployedError('a string error'), false);
  assert.equal(isCalendarSchemaNotDeployedError(42), false);
});

test('never converts a schema-not-deployed error into a false positive success', () => {
  const error = { code: 'P2021', message: 'The table `exchangecalendarcoverage` does not exist in the current database.' };
  // The function only classifies; it must never itself return anything
  // resembling a resolved "UNCERTIFIED" outcome (task section 28) -- this
  // is a boolean classifier only.
  assert.equal(typeof isCalendarSchemaNotDeployedError(error), 'boolean');
});
