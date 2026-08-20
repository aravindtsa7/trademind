import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveGenerationCacheScope } from './live-generation-cache';

test('generation-scoped quote state never merges a prior generation book into a current tick', () => {
  const scope = new LiveGenerationCacheScope();
  const quote = new Map<string, { ltp?: number; bid?: number; ask?: number }>();
  const accept = (generationId: unknown, activeGenerationId: unknown) => scope.accept(generationId, activeGenerationId, () => quote.clear());
  assert.equal(accept(7, 7), true);
  quote.set('CE', { bid: 99, ask: 101 });
  assert.equal(accept(8, 8), true);
  quote.set('CE', { ...(quote.get('CE') ?? {}), ltp: 100 });
  assert.deepEqual(quote.get('CE'), { ltp: 100 });
});

test('generation-scoped quote state never merges a prior generation LTP into current depth, while same-generation updates merge', () => {
  const scope = new LiveGenerationCacheScope();
  const quote = new Map<string, { ltp?: number; bid?: number; ask?: number }>();
  const accept = (generationId: unknown, activeGenerationId: unknown) => scope.accept(generationId, activeGenerationId, () => quote.clear());
  assert.equal(accept(7, 7), true);
  quote.set('CE', { ltp: 100 });
  assert.equal(accept(8, 8), true);
  quote.set('CE', { ...(quote.get('CE') ?? {}), bid: 98, ask: 102 });
  assert.deepEqual(quote.get('CE'), { bid: 98, ask: 102 });
  assert.equal(accept(8, 8), true);
  quote.set('CE', { ...(quote.get('CE') ?? {}), ltp: 101 });
  assert.deepEqual(quote.get('CE'), { ltp: 101, bid: 98, ask: 102 });
});

test('generation rotation atomically clears V12-owned tick, book and cross-option caches before N+1 reads them', () => {
  const scope = new LiveGenerationCacheScope();
  const ticks = new Map([['NIFTY', { ltp: 24_000 }]]);
  const books = new Map([['CE', { count: 4, ltp: 100 }]]);
  const options = new Map([['CE', { strike: 24_000 }]]);
  const accept = (generationId: unknown, activeGenerationId: unknown) => scope.accept(generationId, activeGenerationId, () => {
    ticks.clear(); books.clear(); options.clear();
  });
  assert.equal(accept(7, 7), true);
  assert.equal(accept(8, 8), true);
  assert.equal(ticks.get('NIFTY'), undefined);
  assert.equal(books.get('CE'), undefined);
  assert.equal(options.get('CE'), undefined);
  ticks.set('NIFTY', { ltp: 24_100 }); books.set('CE', { count: 1, ltp: 101 }); options.set('CE', { strike: 24_050 });
  assert.equal(accept(8, 8), true);
  assert.equal(ticks.get('NIFTY')?.ltp, 24_100);
  assert.equal(books.get('CE')?.count, 1);
  assert.equal(options.get('CE')?.strike, 24_050);
});
