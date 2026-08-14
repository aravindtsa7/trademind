import assert from 'assert';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { test } from 'node:test';
import { calculateBookFeatures, calculateCrossSurfaceFeatures, CausalWindowAggregator, redactSensitiveText } from './order-flow-features';
import { resolveV12OptionUniverse } from './option-universe';
import { deterministicV12EventId, V12OrderFlowJournal } from './v12-order-flow-journal';

test('V12 queue/depth imbalance, spread, and microprice use supplied book only', () => {
  const result=calculateBookFeatures([{bidPrice:99,bidQuantity:30,askPrice:101,askQuantity:10},{bidPrice:98,bidQuantity:20,askPrice:102,askQuantity:20}]);
  assert.equal(result.queueImbalance,.5); assert.equal(result.depthImbalance['2'],.25); assert.equal(result.midPrice,100); assert.equal(result.microprice,100.5); assert.equal(result.spreadPercent,2); assert.deepEqual(result.flags,[]);
});
test('V12 unavailable book values never invent an imbalance or microprice',()=>{const result=calculateBookFeatures([{bidPrice:99,bidQuantity:0}]);assert.equal(result.queueImbalance,null);assert.equal(result.microprice,null);assert.ok(result.flags.includes('MISSING_ASK'));});
test('V12 CE/PE cross surface rejects stale or mixed-expiry observations',()=>{const ce={expiry:'2026-08-20',strike:20000,optionType:'CE' as const,timestampMs:1000,queueImbalance:.2,spreadPercent:.1};const pe={...ce,optionType:'PE' as const,queueImbalance:-.3};assert.equal(calculateCrossSurfaceFeatures(ce,pe,2000,2000)?.ceMinusPe,.5);assert.equal(calculateCrossSurfaceFeatures(ce,{...pe,expiry:'2026-08-27'},2000,2000),null);assert.equal(calculateCrossSurfaceFeatures(ce,pe,5001,2000),null);});
test('V12 aggregation is causal and flushes a completed window only after a later update',()=>{const aggregator=new CausalWindowAggregator(5);const one={eventId:'1',instrumentKey:'CE',timestampMs:1000,queueImbalance:.2,spreadPercent:.1,ltp:100,underlyingSpot:20000};assert.equal(aggregator.push(one).length,0);assert.equal(aggregator.push({...one,eventId:'2',timestampMs:4000,queueImbalance:.4,ltp:101}).length,0);const done=aggregator.push({...one,eventId:'3',timestampMs:6000,queueImbalance:.1});assert.equal(done.length,1);assert.equal(done[0].finalImbalance,.4);assert.equal(done[0].optionReturnPercent,1);});
test('V12 universe uses same expiry and actual adjacent strikes',()=>{const expiry=new Date('2026-08-20T10:00:00Z');const contracts=[19800,19900,20000,20100].flatMap((strike)=>['CE','PE'].map((optionType)=>({instrumentKey:`${strike}-${optionType}`,tradingSymbol:'x',underlying:'NIFTY 50',strikePrice:strike,expiry,optionType:optionType as 'CE'|'PE',exchange:'NSE',segment:'NSE_FO'})));const universe=resolveV12OptionUniverse(contracts,20020,new Date('2026-08-14T06:00:00Z'));assert.ok(universe);assert.equal(universe?.atmStrike,20000);assert.equal(universe?.contracts.length,6);});
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
test('V12 redacts bearer tokens from strings and structured errors',()=>{const redacted=redactSensitiveText({Authorization:'Bearer secret-token',message:'Authorization: Bearer abc.def'});assert.equal((redacted as any).Authorization,'[REDACTED]');assert.ok(!(redacted as any).message.includes('abc.def'));});
