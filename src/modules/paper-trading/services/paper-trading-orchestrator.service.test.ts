import assert from 'node:assert/strict';
import test from 'node:test';
import { MarketDataSubscriptionMode } from '../../market-data/managers/subscription.manager';
import OptionContractSelectorService from '../../options/services/option-contract-selector.service';
import { OptionContract } from '../../options/types';
import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';
import { PaperTradingOrchestrationRequest } from '../dto/paper-trading-orchestrator.dto';
import { PaperOrderStatus } from '../types/paper-trading.types';
import PaperOrderManagerService from './paper-order-manager.service';
import PaperTradingOrchestratorService from './paper-trading-orchestrator.service';

const timestamp = new Date('2026-08-10T04:00:00.000Z');

function contracts(): OptionContract[] {
  return [
    { instrumentKey: 'NSE_FO|ce-24600', tradingSymbol: 'NIFTY CE 24600', underlying: 'NIFTY', strikePrice: 24_600, expiry: new Date('2026-08-13T00:00:00.000Z'), optionType: 'CE', exchange: 'NSE', segment: 'NSE_FO', lotSize: 75 },
    { instrumentKey: 'NSE_FO|ce-24650', tradingSymbol: 'NIFTY CE 24650', underlying: 'NIFTY', strikePrice: 24_650, expiry: new Date('2026-08-13T00:00:00.000Z'), optionType: 'CE', exchange: 'NSE', segment: 'NSE_FO', lotSize: 75 },
    { instrumentKey: 'NSE_FO|pe-24600', tradingSymbol: 'NIFTY PE 24600', underlying: 'NIFTY', strikePrice: 24_600, expiry: new Date('2026-08-13T00:00:00.000Z'), optionType: 'PE', exchange: 'NSE', segment: 'NSE_FO', lotSize: 75 },
  ];
}

function request(signalType = StrategySignal.BUY_CE): PaperTradingOrchestrationRequest {
  return { signal: { signalTimestamp: new Date(timestamp.getTime()), signalType, underlying: 'NIFTY', spotPrice: 24_624 }, contracts: contracts(), exitPolicy: { targetPercent: 30, stopLossPercent: 20, maximumHoldingMinutes: 60 } };
}

class SubscriptionGateway {
  readonly subscribed: string[] = [];
  fail = false;
  async subscribe(instrumentKey: string, _mode?: MarketDataSubscriptionMode): Promise<void> { if (this.fail) throw new Error('Subscription failed'); this.subscribed.push(instrumentKey); }
  getSubscriptions() { return this.subscribed.map((instrumentKey) => ({ instrumentKey, mode: MarketDataSubscriptionMode.FULL })); }
}

class PremiumProvider {
  calls = 0;
  premium = 100;
  async getObservedPremium(_instrumentKey: string): Promise<number> { this.calls += 1; return this.premium; }
}

function setup(selector: OptionContractSelectorService | { select: OptionContractSelectorService['select'] } = new OptionContractSelectorService()) {
  const manager = new PaperOrderManagerService(); const subscriptions = new SubscriptionGateway(); const premiums = new PremiumProvider();
  return { manager, subscriptions, premiums, orchestrator: new PaperTradingOrchestratorService(selector, manager, subscriptions, premiums) };
}

test('BUY_CE creates an ATM CE paper order', async () => {
  const { orchestrator } = setup(); const result = await orchestrator.createFromSignal(request());
  assert.equal(result.selectedContract.optionType, 'CE'); assert.equal(result.order.contract.instrumentKey, 'NSE_FO|ce-24600');
});

test('BUY_PE creates an ATM PE paper order', async () => {
  const { orchestrator } = setup(); const result = await orchestrator.createFromSignal(request(StrategySignal.BUY_PE));
  assert.equal(result.selectedContract.optionType, 'PE'); assert.equal(result.order.signalType, StrategySignal.BUY_PE);
});

test('rejects NO_TRADE signals', async () => {
  const { orchestrator } = setup();
  await assert.rejects(() => orchestrator.createFromSignal(request(StrategySignal.NO_TRADE)), /accepts only BUY_CE or BUY_PE/);
});

test('uses exactly one contract lot as quantity', async () => {
  const { orchestrator } = setup(); const result = await orchestrator.createFromSignal(request());
  assert.equal(result.order.contract.lotSize, 75); assert.equal(result.order.contract.quantity, 75);
});

test('rejects a selected contract without a valid lot size', async () => {
  const { orchestrator } = setup(); const initial = request(); const input = { ...initial, contracts: initial.contracts.map((contract, index) => index === 0 ? { ...contract, lotSize: undefined } : contract) };
  await assert.rejects(() => orchestrator.createFromSignal(input), /valid positive integer lotSize/);
});

test('requests a shared market-data subscription for the selected contract', async () => {
  const { orchestrator, subscriptions } = setup(); const result = await orchestrator.createFromSignal(request());
  assert.deepEqual(subscriptions.subscribed, ['NSE_FO|ce-24600']); assert.equal(result.subscription.requested, true);
});

test('propagates subscription failures before creating an order', async () => {
  const { orchestrator, subscriptions, manager } = setup(); subscriptions.fail = true;
  await assert.rejects(() => orchestrator.createFromSignal(request()), /Subscription failed/);
  assert.equal(manager.getActiveOrders().length, 0);
});

test('uses supplied observed entry premium before consulting the provider', async () => {
  const { orchestrator, premiums } = setup(); const input = { ...request(), observedEntryPremium: 123.45 }; const result = await orchestrator.createFromSignal(input);
  assert.equal(result.observedEntryPremium, 123.45); assert.equal(result.order.entry.simulatedEntryPremium, 123.45); assert.equal(premiums.calls, 0);
});

test('rejects invalid entry premium from the provider', async () => {
  const { orchestrator, premiums } = setup(); premiums.premium = 0;
  await assert.rejects(() => orchestrator.createFromSignal(request()), /Observed entry premium must be positive and finite/);
});

test('transitions a newly created order from pending to open', async () => {
  const { orchestrator } = setup(); const result = await orchestrator.createFromSignal(request());
  assert.equal(result.order.status, PaperOrderStatus.OPEN);
});

test('propagates selector failure', async () => {
  const selector = { select: () => { throw new Error('Selection failed'); } } as unknown as OptionContractSelectorService;
  const { orchestrator } = setup(selector);
  await assert.rejects(() => orchestrator.createFromSignal(request()), /Selection failed/);
});

test('does not mutate caller input', async () => {
  const { orchestrator } = setup(); const input = request(); const original = structuredClone(input); const result = await orchestrator.createFromSignal(input);
  assert.deepEqual(input, original); result.selectedContract.tradingSymbol = 'MUTATED'; result.order.contract.tradingSymbol = 'MUTATED';
  assert.equal(input.contracts[0].tradingSymbol, original.contracts[0].tradingSymbol);
});
