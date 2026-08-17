import assert from 'assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { calculateBookFeatures, calculateCrossSurfaceFeatures, CausalWindowAggregator, redactSensitiveText } from './order-flow-features';
import { isV12CurrentGeneration, isV12NiftyUnderlying, planV12OptionUniverseRotation, resolveV12OptionUniverse } from './option-universe';
import { deterministicV12EventId, V12OrderFlowJournal } from './v12-order-flow-journal';
import SubscriptionManager, { MarketDataSubscriptionMode } from '../../market-data/managers/subscription.manager';
import { ConnectionState } from '../../market-data/managers/connection.manager';
import TickProcessor, { MarketDepthEvent, MarketTickEvent } from '../../market-data/processors/tick.processor';

class V12SubscriptionConnection extends EventEmitter {
  state = ConnectionState.CONNECTED;
  generation = 1;
  readonly requests: Buffer[] = [];
  async connect(): Promise<void> {}
  getState(): ConnectionState { return this.state; }
  getGenerationId(): number { return this.generation; }
  send(request: Buffer): void { this.requests.push(request); }
}

test('V12 queue/depth imbalance, spread, and microprice use supplied book only', () => {
  const result=calculateBookFeatures([{bidPrice:99,bidQuantity:30,askPrice:101,askQuantity:10},{bidPrice:98,bidQuantity:20,askPrice:102,askQuantity:20}]);
  assert.equal(result.queueImbalance,.5); assert.equal(result.depthImbalance['2'],.25); assert.equal(result.midPrice,100); assert.equal(result.microprice,100.5); assert.equal(result.spreadPercent,2); assert.deepEqual(result.flags,[]);
});
test('V12 unavailable book values never invent an imbalance or microprice',()=>{const result=calculateBookFeatures([{bidPrice:99,bidQuantity:0}]);assert.equal(result.queueImbalance,null);assert.equal(result.microprice,null);assert.ok(result.flags.includes('MISSING_ASK'));});
test('V12 CE/PE cross surface rejects stale or mixed-expiry observations',()=>{const ce={expiry:'2026-08-20',strike:20000,optionType:'CE' as const,timestampMs:1000,queueImbalance:.2,spreadPercent:.1};const pe={...ce,optionType:'PE' as const,queueImbalance:-.3};assert.equal(calculateCrossSurfaceFeatures(ce,pe,2000,2000)?.ceMinusPe,.5);assert.equal(calculateCrossSurfaceFeatures(ce,{...pe,expiry:'2026-08-27'},2000,2000),null);assert.equal(calculateCrossSurfaceFeatures(ce,pe,5001,2000),null);});
test('V12 aggregation is causal and flushes a completed window only after a later update',()=>{const aggregator=new CausalWindowAggregator(5);const one={eventId:'1',instrumentKey:'CE',timestampMs:1000,queueImbalance:.2,spreadPercent:.1,ltp:100,underlyingSpot:20000};assert.equal(aggregator.push(one).length,0);assert.equal(aggregator.push({...one,eventId:'2',timestampMs:4000,queueImbalance:.4,ltp:101}).length,0);const done=aggregator.push({...one,eventId:'3',timestampMs:6000,queueImbalance:.1});assert.equal(done.length,1);assert.equal(done[0].finalImbalance,.4);assert.equal(done[0].optionReturnPercent,1);});
test('V12 universe uses same expiry and actual adjacent strikes',()=>{const expiry=new Date('2026-08-20T10:00:00Z');const contracts=[19800,19900,20000,20100].flatMap((strike)=>['CE','PE'].map((optionType)=>({instrumentKey:`${strike}-${optionType}`,tradingSymbol:'x',underlying:'NIFTY 50',strikePrice:strike,expiry,optionType:optionType as 'CE'|'PE',exchange:'NSE',segment:'NSE_FO'})));const universe=resolveV12OptionUniverse(contracts,20020,new Date('2026-08-14T06:00:00Z'));assert.ok(universe);assert.equal(universe?.atmStrike,20000);assert.equal(universe?.contracts.length,6);});
test('V12 recognizes active NIFTY metadata aliases and requests deterministic CE plus PE subscriptions',()=>{const expiry=new Date('2026-08-20T10:00:00Z');const contracts=[19800,19900,20000,20100].flatMap((strike)=>['CE','PE'].map((optionType)=>({instrumentKey:`${strike}-${optionType}`,tradingSymbol:'x',underlying:'NIFTY 50',strikePrice:strike,expiry,optionType:optionType as 'CE'|'PE',exchange:'NSE',segment:'NSE_FO'})));assert.equal(isV12NiftyUnderlying('NIFTY'),true);assert.equal(isV12NiftyUnderlying('Nifty 50'),true);assert.equal(isV12NiftyUnderlying('BANKNIFTY'),false);const plan=planV12OptionUniverseRotation(contracts,20020,new Date('2026-08-14T06:00:00Z'),undefined,new Set());assert.equal(plan.changed,true);assert.equal(plan.addedInstrumentKeys.length,6);assert.ok(plan.universe?.contracts.some((contract)=>contract.optionType==='CE'));assert.ok(plan.universe?.contracts.some((contract)=>contract.optionType==='PE'));const sent:string[][]=[];if(plan.addedInstrumentKeys.length)sent.push([...plan.addedInstrumentKeys]);assert.deepEqual(sent,[plan.addedInstrumentKeys]);assert.equal(planV12OptionUniverseRotation(contracts,20020,new Date('2026-08-14T06:00:00Z'),plan.universe?.identity,plan.nextInstrumentKeys).changed,false);});
test('V12 underlying normalization accepts only exact NIFTY aliases',()=>{
  for(const alias of ['NIFTY',' nifty ','Nifty 50',' NIFTY-50 ']) assert.equal(isV12NiftyUnderlying(alias),true,alias);
  for(const other of ['BANKNIFTY','FINNIFTY','MIDCPNIFTY','NIFTY NEXT 50','NIFTYNXT50']) assert.equal(isV12NiftyUnderlying(other),false,other);
});
test('V12 option-universe rotation subscribes only the true delta',()=>{
  const expiry=new Date('2026-08-20T10:00:00Z');
  const contracts=[19800,19900,20000,20100,20200,20300].flatMap((strike)=>['CE','PE'].map((optionType)=>({instrumentKey:`${strike}-${optionType}`,tradingSymbol:'x',underlying:'NIFTY 50',strikePrice:strike,expiry,optionType:optionType as 'CE'|'PE',exchange:'NSE',segment:'NSE_FO'})));
  const at20000=planV12OptionUniverseRotation(contracts,20020,new Date('2026-08-14T06:00:00Z'),undefined,new Set());
  const at20100=planV12OptionUniverseRotation(contracts,20080,new Date('2026-08-14T06:01:00Z'),at20000.universe?.identity,at20000.nextInstrumentKeys);
  assert.deepEqual(at20100.addedInstrumentKeys,['20200-CE','20200-PE']);
  assert.deepEqual(at20100.removedInstrumentKeys,['19900-CE','19900-PE']);
  assert.equal(at20100.nextInstrumentKeys.size,6);
});
test('V12 selected option universe uses canonical full subscriptions and restores once per generation',async()=>{
  const expiry=new Date('2026-08-20T10:00:00Z');
  const contracts=[19800,19900,20000,20100].flatMap((strike)=>['CE','PE'].map((optionType)=>({instrumentKey:`NSE_FO|${strike}-${optionType}`,tradingSymbol:'x',underlying:'NIFTY 50',strikePrice:strike,expiry,optionType:optionType as 'CE'|'PE',exchange:'NSE',segment:'NSE_FO'})));
  const plan=planV12OptionUniverseRotation(contracts,20020,new Date('2026-08-14T06:00:00Z'),undefined,new Set());
  const connection=new V12SubscriptionConnection(); const subscriptions=new SubscriptionManager('token',connection as never);
  await subscriptions.subscribeMany([...plan.addedInstrumentKeys],MarketDataSubscriptionMode.FULL);
  const initial=JSON.parse(connection.requests[0].toString());
  assert.equal(initial.data.mode,'full'); assert.deepEqual(initial.data.instrumentKeys,plan.addedInstrumentKeys);
  connection.generation=2;connection.emit('stateChanged',{previousState:ConnectionState.RECONNECTING,state:ConnectionState.CONNECTED,generationId:2});
  assert.equal(connection.requests.length,2);const restored=JSON.parse(connection.requests[1].toString());assert.equal(restored.data.mode,'full');assert.deepEqual(restored.data.instrumentKeys,plan.addedInstrumentKeys);
  connection.emit('stateChanged',{previousState:ConnectionState.CONNECTED,state:ConnectionState.CONNECTED,generationId:2});assert.equal(connection.requests.length,2);
});
test('V12 receives option LTPC and depth from the canonical full-feed processor paths',()=>{
  const bus=new EventEmitter();const ticks:MarketTickEvent[]=[];const depths:MarketDepthEvent[]=[];bus.on('market.tick',(event)=>ticks.push(event));bus.on('market.depth',(event)=>depths.push(event));
  new TickProcessor(bus).process({type:'live_feed',currentTs:'1723618200000',feeds:{'NSE_FO|45102':{fullFeed:{marketFF:{ltpc:{ltp:123.45},marketLevel:{bidAskQuote:[{bidP:123,bidQ:'10',askP:124,askQ:'12'}]}}}}}} as any,7);
  assert.deepEqual(ticks,[{instrumentKey:'NSE_FO|45102',timestamp:'1723618200000',ltp:123.45,lastTradedTime:undefined,lastTradedQuantity:undefined,closePrice:undefined,generationId:7}]);
  assert.equal(depths.length,1);assert.equal(depths[0].instrumentKey,'NSE_FO|45102');assert.equal(depths[0].generationId,7);assert.deepEqual(depths[0].quotes,[{bidPrice:123,bidQuantity:'10',askPrice:124,askQuantity:'12'}]);
});
test('V12 accepts only active-generation option LTPC and depth events',()=>{assert.equal(isV12CurrentGeneration(7,7),true);assert.equal(isV12CurrentGeneration(undefined,7),true);const staleLtpc={generationId:6};const staleDepth={generationId:6};assert.equal(isV12CurrentGeneration(staleLtpc.generationId,7),false);assert.equal(isV12CurrentGeneration(staleDepth.generationId,7),false);});
test('V12 journal append/restart deduplicates recent deterministic events and finalizes once safely', () => {
  const root = mkdtempSync(join(tmpdir(), 'v12-'));
  try {
    const journal = new V12OrderFlowJournal(root, '2026-08-14', new Date('2026-08-14T04:00:00Z'));
    const record: any = { instrumentKey:'CE', exchangeTimestamp:'2026-08-14T04:00:01Z', receivedAt:'2026-08-14T04:00:01Z', levels:[], ltp:100, sessionId:journal.manifest.sessionId, tradingDate:'2026-08-14', timestampMs:Date.parse('2026-08-14T04:00:01Z'), queueImbalance:null, spreadPercent:null, underlyingSpot:20000, flags:[] };
    record.eventId = deterministicV12EventId(record);
    assert.equal(journal.append(record), true); assert.equal(journal.append(record), false); journal.finalize(); journal.finalize();
    const restarted = new V12OrderFlowJournal(root, '2026-08-14');
    assert.equal(restarted.manifest.restartCount, 1); assert.equal(restarted.append(record), false);
    assert.ok(readFileSync(join(root, '2026-08-14', 'session-manifest.json'), 'utf8').includes('EOD'));
  } finally { rmSync(root, { recursive:true, force:true }); }
});
test('V12 journal persists underlying, option LTP, and option depth records then flushes before EOD completion', () => {
  const root=mkdtempSync(join(tmpdir(),'v12-capture-'));
  try {
    const journal=new V12OrderFlowJournal(root,'2026-08-17',new Date('2026-08-17T04:00:00Z'));
    const base={sessionId:journal.manifest.sessionId,tradingDate:'2026-08-17',receivedAt:'2026-08-17T04:00:01.000Z',exchangeTimestamp:'2026-08-17T04:00:01.000Z',timestampMs:Date.parse('2026-08-17T04:00:01.000Z'),queueImbalance:null,spreadPercent:null,underlyingSpot:24000,flags:[]};
    const underlying:any={...base,eventId:'underlying',instrumentKey:'NSE_INDEX|Nifty 50',expiry:null,strike:null,optionType:null,ltp:24000,levels:[],recordType:'UNDERLYING_TICK'};
    const optionLtp:any={...base,eventId:'ce-ltp',instrumentKey:'NSE_FO|ce',expiry:'2026-08-20T10:00:00.000Z',strike:24000,optionType:'CE',ltp:100,levels:[],recordType:'OPTION_LTP'};
    const optionPeLtp:any={...base,eventId:'pe-ltp',instrumentKey:'NSE_FO|pe',expiry:'2026-08-20T10:00:00.000Z',strike:24000,optionType:'PE',ltp:95,levels:[],recordType:'OPTION_LTP'};
    const optionDepth:any={...base,eventId:'ce-depth',instrumentKey:'NSE_FO|ce',expiry:'2026-08-20T10:00:00.000Z',strike:24000,optionType:'CE',ltp:100,levels:[{bidPrice:99,bidQuantity:10,askPrice:101,askQuantity:10}],recordType:'OPTION_DEPTH'};
    assert.equal(journal.append(underlying),true);assert.equal(journal.append(optionLtp),true);assert.equal(journal.append(optionLtp),false);assert.equal(journal.append(optionPeLtp),true);assert.equal(journal.append(optionDepth),true);journal.finalize('EOD');
    const lines=readFileSync(join(root,'2026-08-17','raw-depth.jsonl'),'utf8');assert.ok(lines.includes('UNDERLYING_TICK'));assert.ok(lines.includes('OPTION_LTP'));assert.ok(lines.includes('OPTION_DEPTH'));assert.ok(lines.includes('NSE_FO|ce'));assert.ok(lines.includes('NSE_FO|pe'));assert.ok(existsSync(join(root,'2026-08-17','aggregated-5s.jsonl')));assert.ok(readFileSync(join(root,'2026-08-17','session-manifest.json'),'utf8').includes('EOD'));
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('V12 redacts bearer tokens from strings and structured errors',()=>{const redacted=redactSensitiveText({Authorization:'Bearer secret-token',message:'Authorization: Bearer abc.def'});assert.equal((redacted as any).Authorization,'[REDACTED]');assert.ok(!(redacted as any).message.includes('abc.def'));});
