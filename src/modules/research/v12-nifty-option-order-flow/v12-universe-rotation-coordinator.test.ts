import assert from 'node:assert/strict';
import test from 'node:test';
import { V12UniverseContract } from './option-universe';
import { V12UniverseRotationCoordinator } from './v12-universe-rotation-coordinator';

function contracts(): V12UniverseContract[] {
  return [90,100,110,190,200,210].flatMap((strike) => (['CE','PE'] as const).map((optionType) => ({
    instrumentKey:`NSE_FO|${strike}${optionType}`, tradingSymbol:`${strike}${optionType}`, underlying:'NIFTY',
    strikePrice:strike, expiry:new Date('2026-08-27T00:00:00.000Z'), optionType, exchange:'NSE', segment:'NSE_FO',
  })));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise:new Promise<void>((done) => { resolve=done; }), resolve };
}

test('a pending G1 subscription cannot commit after G2 and the G2 request is not dropped', async () => {
  let activeGeneration = 1; const subscribed = new Set<string>(); const waits: ReturnType<typeof deferred>[] = []; const calls: string[][] = []; let commits = 0; let secondStarted!: () => void; const secondSubscriptionStarted=new Promise<void>((resolve)=>{secondStarted=resolve;});
  const coordinator = new V12UniverseRotationCoordinator({
    contracts:contracts(), getActiveGenerationId:()=>activeGeneration, getSubscribedOptionKeys:()=>[...subscribed],
    subscribeMany:async(keys)=>{calls.push([...keys]);keys.forEach((key)=>subscribed.add(key));const wait=deferred();waits.push(wait);if(calls.length===2)secondStarted();await wait.promise;},
    unsubscribeMany:(keys)=>keys.forEach((key)=>subscribed.delete(key)), onCommitted:()=>{commits++;},
  });
  const first = coordinator.request(100,new Date('2026-08-20T04:00:00.000Z'),1);
  assert.equal(calls.length,1);
  activeGeneration=2; assert.equal(coordinator.beginGeneration(2),true);
  const second = coordinator.request(200,new Date('2026-08-20T04:01:00.000Z'),2);
  assert.equal(coordinator.snapshot().optionKeys.size,0);
  waits[0].resolve(); await secondSubscriptionStarted;
  assert.equal(commits,0); assert.equal(calls.length,2);
  assert.ok(calls[1].every((key)=>key.includes('190')||key.includes('200')||key.includes('210')));
  waits[1].resolve(); await Promise.all([first,second]);
  const state=coordinator.snapshot();
  assert.equal(state.generationId,2);assert.equal(state.atmStrike,200);assert.equal(commits,1);
  assert.deepEqual([...state.optionKeys].sort(),['NSE_FO|190CE','NSE_FO|190PE','NSE_FO|200CE','NSE_FO|200PE','NSE_FO|210CE','NSE_FO|210PE']);
  assert.deepEqual([...subscribed].sort(),[...state.optionKeys].sort());
});

test('a late G1 request cannot roll back or clear a completed G2 universe', async () => {
  const activeGeneration=2;const subscribed=new Set<string>();
  const coordinator=new V12UniverseRotationCoordinator({contracts:contracts(),getActiveGenerationId:()=>activeGeneration,getSubscribedOptionKeys:()=>[...subscribed],subscribeMany:async(keys)=>keys.forEach((key)=>subscribed.add(key)),unsubscribeMany:(keys)=>keys.forEach((key)=>subscribed.delete(key))});
  await coordinator.request(200,new Date('2026-08-20T04:01:00.000Z'),2);
  const before=coordinator.snapshot();
  await coordinator.request(100,new Date('2026-08-20T04:02:00.000Z'),1);
  const after=coordinator.snapshot();
  assert.equal(after.generationId,2);assert.equal(after.universeIdentity,before.universeIdentity);assert.deepEqual([...after.optionKeys],[...before.optionKeys]);
});

test('same-generation rotation retains deterministic subscription delta behavior', async () => {
  const activeGeneration=3;const subscribed=new Set<string>();const added:string[][]=[];const removed:string[][]=[];
  const coordinator=new V12UniverseRotationCoordinator({contracts:contracts(),getActiveGenerationId:()=>activeGeneration,getSubscribedOptionKeys:()=>[...subscribed],subscribeMany:async(keys)=>{added.push([...keys]);keys.forEach((key)=>subscribed.add(key));},unsubscribeMany:(keys)=>{removed.push([...keys]);keys.forEach((key)=>subscribed.delete(key));}});
  await coordinator.request(100,new Date('2026-08-20T04:00:00.000Z'),3);
  await coordinator.request(200,new Date('2026-08-20T04:01:00.000Z'),3);
  assert.equal(coordinator.getAtmStrike(),200);assert.equal(added.length,2);assert.equal(removed.length,1);assert.equal(removed[0].length,6);
});
