import assert from 'node:assert/strict';
import test from 'node:test';
import { OptionRiskControlTradeInput } from '../modules/options/dto/option-risk-control-simulation.dto';
import OptionRiskControlSimulatorService from '../modules/options/services/option-risk-control-simulator.service';

const simulator = new OptionRiskControlSimulatorService();
const start = new Date('2026-07-15T09:15:00+05:30');

function at(minutes: number): Date { return new Date(start.getTime() + minutes * 60_000); }
function trade(overrides: Partial<OptionRiskControlTradeInput> = {}): OptionRiskControlTradeInput {
  return { signalTimestamp: at(0), exitTimestamp: at(10), netPnl: 100, instrumentKey: 'NSE_FO|example', tradingSymbol: 'NIFTY EXAMPLE CE', ...overrides };
}
function simulate(trades: readonly OptionRiskControlTradeInput[], configuration = {}) { return simulator.simulate({ trades, configuration }); }

test('accepts all trades when no risk limits are configured', () => {
  const result = simulate([trade(), trade({ signalTimestamp: at(20), exitTimestamp: at(30) })]);
  assert.equal(result.totalAccepted, 2);
  assert.equal(result.totalRejected, 0);
});

test('enforces the max daily loss after a realized loss', () => {
  const result = simulate([trade({ netPnl: -100 }), trade({ signalTimestamp: at(11), exitTimestamp: at(20) })], { maxDailyLossAmount: 100 });
  assert.equal(result.rejectedTrades[0].rejectionReason, 'DAILY_LOSS_LIMIT');
  assert.equal(result.dailySummaries[0].dailyLossLimitTriggered, true);
});

test('enforces max trades per IST trading day', () => {
  const result = simulate([trade(), trade({ signalTimestamp: at(1), exitTimestamp: at(11) }), trade({ signalTimestamp: at(2), exitTimestamp: at(12) })], { maxTradesPerDay: 2 });
  assert.equal(result.totalAccepted, 2);
  assert.equal(result.rejectedTrades[0].rejectionReason, 'MAX_TRADES_PER_DAY');
});

test('enforces consecutive-loss limit for the remainder of the day', () => {
  const result = simulate([trade({ netPnl: -10 }), trade({ signalTimestamp: at(11), exitTimestamp: at(20), netPnl: -10 }), trade({ signalTimestamp: at(21), exitTimestamp: at(30) })], { maxConsecutiveLosses: 2 });
  assert.equal(result.rejectedTrades[0].rejectionReason, 'MAX_CONSECUTIVE_LOSSES');
});

test('enforces a cool-off interval after a loss', () => {
  const result = simulate([trade({ netPnl: -10 }), trade({ signalTimestamp: at(20), exitTimestamp: at(25) }), trade({ signalTimestamp: at(30), exitTimestamp: at(35) })], { coolOffMinutesAfterLoss: 20 });
  assert.equal(result.decisions[1].rejectionReason, 'COOL_OFF_AFTER_LOSS');
  assert.equal(result.decisions[2].accepted, true);
});

test('enforces maximum simultaneous positions', () => {
  const result = simulate([trade({ exitTimestamp: at(20) }), trade({ signalTimestamp: at(5), exitTimestamp: at(10) })], { maxSimultaneousPositions: 1 });
  assert.equal(result.rejectedTrades[0].rejectionReason, 'MAX_SIMULTANEOUS_POSITIONS');
});

test('enforces daily profit lock after realized profit', () => {
  const result = simulate([trade({ netPnl: 100 }), trade({ signalTimestamp: at(11), exitTimestamp: at(20) })], { dailyProfitLockAmount: 100 });
  assert.equal(result.rejectedTrades[0].rejectionReason, 'DAILY_PROFIT_LOCK');
  assert.equal(result.dailySummaries[0].profitLockTriggered, true);
});

test('resets daily limits at the IST trading-date boundary', () => {
  const nextDay = new Date('2026-07-16T09:15:00+05:30');
  const result = simulate([trade({ netPnl: -100 }), trade({ signalTimestamp: nextDay, exitTimestamp: new Date('2026-07-16T09:25:00+05:30') })], { maxDailyLossAmount: 100 });
  assert.equal(result.totalAccepted, 2);
  assert.equal(result.dailySummaries.length, 2);
});

test('uses deterministic rule priority when multiple limits apply', () => {
  const result = simulate([trade({ netPnl: -100 }), trade({ signalTimestamp: at(11), exitTimestamp: at(20) })], { maxDailyLossAmount: 100, maxTradesPerDay: 1, maxConsecutiveLosses: 1 });
  assert.equal(result.rejectedTrades[0].rejectionReason, 'DAILY_LOSS_LIMIT');
});

test('reports rejection counts by reason', () => {
  const result = simulate([trade({ exitTimestamp: at(20) }), trade({ signalTimestamp: at(5), exitTimestamp: at(10) })], { maxSimultaneousPositions: 1 });
  assert.equal(result.rejectionCounts.MAX_SIMULTANEOUS_POSITIONS, 1);
  assert.equal(result.rejectionCounts.DAILY_LOSS_LIMIT, 0);
});

test('sorts unsorted input chronologically', () => {
  const result = simulate([trade({ instrumentKey: 'later', signalTimestamp: at(20), exitTimestamp: at(30) }), trade({ instrumentKey: 'earlier' })]);
  assert.deepEqual(result.decisions.map((trade) => trade.instrumentKey), ['earlier', 'later']);
});

test('does not mutate input trades', () => {
  const input = [trade({ netPnl: -10 }), trade({ signalTimestamp: at(11), exitTimestamp: at(20) })];
  const before = structuredClone(input);
  simulate(input, { coolOffMinutesAfterLoss: 20 });
  assert.deepEqual(input, before);
});
