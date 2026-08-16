import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import PaperOrderManagerService from './paper-order-manager.service';
import PaperPortfolioService, { FilePaperPortfolioRepository, InMemoryPaperPortfolioRepository } from './paper-portfolio.service';
import RuntimeRiskGateService from '../../risk/runtime-risk-gate.service';
import { PaperOrder, PaperOrderStatus } from '../types/paper-trading.types';
import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';

const session = '2026-08-17';
const at = new Date('2026-08-17T04:00:00.000Z');
function order(): PaperOrder {
  const manager = new PaperOrderManagerService();
  return manager.markOpen(manager.create({ signalTimestamp: at, signalType: StrategySignal.BUY_PE, contract: { instrumentKey: 'NSE_FO|1', tradingSymbol: 'NIFTY PE', optionType: 'PE', strikePrice: 25000, expiry: new Date('2026-08-20T10:00:00Z'), lotSize: 50, quantity: 50 }, entry: { entryTimestamp: at, observedEntryPremium: 100, simulatedEntryPremium: 100 }, exitConfiguration: { targetPercent: 5, stopLossPercent: 5, maximumHoldingMinutes: 15 } }).id);
}
function closed(input: PaperOrder, reason: PaperOrderStatus.TARGET_EXIT | PaperOrderStatus.STOP_EXIT | PaperOrderStatus.TIME_EXIT = PaperOrderStatus.TARGET_EXIT, premium = 105): PaperOrder {
  const manager = new PaperOrderManagerService();
  // Recreate the exact active order in a manager is intentionally avoided: close data is all portfolio needs.
  return { ...input, status: reason, exit: { exitReason: reason, exitTimestamp: new Date('2026-08-17T04:05:00Z'), observedExitPremium: premium, simulatedExitPremium: premium } };
}
function open(portfolio: PaperPortfolioService, paperOrder = order()): PaperOrder { portfolio.open({ order: paperOrder, strategyId: 'V2_TREND_DOWN_PE', underlying: 'NIFTY 50', correlationId: 'corr-1', intentId: 'intent-1', sessionDate: session }); return paperOrder; }

test('one approved paper order opens exactly one deterministic portfolio position', () => {
  const portfolio = new PaperPortfolioService(new InMemoryPaperPortfolioRepository(), () => at); const paperOrder = open(portfolio);
  open(portfolio, paperOrder);
  const snapshot = portfolio.getSnapshot(session);
  assert.equal(snapshot?.openPositionCount, 1); assert.equal(snapshot?.totalNotional, 5000); assert.equal(snapshot?.strategyBreakdown[0].openPositionCount, 1);
  const position = portfolio.getRiskPositions(session); assert.equal(position?.length, 1);
});

test('fresh bid marks unrealized P&L while stale quotes never invent a mark', () => {
  const portfolio = new PaperPortfolioService(new InMemoryPaperPortfolioRepository(), () => at); open(portfolio);
  assert.equal(portfolio.mark({ instrumentKey: 'NSE_FO|1', timestamp: at, bid: 103, ask: 104, ltp: 103.5, ageMs: 100 }), 1);
  assert.equal(portfolio.getSnapshot(session)?.totalUnrealizedPnl, 150);
  portfolio.mark({ instrumentKey: 'NSE_FO|1', timestamp: at, ltp: 150, ageMs: 5_000 });
  assert.equal(portfolio.getSnapshot(session)?.totalUnrealizedPnl, 150);
});

test('target, stop, timeout and EOD closes use existing premium-difference P&L exactly once', () => {
  for (const reason of [PaperOrderStatus.TARGET_EXIT, PaperOrderStatus.STOP_EXIT, PaperOrderStatus.TIME_EXIT] as const) {
    const portfolio = new PaperPortfolioService(new InMemoryPaperPortfolioRepository(), () => at); const paperOrder = open(portfolio); const result = portfolio.close(closed(paperOrder, reason, reason === PaperOrderStatus.STOP_EXIT ? 95 : 105), session);
    assert.equal(result?.realizedPnl, reason === PaperOrderStatus.STOP_EXIT ? -250 : 250);
    assert.equal(portfolio.close(closed(paperOrder, reason, 1), session)?.realizedPnl, result?.realizedPnl);
    assert.equal(portfolio.getSnapshot(session)?.totalRealizedPnl, result?.realizedPnl);
  }
});

test('portfolio snapshot drives risk position, exposure and realized daily-loss checks', () => {
  const portfolio = new PaperPortfolioService(new InMemoryPaperPortfolioRepository(), () => at); const paperOrder = open(portfolio);
  const gate = new RuntimeRiskGateService({ persist: false, killSwitch: false, maxOpenPositions: 1, getPortfolioSnapshot: (date) => portfolio.getSnapshot(date) });
  const intent = { runtimeId: 'paper:v2', strategyId: 'V2_TREND_DOWN_PE', sessionDate: session, timestamp: at, instrument: 'NSE_FO|2', underlying: 'NIFTY 50', side: 'BUY_PE' as const, action: 'OPEN' as const, entryPremium: 100, quantity: 50, marketDataState: 'READY', sessionTradable: true, quote: { ltp: 100, bid: 99, ask: 101, ageMs: 1 } };
  assert.ok(gate.evaluate(intent).denialReasons.includes('MAX_OPEN_POSITIONS'));
  portfolio.close(closed(paperOrder, PaperOrderStatus.STOP_EXIT, 95), session);
  const lossGate = new RuntimeRiskGateService({ persist: false, killSwitch: false, dailyLossLimit: 200, getPortfolioSnapshot: (date) => portfolio.getSnapshot(date) });
  assert.ok(lossGate.evaluate({ ...intent, instrument: 'NSE_FO|3' }).denialReasons.includes('DAILY_LOSS_LIMIT'));
});

test('portfolio-backed risk limits include per-underlying exposure without reconstructed counters', () => {
  const portfolio = new PaperPortfolioService(new InMemoryPaperPortfolioRepository(), () => at); open(portfolio);
  const gate = new RuntimeRiskGateService({ persist:false, killSwitch:false, maxOpenPositions:5, maxOpenPositionsPerStrategy:5, maxOpenPositionsPerUnderlying:1, getPortfolioSnapshot:(date)=>portfolio.getSnapshot(date) });
  const intent = { runtimeId:'paper:v2', strategyId:'OTHER', sessionDate:session, timestamp:at, instrument:'NSE_FO|2', underlying:'NIFTY 50', side:'BUY_PE' as const, action:'OPEN' as const, entryPremium:100, quantity:50, marketDataState:'READY', sessionTradable:true, quote:{ltp:100,bid:99,ask:101,ageMs:1} };
  assert.ok(gate.evaluate(intent).denialReasons.includes('MAX_OPEN_POSITIONS'));
});

test('restart retains closed history but unreconciled open position fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'trademind-portfolio-')); const repository = new FilePaperPortfolioRepository(root);
  const first = new PaperPortfolioService(repository, () => at); open(first);
  const restarted = new PaperPortfolioService(new FilePaperPortfolioRepository(root), () => at);
  assert.equal(restarted.getSnapshot(session), undefined);
  assert.equal(restarted.reconcileOpenOrders(session, []), false);
  assert.equal(restarted.getRiskPositions(session), undefined);
});

test('corrupt durable state fails closed and session snapshots remain separate', () => {
  const root = mkdtempSync(join(tmpdir(), 'trademind-portfolio-')); writeFileSync(join(root, `${session}.json`), '{bad json');
  const corrupt = new PaperPortfolioService(new FilePaperPortfolioRepository(root), () => at);
  assert.equal(corrupt.getSnapshot(session), undefined);
  const clean = new PaperPortfolioService(new InMemoryPaperPortfolioRepository(), () => at); const paperOrder = open(clean); clean.close(closed(paperOrder), session); assert.equal(clean.getSnapshot('2026-08-18')?.openPositionCount, 0);
});

test('shadow and collection paths create no paper position without a portfolio open call', () => {
  const portfolio = new PaperPortfolioService(new InMemoryPaperPortfolioRepository(), () => at);
  assert.equal(portfolio.getSnapshot(session)?.openPositionCount, 0);
});

test('identical in-memory portfolio lifecycle produces an identical replay-safe digest', () => {
  const fixed = { ...order(), id: 'deterministic-order-id' };
  const first = new PaperPortfolioService(new InMemoryPaperPortfolioRepository(), () => at); first.open({ order: fixed, strategyId: 'V2_TREND_DOWN_PE', underlying: 'NIFTY 50', correlationId: 'corr', intentId: 'intent', sessionDate: session }); first.close(closed(fixed), session);
  const second = new PaperPortfolioService(new InMemoryPaperPortfolioRepository(), () => at); second.open({ order: fixed, strategyId: 'V2_TREND_DOWN_PE', underlying: 'NIFTY 50', correlationId: 'corr', intentId: 'intent', sessionDate: session }); second.close(closed(fixed), session);
  assert.equal(first.digest(session), second.digest(session));
});
