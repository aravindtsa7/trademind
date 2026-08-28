import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMinuteOfDayIst, isWeekend, validateSessionWindow, validateSessionWindows } from './exchange-calendar.types';

test('formatMinuteOfDayIst renders HH:mm and rejects out-of-range minutes', () => {
  assert.equal(formatMinuteOfDayIst(555), '09:15');
  assert.equal(formatMinuteOfDayIst(0), '00:00');
  assert.equal(formatMinuteOfDayIst(1440), '24:00');
  assert.throws(() => formatMinuteOfDayIst(-1));
  assert.throws(() => formatMinuteOfDayIst(1441));
});

test('validateSessionWindow rejects invalid minute boundaries (N)', () => {
  assert.throws(() => validateSessionWindow({ windowIndex: 0, openMinuteIst: -1, closeMinuteIst: 600 }));
  assert.throws(() => validateSessionWindow({ windowIndex: 0, openMinuteIst: 1440, closeMinuteIst: 1441 }));
  assert.throws(() => validateSessionWindow({ windowIndex: 0, openMinuteIst: 600, closeMinuteIst: 0 }));
  assert.throws(() => validateSessionWindow({ windowIndex: 0, openMinuteIst: 600, closeMinuteIst: 1441 }));
  assert.throws(() => validateSessionWindow({ windowIndex: 0, openMinuteIst: 600, closeMinuteIst: 600 }));
  assert.doesNotThrow(() => validateSessionWindow({ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 780 }));
});

test('validateSessionWindows rejects duplicate windowIndex', () => {
  assert.throws(
    () =>
      validateSessionWindows([
        { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
        { windowIndex: 0, openMinuteIst: 700, closeMinuteIst: 750 },
      ]),
    /Duplicate windowIndex/
  );
});

test('validateSessionWindows rejects overlapping windows (M)', () => {
  assert.throws(
    () =>
      validateSessionWindows([
        { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 700 },
        { windowIndex: 1, openMinuteIst: 650, closeMinuteIst: 750 },
      ]),
    /overlap/
  );
});

test('validateSessionWindows accepts adjacent (touching) windows -- closeMinuteIst is exclusive', () => {
  const sorted = validateSessionWindows([
    { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
    { windowIndex: 1, openMinuteIst: 600, closeMinuteIst: 650 },
  ]);
  assert.equal(sorted.length, 2);
  assert.equal(sorted[0].windowIndex, 0);
});

test('session-window boundary edges [0,1) and [1439,1440) are valid', () => {
  assert.doesNotThrow(() =>
    validateSessionWindows([
      { windowIndex: 0, openMinuteIst: 0, closeMinuteIst: 1 },
      { windowIndex: 1, openMinuteIst: 1439, closeMinuteIst: 1440 },
    ])
  );
});

test('identical timestamps under different indexes are rejected as overlap', () => {
  assert.throws(() =>
    validateSessionWindows([
      { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
      { windowIndex: 1, openMinuteIst: 555, closeMinuteIst: 600 },
    ])
  );
});

test('validateSessionWindows returns windows sorted ascending by windowIndex regardless of input order', () => {
  const sorted = validateSessionWindows([
    { windowIndex: 1, openMinuteIst: 700, closeMinuteIst: 750 },
    { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
  ]);
  assert.deepEqual(
    sorted.map((w) => w.windowIndex),
    [0, 1]
  );
});

test('validateSessionWindows rejects windowIndex order that disagrees with chronological order (deterministic order invariant)', () => {
  assert.throws(() =>
    validateSessionWindows([
      { windowIndex: 0, openMinuteIst: 700, closeMinuteIst: 750 },
      { windowIndex: 1, openMinuteIst: 555, closeMinuteIst: 600 },
    ])
  );
});

test('isWeekend classifies Saturday/Sunday correctly and is deterministic regardless of host timezone', () => {
  assert.equal(isWeekend('2031-01-04'), true); // Saturday
  assert.equal(isWeekend('2031-01-05'), true); // Sunday
  assert.equal(isWeekend('2031-01-06'), false); // Monday
  assert.equal(isWeekend('2031-01-08'), false); // Wednesday
});

test('isWeekend rejects malformed date strings', () => {
  assert.throws(() => isWeekend('2031/01/04'));
  assert.throws(() => isWeekend('not-a-date'));
  assert.throws(() => isWeekend('2031-02-29'));
  assert.throws(() => isWeekend('2031-04-31'));
});
