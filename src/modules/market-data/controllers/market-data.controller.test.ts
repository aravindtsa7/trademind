import assert from 'node:assert/strict';
import test from 'node:test';
import { Response } from 'express';
import eventBus from '../../../core/events';
import MarketDataController from './market-data.controller';
import { MarketTickEvent } from '../processors/tick.processor';

function fakeResponse(): { res: Response; payload: () => unknown } {
  let captured: unknown;
  const res = { status: () => ({ json: (body: unknown) => { captured = body; return res; } }) } as unknown as Response;
  return { res, payload: () => captured };
}

test('lastReceivedTickTimestamp reflects local receive time, not the tick source timestamp', () => {
  const controller = new MarketDataController();
  const sourceTimestamp = '1999-01-01T00:00:00.000Z'; // deliberately far from "now" so the two can never be mistaken for each other
  const before = Date.now();
  eventBus.emit('market.tick', { instrumentKey: 'NSE_INDEX|Nifty 50', timestamp: sourceTimestamp, ltp: 100 } as MarketTickEvent);
  const after = Date.now();

  const { res, payload } = fakeResponse();
  controller.status({} as never, res, (() => undefined) as never);
  const body = payload() as { data: { lastReceivedTickTimestamp: string | null } };

  assert.notEqual(body.data.lastReceivedTickTimestamp, sourceTimestamp);
  const observedMs = new Date(body.data.lastReceivedTickTimestamp as string).getTime();
  assert.ok(observedMs >= before && observedMs <= after, `expected ${observedMs} to fall within [${before}, ${after}]`);
});
