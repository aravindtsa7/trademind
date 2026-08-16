import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import logger from '../../../core/logger/logger';
import { PaperOrder } from '../types/paper-trading.types';
import { PaperFill, PaperPortfolio, PaperPosition, PortfolioSnapshot, StrategyExposure, UnderlyingExposure } from '../dto/paper-portfolio.dto';

export interface PaperPortfolioOpenInput { order: PaperOrder; strategyId: string; underlying: string; correlationId: string; intentId: string; sessionDate: string; }
export interface PaperPortfolioMarkInput { instrumentKey: string; timestamp: Date; bid?: number; ask?: number; ltp?: number; ageMs?: number; maxAgeMs?: number; }

export interface PaperPortfolioRepository {
  load(sessionDate: string): PaperPortfolio | undefined;
  loadAll(): PaperPortfolio[];
  save(state: PaperPortfolio): void;
}

/** Durable local state until a canonical database paper-position model exists. */
export class FilePaperPortfolioRepository implements PaperPortfolioRepository {
  constructor(private readonly root = 'artifacts/paper-portfolio') {}
  load(sessionDate: string): PaperPortfolio | undefined {
    const path = this.path(sessionDate);
    if (!existsSync(path)) return undefined;
    return parsePortfolio(readFileSync(path, 'utf8'));
  }
  loadAll(): PaperPortfolio[] {
    const directory = resolve(process.cwd(), this.root);
    if (!existsSync(directory)) return [];
    return readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => parsePortfolio(readFileSync(resolve(directory, name), 'utf8')));
  }
  save(state: PaperPortfolio): void {
    const path = this.path(state.sessionDate); const temporary = `${path}.${process.pid}.tmp`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, JSON.stringify(state), 'utf8');
    renameSync(temporary, path);
  }
  private path(sessionDate: string): string { return resolve(process.cwd(), this.root, `${sessionDate}.json`); }
}

export class InMemoryPaperPortfolioRepository implements PaperPortfolioRepository {
  private readonly states = new Map<string, PaperPortfolio>();
  load(sessionDate: string): PaperPortfolio | undefined { const state = this.states.get(sessionDate); return state ? clonePortfolio(state) : undefined; }
  loadAll(): PaperPortfolio[] { return [...this.states.values()].map(clonePortfolio); }
  save(state: PaperPortfolio): void { this.states.set(state.sessionDate, clonePortfolio(state)); }
}

/** Single authoritative owner of paper positions, exposure and session P&L. */
export default class PaperPortfolioService {
  private readonly states = new Map<string, PaperPortfolio>();
  private readonly recoveredOpenPositionIds = new Set<string>();
  private corrupt = false;

  constructor(private readonly repository: PaperPortfolioRepository = new FilePaperPortfolioRepository(), private readonly now = () => new Date()) {
    try { this.repository.loadAll().forEach((state) => { this.states.set(state.sessionDate, clonePortfolio(state)); state.positions.filter((position) => position.status === 'OPEN').forEach((position) => this.recoveredOpenPositionIds.add(position.positionId)); }); }
    catch (error) { this.corrupt = true; logger.error('PAPER_PORTFOLIO_INCONSISTENCY', { error }); }
  }

  open(input: PaperPortfolioOpenInput): PaperPosition {
    this.validateOpen(input);
    const state = this.state(input.sessionDate);
    const existing = state.positions.find((position) => position.originatingOrderId === input.order.id);
    if (existing) return clonePosition(existing);
    const positionId = deterministicId('position', input.order.id);
    const execution = input.order.entry.executionFill;
    const entryFill: PaperFill = { fillId: deterministicId('fill-entry', input.order.id), positionId, type: 'ENTRY', timestamp: input.order.entry.entryTimestamp.toISOString(), price: input.order.entry.simulatedEntryPremium, quantity: input.order.contract.quantity, source: 'SIMULATED_ENTRY', requestedQuantity: execution?.requestedQuantity, fillQuality: execution?.fillQuality, quotedBestPrice: execution?.quotedBestPrice, slippageVsBestQuote: execution?.slippageVsBestQuote, slippageVsLtp: execution?.slippageVsLtp, spreadCost: execution?.spreadCost, depthSlippage: execution?.depthSlippage, totalExecutionSlippage: execution?.totalExecutionSlippage, slippagePercent: execution?.slippagePercent };
    const position: PaperPosition = {
      positionId, strategyId: input.strategyId, instrumentKey: input.order.contract.instrumentKey, underlying: input.underlying,
      side: input.order.signalType, quantity: input.order.contract.quantity, entryTimestamp: input.order.entry.entryTimestamp.toISOString(), entryPrice: input.order.entry.simulatedEntryPremium,
      currentMarkPrice: null, quoteQuality: 'UNAVAILABLE', realizedPnl: 0, unrealizedPnl: null, status: 'OPEN',
      correlationId: input.correlationId, originatingIntentId: input.intentId, originatingOrderId: input.order.id,
      transitions: [
        { status: 'OPEN_INTENT', timestamp: input.order.entry.entryTimestamp.toISOString() },
        { status: 'ENTRY_FILLED', timestamp: input.order.entry.entryTimestamp.toISOString() },
        { status: 'OPEN', timestamp: input.order.entry.entryTimestamp.toISOString() },
      ],
      fills: [entryFill],
    };
    state.positions.push(position); this.persist(state);
    logger.info('PAPER_PORTFOLIO_POSITION_OPENED', this.positionLog(position, state));
    return clonePosition(position);
  }

  mark(input: PaperPortfolioMarkInput): number {
    if (!(input.timestamp instanceof Date) || Number.isNaN(input.timestamp.getTime()) || !input.instrumentKey) return 0;
    const freshBid = Number.isFinite(input.bid) && (input.bid as number) > 0 && Number.isFinite(input.ageMs) && (input.ageMs as number) <= (input.maxAgeMs ?? 2_000);
    let changed = 0;
    for (const state of this.states.values()) for (const position of state.positions.filter((value) => value.status === 'OPEN' && value.instrumentKey === input.instrumentKey)) {
      if (!freshBid) { position.quoteQuality = Number.isFinite(input.ltp) ? 'LTP_ONLY' : Number.isFinite(input.ageMs) ? 'STALE_QUOTE' : 'UNAVAILABLE'; continue; }
      position.currentMarkPrice = input.bid as number; position.quoteQuality = 'BID_ASK'; position.unrealizedPnl = ((input.bid as number) - position.entryPrice) * position.quantity; changed += 1; this.persist(state);
      logger.debug('PAPER_PORTFOLIO_MARK_UPDATED', this.positionLog(position, state));
    }
    return changed;
  }

  close(order: PaperOrder, sessionDate: string): PaperPosition | undefined {
    if (!order.exit) return undefined;
    const state = this.state(sessionDate);
    const position = state.positions.find((value) => value.originatingOrderId === order.id);
    if (!position) { this.markInconsistent(state, `MISSING_POSITION:${order.id}`); return undefined; }
    if (position.status === 'CLOSED') return clonePosition(position);
    const exitPrice = order.exit.simulatedExitPremium;
    const execution = order.exit.executionFill;
    const exitFill: PaperFill = { fillId: deterministicId('fill-exit', order.id), positionId: position.positionId, type: 'EXIT', timestamp: order.exit.exitTimestamp.toISOString(), price: exitPrice, quantity: position.quantity, source: 'SIMULATED_EXIT', exitReason: order.exit.exitReason, requestedQuantity: execution?.requestedQuantity, fillQuality: execution?.fillQuality, quotedBestPrice: execution?.quotedBestPrice, slippageVsBestQuote: execution?.slippageVsBestQuote, slippageVsLtp: execution?.slippageVsLtp, spreadCost: execution?.spreadCost, depthSlippage: execution?.depthSlippage, totalExecutionSlippage: execution?.totalExecutionSlippage, slippagePercent: execution?.slippagePercent };
    position.transitions.push(
      { status: 'EXIT_REQUESTED', timestamp: exitFill.timestamp },
      { status: 'EXIT_FILLED', timestamp: exitFill.timestamp },
      { status: 'CLOSED', timestamp: exitFill.timestamp },
    );
    position.status = 'CLOSED'; position.exitTimestamp = exitFill.timestamp; position.exitPrice = exitPrice; position.exitReason = order.exit.exitReason;
    position.currentMarkPrice = exitPrice; position.quoteQuality = 'LTP_ONLY'; position.unrealizedPnl = 0; position.realizedPnl = (exitPrice - position.entryPrice) * position.quantity;
    if (!position.fills.some((fill) => fill.fillId === exitFill.fillId)) position.fills.push(exitFill);
    this.persist(state); logger.info('PAPER_PORTFOLIO_POSITION_CLOSED', this.positionLog(position, state));
    return clonePosition(position);
  }

  getSnapshot(sessionDate: string, timestamp = this.now()): PortfolioSnapshot | undefined {
    if (this.corrupt || this.recoveredOpenPositionIds.size > 0 || [...this.states.values()].some((state) => state.inconsistent || state.positions.some((position) => position.status === 'OPEN' && state.sessionDate !== sessionDate))) return undefined;
    const state = this.state(sessionDate); const open = state.positions.filter((position) => position.status === 'OPEN'); const closed = state.positions.filter((position) => position.status === 'CLOSED');
    const totalNotional = open.reduce((sum, position) => sum + position.entryPrice * position.quantity, 0);
    const realized = state.positions.reduce((sum, position) => sum + position.realizedPnl, 0);
    const marks = open.map((position) => position.unrealizedPnl); const totalUnrealized = marks.every((value) => value !== null) ? marks.reduce((sum, value) => sum + (value as number), 0) : null;
    const strategyBreakdown = breakdownByStrategy(state.positions); const underlyingBreakdown = breakdownByUnderlying(open);
    return deepFreeze({ sessionDate, timestamp: timestamp.toISOString(), openPositionCount: open.length, closedPositionCount: closed.length, totalNotional, totalRealizedPnl: realized, totalUnrealizedPnl: totalUnrealized, portfolioEquityDelta: totalUnrealized === null ? null : realized + totalUnrealized, strategyBreakdown, underlyingBreakdown, dataQuality: open.some((position) => position.quoteQuality !== 'BID_ASK') ? 'DEGRADED' : 'HEALTHY', stateVersion: state.stateVersion });
  }

  /** Undefined is a deliberate fail-closed signal for RuntimeRiskGate. */
  getRiskPositions(sessionDate: string): readonly { strategyId: string; underlying: string; notional: number }[] | undefined {
    const snapshot = this.getSnapshot(sessionDate); if (!snapshot) return undefined;
    return this.state(sessionDate).positions.filter((position) => position.status === 'OPEN').map((position) => ({ strategyId: position.strategyId, underlying: position.underlying, notional: position.entryPrice * position.quantity }));
  }

  /** Stable replay/audit digest over the compact authoritative session state. */
  digest(sessionDate: string): string | undefined {
    const snapshot = this.getSnapshot(sessionDate); if (!snapshot) return undefined;
    return createHash('sha256').update(JSON.stringify({ snapshot, positions: this.state(sessionDate).positions })).digest('hex');
  }

  /** Emits one compact EOD/session accounting summary without changing state. */
  logSessionSummary(sessionDate: string, timestamp = this.now()): PortfolioSnapshot | undefined {
    const snapshot = this.getSnapshot(sessionDate, timestamp);
    if (snapshot) logger.info('PAPER_PORTFOLIO_SESSION_SUMMARY', snapshot);
    return snapshot;
  }

  /** Reconciliation is explicit: unknown recovered paper orders never become silently tradeable. */
  reconcileOpenOrders(sessionDate: string, activeOrderIds: readonly string[]): boolean {
    const state = this.state(sessionDate); const active = new Set(activeOrderIds);
    const unreconciled = state.positions.filter((position) => position.status === 'OPEN' && !active.has(position.originatingOrderId));
    if (unreconciled.length > 0) { this.markInconsistent(state, `UNRECONCILED_OPEN:${unreconciled.map((position) => position.originatingOrderId).join(',')}`); return false; }
    state.positions.filter((position) => position.status === 'OPEN').forEach((position) => this.recoveredOpenPositionIds.delete(position.positionId));
    if (activeOrderIds.length) logger.info('PAPER_PORTFOLIO_RECOVERED', { sessionDate, openPositionCount: activeOrderIds.length });
    return true;
  }

  private state(sessionDate: string): PaperPortfolio {
    let state = this.states.get(sessionDate);
    if (!state) { state = { schemaVersion: 1, sessionDate, stateVersion: 0, positions: [], inconsistent: false, updatedAt: this.now().toISOString() }; this.states.set(sessionDate, state); }
    return state;
  }
  private persist(state: PaperPortfolio): void { state.stateVersion += 1; state.updatedAt = this.now().toISOString(); this.repository.save(clonePortfolio(state)); }
  private markInconsistent(state: PaperPortfolio, reason: string): void { state.inconsistent = true; this.persist(state); logger.error('PAPER_PORTFOLIO_INCONSISTENCY', { sessionDate: state.sessionDate, reason }); }
  private validateOpen(input: PaperPortfolioOpenInput): void { if (!input.order || !input.strategyId || !input.underlying || !input.intentId || !input.sessionDate || !Number.isFinite(input.order.entry.simulatedEntryPremium) || input.order.entry.simulatedEntryPremium <= 0) throw new Error('Invalid paper portfolio open input.'); }
  private positionLog(position: PaperPosition, state: PaperPortfolio): Record<string, unknown> { return { strategyId: position.strategyId, positionId: position.positionId, instrument: position.instrumentKey, quantity: position.quantity, entry: position.entryPrice, exit: position.exitPrice ?? null, realizedPnl: position.realizedPnl, unrealizedPnl: position.unrealizedPnl, sessionRealizedPnl: state.positions.reduce((sum, item) => sum + item.realizedPnl, 0), correlationId: position.correlationId }; }
}

function deterministicId(prefix: string, value: string): string { return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`; }
function parsePortfolio(raw: string): PaperPortfolio {
  const value = JSON.parse(raw) as PaperPortfolio;
  if (value.schemaVersion !== 1 || !value.sessionDate || !Array.isArray(value.positions) || typeof value.stateVersion !== 'number'
    || value.positions.some((position) => !position || !position.positionId || !position.originatingOrderId || !position.strategyId || !position.instrumentKey || !Number.isFinite(position.quantity) || !Number.isFinite(position.entryPrice) || !Array.isArray(position.fills) || !Array.isArray(position.transitions))) {
    throw new Error('Invalid paper portfolio state.');
  }
  return value;
}
function clonePosition(position: PaperPosition): PaperPosition { return structuredClone(position); }
function clonePortfolio(portfolio: PaperPortfolio): PaperPortfolio { return structuredClone(portfolio); }
function breakdownByStrategy(positions: readonly PaperPosition[]): readonly StrategyExposure[] { return Object.values(positions.reduce<Record<string, StrategyExposure>>((all, position) => { const item = all[position.strategyId] ?? { strategyId: position.strategyId, openPositionCount: 0, totalNotional: 0, realizedPnl: 0, unrealizedPnl: 0 }; item.openPositionCount += position.status === 'OPEN' ? 1 : 0; item.totalNotional += position.status === 'OPEN' ? position.entryPrice * position.quantity : 0; item.realizedPnl += position.realizedPnl; item.unrealizedPnl = item.unrealizedPnl === null || position.unrealizedPnl === null ? null : item.unrealizedPnl + position.unrealizedPnl; all[position.strategyId] = item; return all; }, {})).sort((left, right) => left.strategyId.localeCompare(right.strategyId)); }
function breakdownByUnderlying(positions: readonly PaperPosition[]): readonly UnderlyingExposure[] { return Object.values(positions.reduce<Record<string, UnderlyingExposure>>((all, position) => { const item = all[position.underlying] ?? { underlying: position.underlying, openPositionCount: 0, totalNotional: 0 }; item.openPositionCount += 1; item.totalNotional += position.entryPrice * position.quantity; all[position.underlying] = item; return all; }, {})).sort((left, right) => left.underlying.localeCompare(right.underlying)); }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value as object).forEach((item) => deepFreeze(item)); } return value; }
