import assert from 'node:assert/strict';
import test from 'node:test';
import { Exchange, ExchangeSegment } from '../domain';
import { determineNiftyIngestionPlanCliExitCode } from './nifty-ingestion-plan-cli-exit-policy.util';
import { NiftyIngestionPlan } from './nifty-underlying-ingestion-planner.service';

function fakePlan(overrides: Partial<NiftyIngestionPlan> = {}): NiftyIngestionPlan {
  return {
    instrumentKey: 'NSE_INDEX|Nifty 50',
    exchange: Exchange.NSE,
    calendarSegment: ExchangeSegment.EQUITY,
    requestedFromDate: '2031-01-01',
    requestedToDate: '2031-01-01',
    dates: [],
    providerRequestChunks: [],
    totalCalendarDateCount: 0,
    totalExpectedCandles: 0,
    regularTradingDateCount: 0,
    specialSessionDateCount: 0,
    closedDateCount: 0,
    blockedDateCount: 0,
    hasBlockedDates: false,
    ...overrides,
  };
}

test('a plan with no blocked dates exits 0', () => {
  assert.equal(determineNiftyIngestionPlanCliExitCode(fakePlan({ hasBlockedDates: false, blockedDateCount: 0 })), 0);
});

test('a plan with any blocked (UNCERTIFIED) date exits non-zero, even if most dates resolved fine', () => {
  assert.equal(
    determineNiftyIngestionPlanCliExitCode(fakePlan({ hasBlockedDates: true, blockedDateCount: 1, regularTradingDateCount: 200 })),
    1
  );
});

test('never reports success merely because the plan otherwise looks large/healthy', () => {
  const plan = fakePlan({ hasBlockedDates: true, blockedDateCount: 3, totalCalendarDateCount: 400, regularTradingDateCount: 397 });
  assert.equal(determineNiftyIngestionPlanCliExitCode(plan), 1);
});
