import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionQuoteSnapshot } from '../dto/paper-fill-model.dto';
import PaperFillModelService from './paper-fill-model.service';

const at = new Date('2026-08-17T04:00:00.000Z');
function quote(overrides: Partial<ExecutionQuoteSnapshot> = {}): ExecutionQuoteSnapshot {
  return { instrumentKey:'NSE_FO|1', sourceTimestamp:at.toISOString(), receivedTimestamp:at.toISOString(), quoteAgeMs:10, ltp:100, bestBid:99, bestAsk:101, bidSize:null, askSize:null, depthLevels:[], spreadAbsolute:2, spreadPercent:2, connectionGenerationId:1, dataQuality:'FRESH_TOP_OF_BOOK', ...overrides };
}
function fill(side: 'BUY'|'SELL', requestedQuantity = 1, input = quote(), options = {}) { return new PaperFillModelService(options).fill({ side, requestedQuantity, quote:input, intentTimestamp:at }); }

test('long entry starts from ASK and long exit starts from BID, never LTP', () => {
  const entry = fill('BUY'); const exit = fill('SELL');
  assert.equal(entry.averageFillPrice, 101); assert.equal(exit.averageFillPrice, 99);
  assert.notEqual(entry.averageFillPrice, entry.quote.ltp); assert.notEqual(exit.averageFillPrice, exit.quote.ltp);
});

test('fresh depth consumes correct levels with deterministic VWAP and partial results', () => {
  const depth = quote({ dataQuality:'FRESH_DEPTH', depthLevels:[{ ask:101, askSize:5, bid:99, bidSize:4 }, { ask:102, askSize:5, bid:98, bidSize:6 }], askSize:5, bidSize:4 });
  const complete = fill('BUY', 8, depth); assert.equal(complete.status, 'FILLED'); assert.equal(complete.averageFillPrice, 101.375); assert.deepEqual(complete.levelsConsumed.map((level) => level.quantity), [5,3]);
  const partial = fill('BUY', 12, depth); assert.equal(partial.status, 'PARTIALLY_FILLED'); assert.equal(partial.filledQuantity, 10); assert.equal(partial.remainingQuantity, 2); assert.equal(partial.reason, 'INSUFFICIENT_DEPTH');
});

test('top of book is explicitly estimated and LTP-only is rejected unless diagnostic fallback is enabled', () => {
  assert.equal(fill('BUY', 3).fillQuality, 'TOP_OF_BOOK_ESTIMATE');
  const ltpOnly = quote({ bestBid:null, bestAsk:null, spreadAbsolute:null, spreadPercent:null, dataQuality:'LTP_ONLY' });
  assert.equal(fill('BUY', 1, ltpOnly).reason, 'LTP_FALLBACK_DISABLED');
  const diagnostic = fill('BUY', 1, ltpOnly, { allowLtpFallback:true }); assert.equal(diagnostic.status, 'FILLED'); assert.equal(diagnostic.fillQuality, 'LTP_ONLY_ESTIMATE');
});

test('stale, crossed, wide-spread and invalid quotes fail closed', () => {
  assert.equal(fill('BUY', 1, quote({ dataQuality:'STALE', quoteAgeMs:3000 })).reason, 'STALE_QUOTE');
  assert.equal(fill('BUY', 1, quote({ dataQuality:'CROSSED', bestBid:101, bestAsk:100 })).reason, 'CROSSED_MARKET');
  assert.equal(fill('BUY', 1, quote({ spreadPercent:6 }), { maxSpreadPercent:5 }).reason, 'REJECTED_WIDE_SPREAD');
  assert.equal(fill('BUY', 1, quote({ bestAsk:0, dataQuality:'EMPTY' })).reason, 'EMPTY_QUOTE');
});

test('the executable freshness threshold is inclusive at 2000ms and fails closed immediately after', () => {
  assert.equal(fill('BUY', 1, quote({ quoteAgeMs:2_000 }), { maxQuoteAgeMs:2_000 }).status, 'FILLED');
  assert.equal(fill('BUY', 1, quote({ quoteAgeMs:2_001 }), { maxQuoteAgeMs:2_000 }).reason, 'STALE_QUOTE');
});

test('latency accepts only the first quote at or after deterministic eligibility', () => {
  const model = new PaperFillModelService({ executionLatencyMs:500 });
  assert.equal(model.fill({ side:'BUY', requestedQuantity:1, quote:quote(), intentTimestamp:at }).reason, 'LATENCY_NOT_ELIGIBLE');
  const later = quote({ sourceTimestamp:new Date(at.getTime() + 500).toISOString() });
  assert.equal(model.fill({ side:'BUY', requestedQuantity:1, quote:later, intentTimestamp:at }).status, 'FILLED');
});

test('entry and exit measured friction are explicit and additive', () => {
  const entry = fill('BUY'); const exit = fill('SELL');
  assert.equal(entry.totalExecutionSlippage, 1); assert.equal(exit.totalExecutionSlippage, 1);
  assert.equal((entry.totalExecutionSlippage ?? 0) + (exit.totalExecutionSlippage ?? 0), 2);
});

test('matching active generation preserves normal fill behavior', () => {
  const result = new PaperFillModelService().fill({ side:'BUY', requestedQuantity:1, quote:quote({ connectionGenerationId:5 }), intentTimestamp:at, activeGenerationId:5 });
  assert.equal(result.status, 'FILLED'); assert.equal(result.averageFillPrice, 101); assert.equal(result.reason, undefined);
});

test('a rotated active generation denies the fill with an explicit reason and no fabricated price', () => {
  const result = new PaperFillModelService().fill({ side:'BUY', requestedQuantity:1, quote:quote({ connectionGenerationId:5 }), intentTimestamp:at, activeGenerationId:6 });
  assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.reason, 'GENERATION_MISMATCH'); assert.equal(result.averageFillPrice, null); assert.equal(result.filledQuantity, 0);
});

test('missing, null or non-positive quote/active generation fails closed once generation validation is requested', () => {
  assert.equal(new PaperFillModelService().fill({ side:'BUY', requestedQuantity:1, quote:quote({ connectionGenerationId:null }), intentTimestamp:at, activeGenerationId:5 }).reason, 'GENERATION_MISMATCH');
  assert.equal(new PaperFillModelService().fill({ side:'BUY', requestedQuantity:1, quote:quote({ connectionGenerationId:undefined }), intentTimestamp:at, activeGenerationId:5 }).reason, 'GENERATION_MISMATCH');
  assert.equal(new PaperFillModelService().fill({ side:'BUY', requestedQuantity:1, quote:quote({ connectionGenerationId:0 }), intentTimestamp:at, activeGenerationId:0 }).reason, 'GENERATION_MISMATCH');
  assert.equal(new PaperFillModelService().fill({ side:'BUY', requestedQuantity:1, quote:quote({ connectionGenerationId:-1 }), intentTimestamp:at, activeGenerationId:-1 }).reason, 'GENERATION_MISMATCH');
});

test('generation validation is skipped when the caller supplies no active generation, preserving replay/backtest behavior', () => {
  const result = new PaperFillModelService().fill({ side:'BUY', requestedQuantity:1, quote:quote({ connectionGenerationId:null }), intentTimestamp:at });
  assert.equal(result.status, 'FILLED'); assert.equal(result.reason, undefined);
});

test('a matched active generation still applies BUY/SELL pricing, stale/crossed/wide-spread/LTP-fallback rules and partial fills unchanged', () => {
  const buy = fill('BUY', 1, quote({ connectionGenerationId:5 }), {}); const sell = fill('SELL', 1, quote({ connectionGenerationId:5 }), {});
  const buyGen = new PaperFillModelService().fill({ side:'BUY', requestedQuantity:1, quote:quote({ connectionGenerationId:5 }), intentTimestamp:at, activeGenerationId:5 });
  const sellGen = new PaperFillModelService().fill({ side:'SELL', requestedQuantity:1, quote:quote({ connectionGenerationId:5 }), intentTimestamp:at, activeGenerationId:5 });
  assert.equal(buyGen.averageFillPrice, buy.averageFillPrice); assert.equal(sellGen.averageFillPrice, sell.averageFillPrice);

  const stale = new PaperFillModelService().fill({ side:'BUY', requestedQuantity:1, quote:quote({ connectionGenerationId:5, dataQuality:'STALE', quoteAgeMs:3000 }), intentTimestamp:at, activeGenerationId:5 });
  assert.equal(stale.reason, 'STALE_QUOTE');
  const crossed = new PaperFillModelService().fill({ side:'BUY', requestedQuantity:1, quote:quote({ connectionGenerationId:5, dataQuality:'CROSSED', bestBid:101, bestAsk:100 }), intentTimestamp:at, activeGenerationId:5 });
  assert.equal(crossed.reason, 'CROSSED_MARKET');
  const wideSpread = new PaperFillModelService({ maxSpreadPercent:5 }).fill({ side:'BUY', requestedQuantity:1, quote:quote({ connectionGenerationId:5, spreadPercent:6 }), intentTimestamp:at, activeGenerationId:5 });
  assert.equal(wideSpread.reason, 'REJECTED_WIDE_SPREAD');
  const ltpOnly = quote({ connectionGenerationId:5, bestBid:null, bestAsk:null, spreadAbsolute:null, spreadPercent:null, dataQuality:'LTP_ONLY' });
  const ltpDisabled = new PaperFillModelService().fill({ side:'BUY', requestedQuantity:1, quote:ltpOnly, intentTimestamp:at, activeGenerationId:5 });
  assert.equal(ltpDisabled.reason, 'LTP_FALLBACK_DISABLED');
  const ltpAllowed = new PaperFillModelService({ allowLtpFallback:true }).fill({ side:'BUY', requestedQuantity:1, quote:ltpOnly, intentTimestamp:at, activeGenerationId:5 });
  assert.equal(ltpAllowed.fillQuality, 'LTP_ONLY_ESTIMATE');

  const depth = quote({ connectionGenerationId:5, dataQuality:'FRESH_DEPTH', depthLevels:[{ ask:101, askSize:5, bid:99, bidSize:4 }, { ask:102, askSize:5, bid:98, bidSize:6 }], askSize:5, bidSize:4 });
  const partial = new PaperFillModelService().fill({ side:'BUY', requestedQuantity:12, quote:depth, intentTimestamp:at, activeGenerationId:5 });
  assert.equal(partial.status, 'PARTIALLY_FILLED'); assert.equal(partial.filledQuantity, 10); assert.equal(partial.remainingQuantity, 2); assert.equal(partial.reason, 'INSUFFICIENT_DEPTH');
});
