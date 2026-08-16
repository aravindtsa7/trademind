import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import RuntimeRiskGateService from './runtime-risk-gate.service';

const at = new Date('2026-08-17T04:00:00.000Z');
const base = (overrides: Record<string, unknown> = {}) => ({ runtimeId:'paper:v2',strategyId:'V2_TREND_DOWN_PE',sessionDate:'2026-08-17',timestamp:at,instrument:'NSE_FO|1|17-08-2026',underlying:'NIFTY 50',side:'BUY_PE' as const,action:'OPEN' as const,entryPremium:100,quantity:50,marketDataState:'READY',sessionTradable:true,quote:{ltp:100,bid:99.5,ask:100.5,ageMs:100},...overrides });
const gate = (overrides: ConstructorParameters<typeof RuntimeRiskGateService>[0] = {}) => new RuntimeRiskGateService({persist:false,killSwitch:false,now:()=>at,getOpenPositions:()=>[],...overrides});

test('kill switch, non-ready data, missing or stale quote all deny with explicit reasons',()=>{
  assert.deepEqual(gate({killSwitch:true}).evaluate(base()).denialReasons,['KILL_SWITCH_ACTIVE']);
  assert.ok(gate().evaluate(base({marketDataState:'DEGRADED'})).denialReasons.includes('MARKET_DATA_NOT_READY'));
  assert.ok(gate().evaluate(base({quote:undefined})).denialReasons.includes('QUOTE_UNAVAILABLE'));
  assert.ok(gate().evaluate(base({quote:{ltp:100,bid:99,ask:101,ageMs:2001}})).denialReasons.includes('STALE_QUOTE'));
});
test('ready state with a fresh quote approves once and duplicate intent is denied',()=>{
  const risk=gate(); assert.equal(risk.evaluate(base()).decision,'APPROVED'); assert.ok(risk.evaluate(base()).denialReasons.includes('DUPLICATE_INTENT'));
});
test('positions, exposure and daily loss are independent outer limits',()=>{
  assert.ok(gate({getOpenPositions:()=>[{strategyId:'V2_TREND_DOWN_PE',underlying:'NIFTY 50',notional:1}]}).evaluate(base()).denialReasons.includes('MAX_OPEN_POSITIONS'));
  assert.ok(gate({maxTotalNotional:4_000}).evaluate(base()).denialReasons.includes('MAX_TOTAL_EXPOSURE'));
  const risk=gate({dailyLossLimit:100});risk.recordRealizedPnl('2026-08-17',-100);assert.ok(risk.evaluate(base()).denialReasons.includes('DAILY_LOSS_LIMIT'));
});
test('halted state blocks new entries but allows a close intent and a new session starts with no carried loss',()=>{
  const risk=gate({dailyLossLimit:100});risk.recordRealizedPnl('2026-08-17',-100);risk.transition('HALTED');assert.equal(risk.evaluate(base({action:'CLOSE'})).decision,'APPROVED');
  const active=gate({dailyLossLimit:100});active.recordRealizedPnl('2026-08-17',-100);assert.equal(active.evaluate(base({sessionDate:'2026-08-18',timestamp:new Date('2026-08-18T04:00:00.000Z')})).decision,'APPROVED');
});
test('bad state, pre-session and EOD fail closed',()=>{
  assert.ok(gate({getOpenPositions:()=>undefined}).evaluate(base()).denialReasons.includes('UNKNOWN_RISK_STATE'));
  assert.ok(gate().evaluate(base({timestamp:new Date('2026-08-17T03:30:00.000Z')})).denialReasons.includes('SESSION_NOT_TRADABLE'));
  assert.ok(gate().evaluate(base({timestamp:new Date('2026-08-17T10:00:00.000Z')})).denialReasons.includes('EOD_BLOCK'));
});
test('restart reloads realized P&L and fails closed for an unresolved persisted paper order',()=>{
  const root=mkdtempSync(join(tmpdir(),'trademind-risk-')); const first=gate({persist:true,artifactRoot:root}); const approved=first.evaluate(base()); assert.equal(approved.decision,'APPROVED'); first.recordOpenedOrder(approved,'paper-1'); first.recordRealizedPnl('2026-08-17',-200);
  const restarted=gate({persist:true,artifactRoot:root,dailyLossLimit:100}); const decision=restarted.evaluate(base({instrument:'NSE_FO|2|17-08-2026'})); assert.ok(decision.denialReasons.includes('UNKNOWN_RISK_STATE')); assert.ok(decision.denialReasons.includes('DAILY_LOSS_LIMIT'));
});
