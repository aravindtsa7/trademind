import { createHash, randomUUID } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { isAtOrAfterIstSessionEnd, isWithinIstMarketSession } from '../market-data/services/ist-market-session-eod.service';

export type RiskDecisionType = 'APPROVED' | 'DENIED';
export type RiskTradingState = 'ACTIVE' | 'HALTED' | 'REDUCING';
export type RiskDenialReason = 'KILL_SWITCH_ACTIVE'|'MARKET_DATA_NOT_READY'|'STALE_QUOTE'|'QUOTE_UNAVAILABLE'|'DAILY_LOSS_LIMIT'|'MAX_OPEN_POSITIONS'|'MAX_TOTAL_EXPOSURE'|'MAX_STRATEGY_EXPOSURE'|'DUPLICATE_INTENT'|'COOLDOWN_OR_RATE_LIMIT'|'SESSION_NOT_TRADABLE'|'EOD_BLOCK'|'RUNTIME_DEGRADED'|'UNKNOWN_RISK_STATE';

export interface RuntimeRiskQuote { ltp?: number | null; bid?: number | null; ask?: number | null; ageMs?: number | null; crossed?: boolean; }
export interface RuntimeRiskPosition { strategyId: string; underlying: string; notional: number; }
export interface RuntimeRiskIntent {
  runtimeId: string; strategyId: string; sessionDate: string; timestamp: Date; instrument: string; underlying: string;
  side: 'BUY_CE' | 'BUY_PE'; action: 'OPEN' | 'CLOSE'; entryPremium: number; quantity: number;
  marketDataState?: string; sessionTradable?: boolean; quote?: RuntimeRiskQuote; correlationId?: string;
}
export interface RiskDecision { decisionId: string; runtimeId: string; strategyId: string; sessionDate: string; timestamp: string; instrument: string; intentId: string; decision: RiskDecisionType; denialReasons: RiskDenialReason[]; riskSnapshot: Record<string, unknown>; correlationId: string; }
export interface RuntimeRiskGateOptions {
  killSwitch?: boolean; requireFreshQuote?: boolean; maxQuoteAgeMs?: number; maxOpenPositions?: number; maxOpenPositionsPerStrategy?: number; maxOpenPositionsPerUnderlying?: number; maxTotalNotional?: number; maxStrategyNotional?: number; dailyLossLimit?: number; artifactRoot?: string; persist?: boolean; now?: () => Date; getOpenPositions?: () => readonly RuntimeRiskPosition[] | undefined;
}

/** Fail-closed boundary for intent-to-execution. It has no broker capability. */
export default class RuntimeRiskGateService {
  private state: RiskTradingState = 'ACTIVE'; private readonly approvedIds = new Set<string>(); private readonly realizedPnl = new Map<string, number>(); private readonly openedOrderIds = new Map<string, Set<string>>();
  private readonly configuredKillSwitch: boolean | undefined;
  private readonly options: Required<Omit<RuntimeRiskGateOptions, 'getOpenPositions'>> & Pick<RuntimeRiskGateOptions, 'getOpenPositions'>;
  constructor(options: RuntimeRiskGateOptions = {}) {
    this.configuredKillSwitch = options.killSwitch;
    this.options = { killSwitch: options.killSwitch ?? process.env.TRADING_KILL_SWITCH !== 'false', requireFreshQuote: options.requireFreshQuote ?? process.env.RISK_REQUIRE_FRESH_OPTION_QUOTE !== 'false', maxQuoteAgeMs: options.maxQuoteAgeMs ?? Number(process.env.RISK_MAX_QUOTE_AGE_MS ?? 2_000), maxOpenPositions: options.maxOpenPositions ?? Number(process.env.RISK_MAX_OPEN_POSITIONS ?? 1), maxOpenPositionsPerStrategy: options.maxOpenPositionsPerStrategy ?? Number(process.env.RISK_MAX_OPEN_POSITIONS_PER_STRATEGY ?? 1), maxOpenPositionsPerUnderlying: options.maxOpenPositionsPerUnderlying ?? Number(process.env.RISK_MAX_OPEN_POSITIONS_PER_UNDERLYING ?? 1), maxTotalNotional: options.maxTotalNotional ?? Number(process.env.RISK_MAX_TOTAL_NOTIONAL ?? 100_000), maxStrategyNotional: options.maxStrategyNotional ?? Number(process.env.RISK_MAX_STRATEGY_NOTIONAL ?? 100_000), dailyLossLimit: options.dailyLossLimit ?? Number(process.env.RISK_DAILY_LOSS_LIMIT ?? 5_000), artifactRoot: options.artifactRoot ?? 'artifacts/runtime-risk', persist: options.persist ?? true, now: options.now ?? (() => new Date()), getOpenPositions: options.getOpenPositions };
  }
  static intentId(intent: Pick<RuntimeRiskIntent, 'strategyId'|'timestamp'|'instrument'|'side'|'sessionDate'>): string { return createHash('sha256').update([intent.strategyId, intent.timestamp.toISOString(), intent.instrument, intent.side, intent.sessionDate].join('|')).digest('hex').slice(0, 24); }
  getTradingState(): RiskTradingState { return this.state; }
  isKillSwitchActive(): boolean { return this.configuredKillSwitch ?? process.env.TRADING_KILL_SWITCH !== 'false'; }
  transition(next: RiskTradingState): void { this.state = next; }
  recordRealizedPnl(sessionDate: string, pnl: number): void { if (!Number.isFinite(pnl)) return; this.realizedPnl.set(sessionDate, this.sessionPnl(sessionDate) + pnl); this.persistEvent(sessionDate, { recordType:'REALIZED_PNL', pnl }); }
  recordOpenedOrder(decision: RiskDecision, orderId: string): void { if (!orderId) return; const ids=this.openedOrderIds.get(decision.sessionDate) ?? new Set<string>(); ids.add(orderId); this.openedOrderIds.set(decision.sessionDate,ids); this.persistEvent(decision.sessionDate,{recordType:'RISK_ORDER_OPENED',orderId,intentId:decision.intentId}); }
  recordClosedOrder(sessionDate: string, orderId: string): void { this.openedOrderIds.get(sessionDate)?.delete(orderId); this.persistEvent(sessionDate,{recordType:'RISK_ORDER_CLOSED',orderId}); }
  evaluate(intent: RuntimeRiskIntent): RiskDecision {
    const now = this.options.now(); const id = RuntimeRiskGateService.intentId(intent); const reasons: RiskDenialReason[] = [];
    const corrupt = !intent || !(intent.timestamp instanceof Date) || Number.isNaN(intent.timestamp.getTime()) || !intent.runtimeId || !intent.strategyId || !intent.sessionDate || !intent.instrument || !intent.underlying || !Number.isFinite(intent.entryPremium) || intent.entryPremium <= 0 || !Number.isInteger(intent.quantity) || intent.quantity <= 0;
    const positions = this.options.getOpenPositions?.();
    if (corrupt || !positions || !['ACTIVE','HALTED','REDUCING'].includes(this.state) || this.hasUnresolvedPersistedOrder(intent.sessionDate)) reasons.push('UNKNOWN_RISK_STATE');
    if (this.isKillSwitchActive()) reasons.push('KILL_SWITCH_ACTIVE');
    if (intent.action === 'OPEN' && this.state !== 'ACTIVE') reasons.push('RUNTIME_DEGRADED');
    if (intent.action === 'OPEN' && (!intent.sessionTradable || !isWithinIstMarketSession(intent.timestamp))) reasons.push('SESSION_NOT_TRADABLE');
    if (intent.action === 'OPEN' && isAtOrAfterIstSessionEnd(intent.timestamp)) reasons.push('EOD_BLOCK');
    if (intent.action === 'OPEN' && intent.marketDataState !== 'READY') reasons.push('MARKET_DATA_NOT_READY');
    if (intent.action === 'OPEN' && this.options.requireFreshQuote) {
      const quote = intent.quote; const unavailable = !quote || !Number.isFinite(quote.ltp) || (quote.ltp as number) <= 0 || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || (quote.bid as number) <= 0 || (quote.ask as number) <= 0 || quote.crossed === true;
      if (unavailable) reasons.push('QUOTE_UNAVAILABLE'); else if (!Number.isFinite(quote.ageMs) || (quote.ageMs as number) > this.options.maxQuoteAgeMs) reasons.push('STALE_QUOTE');
    }
    if (intent.action === 'OPEN' && (this.approvedIds.has(id) || this.wasPersisted(id, intent.sessionDate))) reasons.push('DUPLICATE_INTENT');
    const currentPositions = positions ?? []; const projectedNotional = intent.entryPremium * intent.quantity; const totalNotional = currentPositions.reduce((sum, p) => sum + p.notional, 0);
    const strategyNotional = currentPositions.filter((p) => p.strategyId === intent.strategyId).reduce((sum,p)=>sum+p.notional,0);
    if (intent.action === 'OPEN' && currentPositions.length >= this.options.maxOpenPositions) reasons.push('MAX_OPEN_POSITIONS');
    if (intent.action === 'OPEN' && currentPositions.filter((p)=>p.strategyId===intent.strategyId).length >= this.options.maxOpenPositionsPerStrategy) reasons.push('MAX_OPEN_POSITIONS');
    if (intent.action === 'OPEN' && currentPositions.filter((p)=>p.underlying===intent.underlying).length >= this.options.maxOpenPositionsPerUnderlying) reasons.push('MAX_OPEN_POSITIONS');
    if (intent.action === 'OPEN' && totalNotional + projectedNotional > this.options.maxTotalNotional) reasons.push('MAX_TOTAL_EXPOSURE');
    if (intent.action === 'OPEN' && strategyNotional + projectedNotional > this.options.maxStrategyNotional) reasons.push('MAX_STRATEGY_EXPOSURE');
    const pnl = this.sessionPnl(intent.sessionDate); if (intent.action === 'OPEN' && pnl <= -Math.abs(this.options.dailyLossLimit)) reasons.push('DAILY_LOSS_LIMIT');
    const decision: RiskDecision = { decisionId: randomUUID(), runtimeId:intent.runtimeId, strategyId:intent.strategyId, sessionDate:intent.sessionDate, timestamp:now.toISOString(), instrument:intent.instrument, intentId:id, decision:reasons.length ? 'DENIED' : 'APPROVED', denialReasons:[...new Set(reasons)], riskSnapshot:{ tradingState:this.state, marketDataState:intent.marketDataState ?? null, quoteAgeMs:intent.quote?.ageMs ?? null, openPositions:currentPositions.length, totalNotional, strategyNotional, projectedNotional, realizedDailyPnl:pnl, killSwitch:this.isKillSwitchActive() }, correlationId:intent.correlationId ?? id };
    if (decision.decision === 'APPROVED') this.approvedIds.add(id); this.persist(decision); return decision;
  }
  denyExternal(intent: Omit<RuntimeRiskIntent, 'entryPremium' | 'quantity'>, reason: RiskDenialReason): RiskDecision {
    const intentId = RuntimeRiskGateService.intentId(intent); const decision: RiskDecision = { decisionId:randomUUID(), runtimeId:intent.runtimeId, strategyId:intent.strategyId, sessionDate:intent.sessionDate, timestamp:this.options.now().toISOString(), instrument:intent.instrument, intentId, decision:'DENIED', denialReasons:[reason], riskSnapshot:{tradingState:this.state,marketDataState:intent.marketDataState ?? null,quoteAgeMs:intent.quote?.ageMs ?? null,killSwitch:this.isKillSwitchActive()}, correlationId:intent.correlationId ?? intentId }; this.persist(decision); return decision;
  }
  private path(date: string): string { return resolve(process.cwd(), this.options.artifactRoot, `${date}.jsonl`); }
  private wasPersisted(intentId: string, date: string): boolean { if (!this.options.persist) return false; const path=this.path(date); if (!existsSync(path)) return false; return readFileSync(path,'utf8').split(/\r?\n/).some((line)=>{try{return JSON.parse(line).intentId===intentId&&JSON.parse(line).decision==='APPROVED';}catch{return false;}}); }
  private persist(decision: RiskDecision): void { if (!this.options.persist) return; const path=this.path(decision.sessionDate); mkdirSync(dirname(path),{recursive:true}); appendFileSync(path,`${JSON.stringify(decision)}\n`,'utf8'); }
  private persistEvent(sessionDate: string, event: Record<string, unknown>): void { if (!this.options.persist) return; const path=this.path(sessionDate); mkdirSync(dirname(path),{recursive:true}); appendFileSync(path,`${JSON.stringify({sessionDate,...event})}\n`,'utf8'); }
  private records(sessionDate: string): Array<Record<string, unknown>> { if (!this.options.persist) return []; const path=this.path(sessionDate); if (!existsSync(path)) return []; return readFileSync(path,'utf8').split(/\r?\n/).flatMap((line)=>{try{return [JSON.parse(line) as Record<string,unknown>];}catch{return [];}}); }
  private sessionPnl(sessionDate: string): number { if (this.realizedPnl.has(sessionDate)) return this.realizedPnl.get(sessionDate) as number; const total=this.records(sessionDate).filter(x=>x.recordType==='REALIZED_PNL').reduce((sum,x)=>sum+(typeof x.pnl==='number'?x.pnl:0),0); this.realizedPnl.set(sessionDate,total); return total; }
  private hasUnresolvedPersistedOrder(sessionDate: string): boolean { const local=this.openedOrderIds.get(sessionDate); if (local && local.size) return false; const open=new Set(this.records(sessionDate).filter(x=>x.recordType==='RISK_ORDER_OPENED'&&typeof x.orderId==='string').map(x=>x.orderId as string)); this.records(sessionDate).filter(x=>x.recordType==='RISK_ORDER_CLOSED'&&typeof x.orderId==='string').forEach(x=>open.delete(x.orderId as string)); return open.size>0; }
}

export class RiskDeniedError extends Error { constructor(public readonly decision: RiskDecision) { super(`Risk gate denied ${decision.intentId}: ${decision.denialReasons.join('|')}`); this.name='RiskDeniedError'; } }
