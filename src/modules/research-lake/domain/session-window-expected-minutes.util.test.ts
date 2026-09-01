import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionWindow } from './exchange-calendar.types';
import { expectedCanonicalTimestamps, expectedMinutesForWindow, expectedMinutesForWindows, regularSessionWindow } from './session-window-expected-minutes.util';

function window(windowIndex: number, openMinuteIst: number, closeMinuteIst: number): SessionWindow {
  return { windowIndex, openMinuteIst, closeMinuteIst };
}

test('(1) [555,930) produces exactly 375 integers, first 555, last 929, 930 absent', () => {
  const minutes = expectedMinutesForWindow(window(0, 555, 930));
  assert.equal(minutes.length, 375);
  assert.equal(minutes[0], 555);
  assert.equal(minutes[minutes.length - 1], 929);
  assert.equal(minutes.includes(930), false);
});

test('(2) a single-minute valid window produces exactly one minute', () => {
  const minutes = expectedMinutesForWindow(window(0, 600, 601));
  assert.deepEqual(minutes, [600]);
});

test('(3) multiple disjoint windows produce the union of both ranges, gap not filled', () => {
  const minutes = expectedMinutesForWindows([window(0, 555, 600), window(1, 690, 750)]);
  assert.equal(minutes.length, 45 + 60);
  assert.equal(minutes.includes(555), true);
  assert.equal(minutes.includes(599), true);
  assert.equal(minutes.includes(600), false); // gap start, excluded
  assert.equal(minutes.includes(689), false); // gap end, excluded
  assert.equal(minutes.includes(690), true);
  assert.equal(minutes.includes(749), true);
});

test('(4) multi-window result is deterministic ascending regardless of input array order', () => {
  const inOrder = expectedMinutesForWindows([window(0, 555, 600), window(1, 690, 750)]);
  const outOfOrder = expectedMinutesForWindows([window(1, 690, 750), window(0, 555, 600)]);
  assert.deepEqual(outOfOrder, inOrder);
  for (let i = 1; i < inOrder.length; i += 1) {
    assert.ok(inOrder[i] > inOrder[i - 1], 'expected strictly ascending minute sequence');
  }
});

test('(5) overlapping windows are rejected fail-closed', () => {
  assert.throws(() => expectedMinutesForWindows([window(0, 555, 700), window(1, 650, 800)]));
});

test('(6) exact duplicate window range is rejected fail-closed, never silently collapsed', () => {
  assert.throws(() => expectedMinutesForWindows([window(0, 555, 930), window(1, 555, 930)]));
});

test('(7) a negative openMinuteIst bypassing the SessionWindow type at runtime is rejected', () => {
  const invalid = { windowIndex: 0, openMinuteIst: -5, closeMinuteIst: 600 } as SessionWindow;
  assert.throws(() => expectedMinutesForWindow(invalid));
});

test('(8) openMinuteIst >= closeMinuteIst is rejected', () => {
  assert.throws(() => expectedMinutesForWindow(window(0, 700, 700)));
  assert.throws(() => expectedMinutesForWindow(window(0, 800, 700)));
});

test('(9) a minute beyond IST-day bounds (closeMinuteIst > 1440) is rejected', () => {
  assert.throws(() => expectedMinutesForWindow(window(0, 1430, 1441)));
});

test('(10) input window objects are not mutated', () => {
  const input = window(0, 555, 930);
  const snapshot = { ...input };
  expectedMinutesForWindow(input);
  assert.deepEqual(input, snapshot);

  const windows = [window(1, 690, 750), window(0, 555, 600)];
  const windowsSnapshot = windows.map((w) => ({ ...w }));
  expectedMinutesForWindows(windows);
  assert.deepEqual(windows, windowsSnapshot);
  assert.equal(windows[0].windowIndex, 1, 'input array order itself must not be mutated');
});

test('adjacent windows (one closeMinuteIst equal to the next openMinuteIst) are allowed, not treated as overlap', () => {
  const minutes = expectedMinutesForWindows([window(0, 555, 600), window(1, 600, 700)]);
  assert.equal(minutes.length, 145);
  assert.equal(minutes.includes(599), true);
  assert.equal(minutes.includes(600), true);
});

test('regularSessionWindow() derives [555,930) from existing session-boundary constants, not a re-hardcoded literal', () => {
  const regular = regularSessionWindow();
  assert.equal(regular.openMinuteIst, 555);
  assert.equal(regular.closeMinuteIst, 930);
  const minutes = expectedMinutesForWindow(regular);
  assert.equal(minutes.length, 375);
});

// ---- expectedCanonicalTimestamps (B-F8 gap-repair target derivation) -----

test('(11) expectedCanonicalTimestamps: regular [555,930) session produces 375 ascending UTC timestamps, first = 09:15 IST, last = 15:29 IST', () => {
  const minutes = expectedMinutesForWindow(regularSessionWindow());
  const timestamps = expectedCanonicalTimestamps('2022-03-07', minutes);
  assert.equal(timestamps.length, 375);
  assert.equal(timestamps[0].toISOString(), '2022-03-07T03:45:00.000Z'); // 09:15 IST = 03:45 UTC
  assert.equal(timestamps[timestamps.length - 1].toISOString(), '2022-03-07T09:59:00.000Z'); // 15:29 IST = 09:59 UTC
  for (let i = 1; i < timestamps.length; i += 1) {
    assert.ok(timestamps[i].getTime() > timestamps[i - 1].getTime(), 'expected strictly ascending timestamps');
    assert.equal(timestamps[i].getTime() - timestamps[i - 1].getTime(), 60_000, 'expected exactly one minute between consecutive canonical timestamps');
  }
});

test('(12) expectedCanonicalTimestamps: 2022-10-24-shaped 60-minute special session ([1095,1155)) produces exactly 60 ascending timestamps', () => {
  const window: SessionWindow = { windowIndex: 0, openMinuteIst: 1095, closeMinuteIst: 1155 };
  const minutes = expectedMinutesForWindow(window);
  const timestamps = expectedCanonicalTimestamps('2022-10-24', minutes);
  assert.equal(timestamps.length, 60);
  assert.equal(timestamps[0].toISOString(), '2022-10-24T12:45:00.000Z'); // minute 1095 = 18:15 IST = 12:45 UTC
  assert.equal(timestamps[timestamps.length - 1].toISOString(), '2022-10-24T13:44:00.000Z'); // minute 1154 = 19:14 IST
});

test('(13) expectedCanonicalTimestamps: a multi-window special session produces the exact per-window timestamps with no bridging timestamp across the gap', () => {
  const windows: SessionWindow[] = [
    { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 600 },
    { windowIndex: 1, openMinuteIst: 690, closeMinuteIst: 750 },
  ];
  const minutes = expectedMinutesForWindows(windows);
  const timestamps = expectedCanonicalTimestamps('2024-01-01', minutes);
  assert.equal(timestamps.length, 45 + 60);
  const isoSet = new Set(timestamps.map((t) => t.toISOString()));
  // Last minute of window 0 (599 = 09:59 IST) and first minute of window 1 (690 = 11:30 IST) are both present...
  assert.equal(isoSet.has('2024-01-01T04:29:00.000Z'), true); // minute 599 = 09:59 IST
  assert.equal(isoSet.has('2024-01-01T06:00:00.000Z'), true); // minute 690 = 11:30 IST
  // ...but every gap-minute timestamp between them (600..689) is absent -- the gap is never bridged.
  for (let minute = 600; minute < 690; minute += 1) {
    const dayStart = new Date('2024-01-01T00:00:00+05:30').getTime();
    const gapTimestamp = new Date(dayStart + minute * 60_000).toISOString();
    assert.equal(isoSet.has(gapTimestamp), false, `gap-minute timestamp for minute ${minute} must never be a bridged canonical timestamp`);
  }
});

test('(14) expectedCanonicalTimestamps: empty minute set produces an empty timestamp array', () => {
  assert.deepEqual(expectedCanonicalTimestamps('2022-03-07', []), []);
});
