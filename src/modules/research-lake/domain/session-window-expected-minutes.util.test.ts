import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionWindow } from './exchange-calendar.types';
import { expectedMinutesForWindow, expectedMinutesForWindows, regularSessionWindow } from './session-window-expected-minutes.util';

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
