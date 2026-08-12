import assert from 'node:assert/strict';
import test from 'node:test';
import { AdaptivePrimaryMarketRegime } from '../modules/adaptive-intraday/types/adaptive-market-regime.types';
import { Candle } from '../modules/indicators/types';
import { CrossSessionPreparedSession } from './helpers/cross-session-indicator-warmup';
import { assertV7NoLookAhead, buildV7OptionPremiumFeatures, collectV7UnderlyingImpulseCandidates, createV7OptionImpulseConfigs, featureKey, generateV7Signals, V7IndicatorContext, V7OptionImpulseConfig, V7OptionPremiumFeature } from './helpers/v7-option-premium-impulse-signal-generation';

const base = new Date('2026-07-14T03:45:00.000Z');
const config = (direction: 'CE' | 'PE', overrides: Partial<V7OptionImpulseConfig> = {}): V7OptionImpulseConfig => ({ ...createV7OptionImpulseConfigs().find((value) => value.direction === direction && value.timeframe === 1 && value.underlying.id.startsWith('0.5ATR_1BAR_NO') && value.premium.id === 'RETURN_0.5' && value.minimumPremium === 50 && value.cooldownMinutes === 0)!, ...overrides });

test('V7 uses completed 1m / 2m underlying candles, ATR body and 1/2/3 bar breakout only', () => {
  const candles = [candle(0,100,100.2,99.8,100), candle(1,100,102,100,101.5), candle(2,101.5,104,101.4,103.5), candle(3,103.5,106,103,105.5)];
  const values = context(candles, 1); const one = generateV7Signals([session(candles)], config('CE'), values, features('CE', candles[1].timestamp.getTime()+60_000));
  assert.equal(one[0]?.timestamp.getTime(), candles[1].timestamp.getTime()+60_000);
  const two = generateV7Signals([session(candles, [candles[0], candles[2]])], { ...config('CE'), timeframe: 2 }, context(candles, 1), features('CE', candles[2].timestamp.getTime()+120_000));
  assert.equal(two[0]?.timestamp.getTime(), candles[2].timestamp.getTime()+120_000);
  assertV7NoLookAhead([...one, ...two]);
});

test('V7 maps CE bullish and PE bearish impulses symmetrically and keeps cooldown state independent', () => {
  const bullish = [candle(0,100,100.2,99.8,100), candle(1,100,102,100,101.5), candle(2,101.5,103,101.5,102.8)];
  const bearish = [candle(0,100,100.2,99.8,100), candle(1,100,100,98,98.5), candle(2,98.5,98.5,97,97.2)];
  assert.equal(generateV7Signals([session(bullish)], config('CE'), context(bullish,1), features('CE',bullish[1].timestamp.getTime()+60_000)).length,1);
  assert.equal(generateV7Signals([session(bearish)], config('PE'), context(bearish,1), features('PE',bearish[1].timestamp.getTime()+60_000)).length,1);
  assert.equal(collectV7UnderlyingImpulseCandidates([session([...bullish,...bearish])],context([...bullish,...bearish],1)).length > 0,true);
});

test('direction-aligned regime blocks SIDEWAYS / opposing regimes while no-regime family allows SIDEWAYS', () => {
  const candles=[candle(0,100,100.2,99.8,100),candle(1,100,102,100,101.5)]; const time=candles[1].timestamp.getTime()+60_000;
  assert.equal(generateV7Signals([session(candles,undefined,AdaptivePrimaryMarketRegime.SIDEWAYS)],config('CE'),context(candles,1),features('CE',time)).length,1);
  const aligned={...config('CE'),underlying:{...config('CE').underlying,regimeFamily:'DIRECTION_ALIGNED_REGIME' as const}};
  assert.equal(generateV7Signals([session(candles,undefined,AdaptivePrimaryMarketRegime.SIDEWAYS)],aligned,context(candles,1),features('CE',time)).length,0);
  assert.equal(generateV7Signals([session(candles,undefined,AdaptivePrimaryMarketRegime.TREND_UP)],aligned,context(candles,1),features('CE',time)).length,1);
});

test('premium return, option ATR body, option 1/2/3-high breakouts, price floors and confirmation families gate entries', () => {
  const candles=[candle(0,100,100.2,99.8,100),candle(1,100,102,100,101.5),candle(2,101.5,104,101.5,103.5),candle(3,103.5,106,103.5,105.5)]; const time=candles[3].timestamp.getTime()+60_000;
  const rich={...feature('CE',time),close:125,returnPercent:2,bodyAtr:1,breakout1:true,breakout2:true,breakout3:true};
  const map=new Map([[featureKey('CE',time),rich]]);
  const all=createV7OptionImpulseConfigs();
  for(const family of ['RETURN_ONLY','BODY_AND_RETURN','BREAKOUT_AND_RETURN','BODY_BREAKOUT_AND_RETURN'] as const){const candidate=all.find((value)=>value.direction==='CE'&&value.timeframe===1&&value.premium.confirmation===family&&value.minimumPremium===50&&value.cooldownMinutes===0)!;assert.equal(generateV7Signals([session(candles)],candidate,context(candles,1),map).length>0,true);}
  assert.equal(generateV7Signals([session(candles)],{...config('CE'),minimumPremium:125},context(candles,1),map).length>0,true);
  assert.equal(generateV7Signals([session(candles)],{...config('CE'),minimumPremium:125},context(candles,1),new Map([[featureKey('CE',time),{...rich,close:124.99}]])).length,0);
});

test('premium availability after the signal is rejected and same-episode/cooldown duplicate suppression is deterministic', () => {
  const candles=[candle(0,100,100.2,99.8,100),candle(1,100,102,100,101.5),candle(2,101.5,104,101.5,103.5),candle(3,103.5,106,103.5,105.5)]; const first=candles[1].timestamp.getTime()+60_000; const future={...feature('CE',first),availableAt:new Date(first+1)};
  assert.equal(generateV7Signals([session(candles)],config('CE'),context(candles,1),new Map([[featureKey('CE',first),future]])).length,0);
  const map=features('CE',first,candles[2].timestamp.getTime()+60_000,candles[3].timestamp.getTime()+60_000);
  assert.equal(generateV7Signals([session(candles)],{...config('CE'),cooldownMinutes:5},context(candles,1),map).length,1);
});

function candle(offset:number,open:number,high:number,low:number,close:number):Candle{return{timestamp:new Date(base.getTime()+offset*60_000),open,high,low,close,volume:1};}
function context(candles:readonly Candle[],atr:number):V7IndicatorContext{const values=new Map(candles.map((value)=>[value.timestamp.getTime(),atr] as const));return{byTimeframe:new Map([[1,new Map([['2026-07-14',{atr14:values}]])],[2,new Map([['2026-07-14',{atr14:values}]])]])};}
function session(candles:readonly Candle[],two:readonly Candle[]=candles,regime:AdaptivePrimaryMarketRegime=AdaptivePrimaryMarketRegime.TREND_UP):CrossSessionPreparedSession{return{date:'2026-07-14',oneMinute:[...candles],frames:{1:frame(1,candles),2:frame(2,two),3:frame(3,candles),5:frame(5,candles)},regimePoints:[{availableAt:base,regime}],readiness:{at0915:true,at0920:true,at0930:true}};}
function frame(minutes:1|2|3|5,candles:readonly Candle[]){return{minutes,candles:[...candles],allCandles:[...candles],ema15:new Map(),ema35:new Map(),rsi14:new Map()};}
function feature(direction:'CE'|'PE',time:number):V7OptionPremiumFeature{return{instrumentKey:`${direction}_OPTION`,tradingDate:'2026-07-14',candleStartedAt:new Date(time-60_000),availableAt:new Date(time),close:120,returnPercent:2,atr14:1,bodyAtr:1,breakout1:true,breakout2:true,breakout3:true};}
function features(direction:'CE'|'PE',...times:number[]){return new Map(times.map((time)=>[featureKey(direction,time),feature(direction,time)]));}
