import assert from 'node:assert/strict';
import test from 'node:test';
import { OptionCapitalSimulationTradeInput } from '../modules/options/dto/option-capital-simulation.dto';
import OptionCapitalSimulatorService from '../modules/options/services/option-capital-simulator.service';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';

const simulator = new OptionCapitalSimulatorService();
const start = new Date('2026-07-15T09:15:00+05:30');

function at(minutes: number): Date {
  return new Date(start.getTime() + minutes * 60_000);
}

function trade(overrides: Partial<OptionCapitalSimulationTradeInput> = {}): OptionCapitalSimulationTradeInput {
  return {
    signalTimestamp: at(0),
    exitTimestamp: at(10),
    signalType: StrategySignal.BUY_CE,
    instrumentKey: 'NSE_FO|example',
    tradingSymbol: 'NIFTY EXAMPLE CE',
    quantity: 65,
    entryPremium: 10,
    exitPremium: 11,
    entryValue: 650,
    totalCharges: 20,
    netPnl: 45,
    ...overrides,
  };
}

test('simulates a single profitable trade', () => {
  const result = simulator.simulate({ initialCapital: 1000, trades: [trade()] });

  assert.equal(result.finalCapital, 1045);
  assert.equal(result.executedTrades, 1);
  assert.equal(result.profitableTrades, 1);
  assert.equal(result.trades[0].capitalLocked, 650);
});

test('simulates a single losing trade and applies net P&L', () => {
  const result = simulator.simulate({ initialCapital: 1000, trades: [trade({ netPnl: -100 })] });

  assert.equal(result.finalCapital, 900);
  assert.equal(result.losingTrades, 1);
  assert.equal(result.totalNetPnl, -100);
});

test('rejects a trade when capital is insufficient', () => {
  const result = simulator.simulate({ initialCapital: 649, trades: [trade()] });

  assert.equal(result.executedTrades, 0);
  assert.equal(result.rejectedTrades, 1);
  assert.equal(result.insufficientCapitalRejectedTrades, 1);
  assert.equal(result.trades[0].rejectionReason, 'INSUFFICIENT_CAPITAL');
});

test('does not allow a known settlement loss to make cash negative', () => {
  const result = simulator.simulate({ initialCapital: 650, trades: [trade({ netPnl: -700 })] });

  assert.equal(result.executedTrades, 0);
  assert.equal(result.finalCapital, 650);
  assert.equal(result.minimumAvailableCash, 650);
});

test('reuses released capital for sequential trades', () => {
  const result = simulator.simulate({
    initialCapital: 650,
    trades: [trade({ netPnl: 20 }), trade({ signalTimestamp: at(10), exitTimestamp: at(20), netPnl: 30 })],
  });

  assert.equal(result.executedTrades, 2);
  assert.equal(result.finalCapital, 700);
  assert.equal(result.trades[1].capitalBefore, 670);
});

test('allows overlapping trades when cash is sufficient', () => {
  const result = simulator.simulate({
    initialCapital: 1400,
    trades: [trade({ entryValue: 650, exitTimestamp: at(20) }), trade({ signalTimestamp: at(5), exitTimestamp: at(10), entryValue: 700 })],
  });

  assert.equal(result.executedTrades, 2);
  assert.equal(result.maximumSimultaneousPositions, 2);
  assert.equal(result.maximumCapitalDeployed, 1350);
});

test('rejects overlapping trades when cash is insufficient', () => {
  const result = simulator.simulate({
    initialCapital: 1000,
    trades: [trade({ entryValue: 650, exitTimestamp: at(20) }), trade({ signalTimestamp: at(5), exitTimestamp: at(10), entryValue: 400 })],
  });

  assert.equal(result.executedTrades, 1);
  assert.equal(result.rejectedTrades, 1);
});

test('releases locked capital at exit', () => {
  const result = simulator.simulate({ initialCapital: 1000, trades: [trade({ netPnl: 0 })] });

  assert.equal(result.trades[0].availableCashAfterEntry, 350);
  assert.equal(result.trades[0].capitalAfterExit, 1000);
  assert.equal(result.minimumAvailableCash, 350);
});

test('calculates maximum capital deployed and time-weighted average deployment', () => {
  const result = simulator.simulate({
    initialCapital: 2000,
    trades: [trade({ entryValue: 500, exitTimestamp: at(20) }), trade({ signalTimestamp: at(10), exitTimestamp: at(30), entryValue: 1000 })],
  });

  assert.equal(result.maximumCapitalDeployed, 1500);
  assert.equal(result.averageCapitalDeployed, 1000);
});

test('calculates drawdown from chronological equity events', () => {
  const result = simulator.simulate({
    initialCapital: 1000,
    trades: [trade({ netPnl: -100 }), trade({ signalTimestamp: at(20), exitTimestamp: at(30), netPnl: 50 })],
  });

  assert.equal(result.peakEquity, 1000);
  assert.equal(result.minimumEquity, 900);
  assert.equal(result.maximumDrawdownAmount, 100);
  assert.equal(result.maximumDrawdownPercent, 10);
});

test('processes unsorted inputs chronologically', () => {
  const later = trade({ instrumentKey: 'later', signalTimestamp: at(20), exitTimestamp: at(30) });
  const earlier = trade({ instrumentKey: 'earlier', signalTimestamp: at(0), exitTimestamp: at(10) });
  const result = simulator.simulate({ initialCapital: 650, trades: [later, earlier] });

  assert.deepEqual(result.trades.map((record) => record.instrumentKey), ['earlier', 'later']);
  assert.ok(result.equityEvents.every((event, index, events) => index === 0 || event.timestamp >= events[index - 1].timestamp));
});

test('does not mutate candidate trades', () => {
  const input = [trade({ entryCharges: 5 })];
  const before = structuredClone(input);

  simulator.simulate({ initialCapital: 1000, trades: input });

  assert.deepEqual(input, before);
});
