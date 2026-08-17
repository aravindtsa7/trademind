import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const directCoordinatorRuntimes = [
  'src/tests/test-live-paper-trading.ts',
  'src/tests/collect-v12-nifty-option-order-flow.ts',
] as const;
const hostCoordinatorRuntimes = [
  'src/tests/test-live-v4-nifty-momentum-shadow.ts',
  'src/tests/test-live-v8-nifty-bullish-reclaim-shadow.ts',
] as const;
const localSessionClose = /15\s*\*\s*60\s*\+\s*(?:30|40)|15:30|15:40|15_30|15_40/;

test('V2 and V12 schedule wall-clock EOD through the shared NSE session coordinator', () => {
  for (const file of directCoordinatorRuntimes) {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8');
    assert.match(source, /nse-session-calendar\.service/);
    assert.match(source, /\.schedule\(/);
    assert.doesNotMatch(source, localSessionClose);
  }
});

test('V4 and V8 delegate wall-clock EOD from their runtime to StrategyHostLifecycle', () => {
  for (const file of hostCoordinatorRuntimes) {
    const source = readFileSync(resolve(process.cwd(), file), 'utf8');
    assert.match(source, /nse-session-calendar\.service/);
    assert.match(source, /strategy-host-lifecycle\.service/);
    assert.match(source, /new StrategyHostLifecycle\(/);
    assert.match(source, /eodCoordinator/);
    assert.doesNotMatch(source, /\.schedule\(/);
    assert.doesNotMatch(source, localSessionClose);
  }
});

test('StrategyHostLifecycle centralizes V4/V8 scheduling through NseSessionEodCoordinator', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/modules/market-data/services/strategy-host-lifecycle.service.ts'), 'utf8');
  assert.match(source, /NseSessionEodCoordinator/);
  assert.match(source, /eodCoordinator\?\.schedule\(\(\)\s*=>\s*this\.eod\('WALL_CLOCK_EOD'\)\)/);
});
