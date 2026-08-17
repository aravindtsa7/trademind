import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const runtimes = [
  'src/tests/test-live-paper-trading.ts',
  'src/tests/test-live-v4-nifty-momentum-shadow.ts',
  'src/tests/test-live-v8-nifty-bullish-reclaim-shadow.ts',
  'src/tests/collect-v12-nifty-option-order-flow.ts',
] as const;

test('V2/V4/V8/V12 use the shared wall-clock NSE session coordinator rather than local close constants', () => {
  for (const file of runtimes) {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8');
    assert.match(source, /nse-session-calendar\.service/);
    assert.match(source, /\.schedule\(/);
    assert.doesNotMatch(source, /15\s*\*\s*60\s*\+\s*30|15:30|15_30/);
  }
});
