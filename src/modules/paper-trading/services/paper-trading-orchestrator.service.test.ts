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
import RuntimeRiskGateService, { RiskDeniedError } from '../../risk/runtime-risk-gate.service';
import PaperEntryQuoteWaiterService, { PaperEntryQuoteWaitError } from './paper-entry-quote-waiter.service';
import PaperPortfolioService, { InMemoryPaperPortfolioRepository } from './paper-portfolio.service';
import PaperFillModelService, { PaperFillUnavailableError } from './paper-fill-model.service';
import { ExecutionQuoteSnapshot } from '../dto/paper-fill-model.dto';
import ExecutionEngineService from '../../execution/execution-engine.service';
import { InMemoryExecutionRepository } from '../../execution/execution.repository';

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

test('a central risk denial creates zero paper orders', async () => {
  const manager = new PaperOrderManagerService(); const subscriptions = new SubscriptionGateway(); const premiums = new PremiumProvider();
  const risk = new RuntimeRiskGateService({ persist:false, killSwitch:true, getOpenPositions:()=>[] });
  const orchestrator = new PaperTradingOrchestratorService(new OptionContractSelectorService(), manager, subscriptions, premiums, MarketDataSubscriptionMode.FULL, risk, { buildIntent: ({ signal, contract, observedEntryPremium }) => ({ runtimeId:'test',strategyId:'V2_TREND_DOWN_PE',sessionDate:'2026-08-10',timestamp:signal.signalTimestamp,instrument:contract.instrumentKey,underlying:'NIFTY',side:'BUY_CE',action:'OPEN',entryPremium:observedEntryPremium,quantity:contract.lotSize as number,marketDataState:'READY',sessionTradable:true,quote:{ltp:observedEntryPremium,ageMs:0} }) });
  await assert.rejects(() => orchestrator.createFromSignal(request()), RiskDeniedError); assert.equal(manager.getActiveOrders().length, 0);
});

test('first actionable intent subscribes, waits for fresh bid/ask, then creates exactly one order', async () => {
  const manager = new PaperOrderManagerService(); const subscriptions = new SubscriptionGateway(); let quote: {ltp:number;bid:number;ask:number;receivedAtMs:number}|undefined; let now=0;
  const premiums = { getObservedPremium: async (instrumentKey:string) => new PaperEntryQuoteWaiterService({ timeoutMs:10,pollMs:1,now:()=>now,sleep:async()=>{now+=1;if(now===1)quote={ltp:100,bid:99,ask:101,receivedAtMs:now};},abortReason:()=>undefined,getSnapshot:()=>quote }).waitForFreshQuote(instrumentKey).then((value)=>value.ltp) };
  const risk = new RuntimeRiskGateService({persist:false,killSwitch:false,getOpenPositions:()=>[]});
  const context = { buildIntent: ({signal,contract,observedEntryPremium}: any) => ({runtimeId:'test',strategyId:'V2_TREND_DOWN_PE',sessionDate:'2026-08-10',timestamp:signal.signalTimestamp,instrument:contract.instrumentKey,underlying:'NIFTY',side:'BUY_CE' as const,action:'OPEN' as const,entryPremium:observedEntryPremium,quantity:contract.lotSize,marketDataState:'READY',sessionTradable:true,quote:{ltp:quote?.ltp,bid:quote?.bid,ask:quote?.ask,ageMs:0}}) };
  const orchestrator = new PaperTradingOrchestratorService(new OptionContractSelectorService(),manager,subscriptions,premiums,MarketDataSubscriptionMode.FULL,risk,context);
  const first=orchestrator.createFromSignal(request()); const duplicate=orchestrator.createFromSignal(request()); const result=await first; await assert.rejects(()=>duplicate,RiskDeniedError);
  assert.equal(subscriptions.subscribed.length,1); assert.equal(result.order.status,PaperOrderStatus.OPEN); assert.equal(manager.getActiveOrders().length,1);
});

test('approved V2 intent creates one authoritative paper portfolio position', async () => {
  const manager = new PaperOrderManagerService(); const subscriptions = new SubscriptionGateway(); const premiums = new PremiumProvider(); const portfolio = new PaperPortfolioService(new InMemoryPaperPortfolioRepository(), () => timestamp);
  const risk = new RuntimeRiskGateService({ persist:false, killSwitch:false, getPortfolioSnapshot:(date)=>portfolio.getSnapshot(date) });
  const context = { buildIntent: ({signal,contract,observedEntryPremium}: any) => ({ runtimeId:'test',strategyId:'V2_TREND_DOWN_PE',sessionDate:'2026-08-10',timestamp:signal.signalTimestamp,instrument:contract.instrumentKey,underlying:'NIFTY',side:'BUY_CE' as const,action:'OPEN' as const,entryPremium:observedEntryPremium,quantity:contract.lotSize,marketDataState:'READY',sessionTradable:true,quote:{ltp:observedEntryPremium,bid:99,ask:101,ageMs:0} }) };
  const orchestrator = new PaperTradingOrchestratorService(new OptionContractSelectorService(), manager, subscriptions, premiums, MarketDataSubscriptionMode.FULL, risk, context, portfolio);
  await orchestrator.createFromSignal(request());
  await assert.rejects(() => orchestrator.createFromSignal(request()), RiskDeniedError);
  assert.equal(portfolio.getSnapshot('2026-08-10')?.openPositionCount, 1);
  assert.equal(manager.getActiveOrders().length, 1);
});

test('risk approval followed by unavailable execution quote creates zero paper position or order', async () => {
  const manager = new PaperOrderManagerService(); const subscriptions = new SubscriptionGateway(); const premiums = new PremiumProvider(); const portfolio = new PaperPortfolioService(new InMemoryPaperPortfolioRepository(), () => timestamp);
  const risk = new RuntimeRiskGateService({ persist:false, killSwitch:false, getPortfolioSnapshot:(date)=>portfolio.getSnapshot(date) });
  const context = { buildIntent: ({signal,contract,observedEntryPremium}: any) => ({ runtimeId:'test',strategyId:'V2_TREND_DOWN_PE',sessionDate:'2026-08-10',timestamp:signal.signalTimestamp,instrument:contract.instrumentKey,underlying:'NIFTY',side:'BUY_CE' as const,action:'OPEN' as const,entryPremium:observedEntryPremium,quantity:contract.lotSize,marketDataState:'READY',sessionTradable:true,quote:{ltp:100,bid:99,ask:101,ageMs:0} }) };
  const provider = { getExecutionQuoteSnapshot: (): ExecutionQuoteSnapshot => ({ instrumentKey:'NSE_FO|ce-24600', sourceTimestamp:timestamp.toISOString(), receivedTimestamp:timestamp.toISOString(), quoteAgeMs:0, ltp:100, bestBid:null, bestAsk:null, bidSize:null, askSize:null, depthLevels:[], spreadAbsolute:null, spreadPercent:null, connectionGenerationId:1, dataQuality:'LTP_ONLY' }) };
  const orchestrator = new PaperTradingOrchestratorService(new OptionContractSelectorService(), manager, subscriptions, premiums, MarketDataSubscriptionMode.FULL, risk, context, portfolio, new PaperFillModelService(), provider);
  await assert.rejects(() => orchestrator.createFromSignal(request()), PaperFillUnavailableError);
  assert.equal(manager.getActiveOrders().length, 0); assert.equal(portfolio.getSnapshot('2026-08-10')?.openPositionCount, 0);
});

test('a depth partial entry creates exposure and P&L only for filled quantity', async () => {
  const manager = new PaperOrderManagerService(); const subscriptions = new SubscriptionGateway(); const premiums = new PremiumProvider(); const portfolio = new PaperPortfolioService(new InMemoryPaperPortfolioRepository(), () => timestamp);
  const risk = new RuntimeRiskGateService({ persist:false, killSwitch:false, maxOpenPositions:2, getPortfolioSnapshot:(date)=>portfolio.getSnapshot(date) });
  const context = { buildIntent: ({signal,contract,observedEntryPremium}: any) => ({ runtimeId:'test',strategyId:'V2_TREND_DOWN_PE',sessionDate:'2026-08-10',timestamp:signal.signalTimestamp,instrument:contract.instrumentKey,underlying:'NIFTY',side:'BUY_CE' as const,action:'OPEN' as const,entryPremium:observedEntryPremium,quantity:contract.lotSize,marketDataState:'READY',sessionTradable:true,quote:{ltp:100,bid:99,ask:101,ageMs:0} }) };
  const provider = { getExecutionQuoteSnapshot: (): ExecutionQuoteSnapshot => ({ instrumentKey:'NSE_FO|ce-24600', sourceTimestamp:timestamp.toISOString(), receivedTimestamp:timestamp.toISOString(), quoteAgeMs:0, ltp:100, bestBid:99, bestAsk:101, bidSize:75, askSize:50, depthLevels:[{ bid:99,bidSize:75,ask:101,askSize:50 }], spreadAbsolute:2, spreadPercent:2, connectionGenerationId:1, dataQuality:'FRESH_DEPTH' }) };
  const orchestrator = new PaperTradingOrchestratorService(new OptionContractSelectorService(), manager, subscriptions, premiums, MarketDataSubscriptionMode.FULL, risk, context, portfolio, new PaperFillModelService(), provider);
  const result = await orchestrator.createFromSignal(request());
  assert.equal(result.order.contract.quantity, 50); assert.equal(result.order.entry.simulatedEntryPremium, 101); assert.equal(result.order.entry.executionFill?.status, 'PARTIALLY_FILLED');
  assert.equal(portfolio.getSnapshot('2026-08-10')?.totalNotional, 5050);
});

test('a V2-approved intent creates exactly one durable execution order before one paper order', async () => {
  const manager=new PaperOrderManagerService(); const subscriptions=new SubscriptionGateway(); const premiums=new PremiumProvider(); const portfolio=new PaperPortfolioService(new InMemoryPaperPortfolioRepository(),()=>timestamp); const executions=new ExecutionEngineService(new InMemoryExecutionRepository(),()=>timestamp); executions.reconcile('2026-08-10',[]);
  const risk=new RuntimeRiskGateService({persist:false,killSwitch:false,getPortfolioSnapshot:(date)=>portfolio.getSnapshot(date),getExecutionHealth:(date)=>executions.getHealth(date)});
  const context={buildIntent:({signal,contract,observedEntryPremium}:any)=>({runtimeId:'test',strategyId:'V2_TREND_DOWN_PE',sessionDate:'2026-08-10',timestamp:signal.signalTimestamp,instrument:contract.instrumentKey,underlying:'NIFTY',side:'BUY_CE' as const,action:'OPEN' as const,entryPremium:observedEntryPremium,quantity:contract.lotSize,marketDataState:'READY',sessionTradable:true,quote:{ltp:100,bid:99,ask:101,ageMs:0}})};
  const provider={getExecutionQuoteSnapshot:():ExecutionQuoteSnapshot=>({instrumentKey:'NSE_FO|ce-24600',sourceTimestamp:timestamp.toISOString(),receivedTimestamp:timestamp.toISOString(),quoteAgeMs:0,ltp:100,bestBid:99,bestAsk:101,bidSize:75,askSize:75,depthLevels:[],spreadAbsolute:2,spreadPercent:2,connectionGenerationId:1,dataQuality:'FRESH_TOP_OF_BOOK'})};
  const orchestrator=new PaperTradingOrchestratorService(new OptionContractSelectorService(),manager,subscriptions,premiums,MarketDataSubscriptionMode.FULL,risk,context,portfolio,new PaperFillModelService(),provider,executions);
  const result=await orchestrator.createFromSignal(request()); assert.ok(result.order.executionOrderId); const durable=executions.getById(result.order.executionOrderId as string,'2026-08-10'); assert.equal(durable?.paperOrderId,result.order.id); assert.equal(durable?.status,'FILLED');
  await assert.rejects(()=>orchestrator.createFromSignal(request()),RiskDeniedError); assert.equal(manager.getActiveOrders().length,1);
});

test('quote wait timeout, stale quote, reconnect and EOD deny with no order', async () => {
  for (const reason of ['QUOTE_UNAVAILABLE','STALE_QUOTE','MARKET_DATA_NOT_READY','EOD_BLOCK'] as const) {
    const manager=new PaperOrderManagerService(); const subscriptions=new SubscriptionGateway(); const premiums={getObservedPremium:async()=>{throw new PaperEntryQuoteWaitError(reason);}}; const risk=new RuntimeRiskGateService({persist:false,killSwitch:false,getOpenPositions:()=>[]});
    const orchestrator=new PaperTradingOrchestratorService(new OptionContractSelectorService(),manager,subscriptions,premiums,MarketDataSubscriptionMode.FULL,risk,{buildIntent:({signal,contract}:any)=>({runtimeId:'test',strategyId:'V2_TREND_DOWN_PE',sessionDate:'2026-08-10',timestamp:signal.signalTimestamp,instrument:contract.instrumentKey,underlying:'NIFTY',side:'BUY_CE',action:'OPEN',entryPremium:NaN,quantity:75,marketDataState:'READY',sessionTradable:true})});
    await assert.rejects(()=>orchestrator.createFromSignal(request()),(error:unknown)=>error instanceof RiskDeniedError&&error.decision.denialReasons.includes(reason)); assert.equal(manager.getActiveOrders().length,0);
  }
});
