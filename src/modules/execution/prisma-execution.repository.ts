import { Prisma, PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { PaperExecutionFillSummary } from '../paper-trading/dto/paper-fill-model.dto';
import { PaperOrder } from '../paper-trading/types/paper-trading.types';
import { PortfolioSnapshot } from '../paper-trading/dto/paper-portfolio.dto';
import { ExecutionIntent, ExecutionOrder, ExecutionReconciliationResult } from './execution.types';
import { ExecutionHealth } from './execution.types';

type Db = PrismaClient | Prisma.TransactionClient;
export interface DurablePaperEntry {
  intent: ExecutionIntent;
  order: PaperOrder;
  underlying: string;
  fill: PaperExecutionFillSummary;
}

/**
 * MySQL source of truth for paper execution. Every entry/exit method owns one
 * Prisma transaction containing execution evidence and matching portfolio
 * evidence. It has no broker submission capability.
 */
export default class PrismaExecutionRepository {
  private readonly snapshots = new Map<string, PortfolioSnapshot>();
  private readonly health = new Map<string, ExecutionHealth>();
  constructor(private readonly prisma: PrismaClient = new PrismaClient()) {}
  static executionOrderId(intentId: string): string { return executionId(intentId); }

  async createPaperEntry(input: DurablePaperEntry): Promise<ExecutionOrder> {
    const result = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.executionOrder.findUnique({ where:{ intentId:input.intent.intentId }, include:{ fills:true, transitions:true } });
      if (existing) return mapOrder(existing);
      const orderId = executionId(input.intent.intentId);
      const entryFillId = executionId(`entry|${orderId}|${input.fill.filledQuantity}|${input.fill.averageFillPrice}|${input.order.entry.entryTimestamp.toISOString()}`);
      const now = input.order.entry.entryTimestamp;
      const positionId = executionId(`position|${orderId}`);
      const status = input.fill.filledQuantity === input.intent.quantity ? 'FILLED' : 'PARTIALLY_FILLED';
      const remaining = input.intent.quantity - input.fill.filledQuantity;
      const transitions = transitionRows(orderId, input.intent.correlationId, now, status);
      const created = await tx.executionOrder.create({ data:{ executionOrderId:orderId, intentId:input.intent.intentId, strategyId:input.intent.strategyId, runtimeId:input.intent.runtimeId, sessionDate:input.intent.sessionDate, instrumentKey:input.intent.instrumentKey, side:input.intent.side, quantity:input.intent.quantity, requestedPrice:input.intent.requestedPrice, executionMode:'PAPER', status, cumulativeFilledQuantity:input.fill.filledQuantity, cumulativeExitQuantity:0, remainingQuantity:remaining, averageFillPrice:input.fill.averageFillPrice, averageExitPrice:null, correlationId:input.intent.correlationId, version:transitions.length, paperOrderId:input.order.id, fills:{ create:{ fillId:entryFillId, leg:'ENTRY', quantity:input.fill.filledQuantity, price:input.fill.averageFillPrice, timestamp:now, source:'PAPER_FILL_MODEL', quoteQuality:input.fill.fillQuality, slippage:input.fill.totalExecutionSlippage, correlationId:input.intent.correlationId } }, transitions:{ create:transitions } }, include:{ fills:true, transitions:true } });
      await tx.paperPortfolioPosition.create({ data:{ positionId, executionOrderId:orderId, originatingIntentId:input.intent.intentId, originatingOrderId:input.order.id, strategyId:input.intent.strategyId, sessionDate:input.intent.sessionDate, instrumentKey:input.intent.instrumentKey, underlying:input.underlying, side:input.intent.side, quantity:input.fill.filledQuantity, entryTimestamp:now, entryPrice:input.fill.averageFillPrice, status:'OPEN', correlationId:input.intent.correlationId, fills:{ create:{ paperFillId:executionId(`paper|${entryFillId}`), executionFillId:entryFillId, type:'ENTRY', timestamp:now, price:input.fill.averageFillPrice, quantity:input.fill.filledQuantity, source:'PAPER_FILL_MODEL', fillQuality:input.fill.fillQuality, slippage:input.fill.totalExecutionSlippage } } } });
      return mapOrder(created);
    });
    await this.refreshCache(input.intent.sessionDate, this.prisma);
    return result;
  }

  async recordPaperExit(executionOrderId: string, sessionDate: string, fill: PaperExecutionFillSummary, timestamp: Date, exitReason: string): Promise<ExecutionOrder> {
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.executionOrder.findUnique({ where:{ executionOrderId }, include:{ fills:true, transitions:true, paperPosition:true } });
      if (!current || current.sessionDate !== sessionDate) throw new Error('Execution order was not found for requested session.');
      const entryQuantity = current.cumulativeFilledQuantity; const existingExit = current.cumulativeExitQuantity; const allowed = entryQuantity - existingExit;
      if (fill.filledQuantity <= 0 || fill.filledQuantity > allowed) throw new Error('Exit fill exceeds durable residual quantity.');
      const fillId = executionId(`exit|${executionOrderId}|${fill.filledQuantity}|${fill.averageFillPrice}|${timestamp.toISOString()}`);
      if (current.fills.some((item) => item.fillId === fillId)) return mapOrder(current);
      const totalExit = existingExit + fill.filledQuantity; const remaining = entryQuantity - totalExit; const averageExit = weighted(decimal(current.averageExitPrice), existingExit, fill.averageFillPrice, fill.filledQuantity); const next='CLOSED';
      // A partial exit remains position-open; status is explicit rather than a fabricated full close.
      const status = remaining === 0 ? next : 'PARTIALLY_FILLED';
      const exitPendingId = executionId(`transition|${executionOrderId}|${current.version + 1}|EXIT_PENDING|${timestamp.toISOString()}`);
      const finalId = executionId(`transition|${executionOrderId}|${current.version + 2}|${status}|${timestamp.toISOString()}`);
      const updated = await tx.executionOrder.update({ where:{ executionOrderId }, data:{ status, cumulativeExitQuantity:totalExit, remainingQuantity:remaining, averageExitPrice:averageExit, version:{ increment:2 }, fills:{ create:{ fillId, leg:'EXIT', quantity:fill.filledQuantity, price:fill.averageFillPrice, timestamp, source:'PAPER_FILL_MODEL', quoteQuality:fill.fillQuality, slippage:fill.totalExecutionSlippage, correlationId:current.correlationId } }, transitions:{ create:[{ transitionId:exitPendingId, previousState:current.status, nextState:'EXIT_PENDING', timestamp, reason:exitReason, correlationId:current.correlationId },{ transitionId:finalId, previousState:'EXIT_PENDING', nextState:status, timestamp, reason:exitReason, correlationId:current.correlationId }] } }, include:{ fills:true, transitions:true } });
      if (!current.paperPosition) throw new Error('Execution order has no durable paper position.');
      const realized = (fill.averageFillPrice - decimal(current.averageFillPrice)) * fill.filledQuantity;
      await tx.paperPortfolioPosition.update({ where:{ positionId:current.paperPosition.positionId }, data:{ quantity:remaining, realizedPnl:{ increment:realized }, status:remaining === 0 ? 'CLOSED' : 'OPEN', ...(remaining === 0 ? { exitTimestamp:timestamp, exitPrice:fill.averageFillPrice, exitReason } : {}), stateVersion:{ increment:1 }, fills:{ create:{ paperFillId:executionId(`paper|${fillId}`), executionFillId:fillId, type:'EXIT', timestamp, price:fill.averageFillPrice, quantity:fill.filledQuantity, source:'PAPER_FILL_MODEL', exitReason, fillQuality:fill.fillQuality, slippage:fill.totalExecutionSlippage } } } });
      return mapOrder(updated);
    });
    await this.refreshCache(sessionDate, this.prisma);
    return result;
  }

  /**
   * Persists a fail-closed uncertainty marker after an exit mutation cannot be
   * acknowledged. If the original transaction did commit, the already-CLOSED
   * order is retained; otherwise no quantity, fill, or P&L is changed.
   */
  async markReconciliationRequired(executionOrderId: string, sessionDate: string, timestamp: Date, reason: string): Promise<ExecutionOrder> {
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.executionOrder.findUnique({ where:{ executionOrderId }, include:{ fills:true, transitions:true } });
      if (!current || current.sessionDate !== sessionDate) throw new Error('Execution order was not found for reconciliation marking.');
      if (current.status === 'CLOSED' || current.status === 'RECONCILIATION_REQUIRED') return mapOrder(current);
      const transitionId = executionId(`transition|${executionOrderId}|${current.version + 1}|RECONCILIATION_REQUIRED|${reason}`);
      const updated = await tx.executionOrder.update({ where:{ executionOrderId }, data:{ status:'RECONCILIATION_REQUIRED', version:{ increment:1 }, transitions:{ create:{ transitionId, previousState:current.status, nextState:'RECONCILIATION_REQUIRED', timestamp, reason, correlationId:current.correlationId } } }, include:{ fills:true, transitions:true } });
      return mapOrder(updated);
    });
    await this.refreshCache(sessionDate, this.prisma);
    this.health.set(sessionDate,{ready:false,reconciliationRequired:true,status:'RECONCILIATION_REQUIRED'});
    return result;
  }

  async getByIntentId(intentId: string): Promise<ExecutionOrder | undefined> { const row=await this.prisma.executionOrder.findUnique({where:{intentId},include:{fills:true,transitions:true}});return row?mapOrder(row):undefined; }
  async getByExecutionOrderId(executionOrderId: string): Promise<ExecutionOrder | undefined> { const row=await this.prisma.executionOrder.findUnique({where:{executionOrderId},include:{fills:true,transitions:true}});return row?mapOrder(row):undefined; }
  async listUnresolved(sessionDate: string): Promise<ExecutionOrder[]> { const rows=await this.prisma.executionOrder.findMany({where:{sessionDate,status:{in:['CREATED','RISK_APPROVED','SUBMISSION_PENDING','SUBMITTED','ACKNOWLEDGED','PARTIALLY_FILLED','FILLED','EXIT_PENDING','RECONCILIATION_REQUIRED','FAULTED']}},include:{fills:true,transitions:true},orderBy:{createdAt:'asc'}});return rows.map(mapOrder); }

  async reconcile(sessionDate: string): Promise<ExecutionReconciliationResult> {
    const rows=await this.prisma.executionOrder.findMany({where:{sessionDate},include:{fills:true,paperPosition:true}}); const errors:string[]=[];const unresolved:string[]=[];
    for(const row of rows){const entry=row.fills.filter((fill)=>fill.leg==='ENTRY').reduce((sum,fill)=>sum+fill.quantity,0);const exit=row.fills.filter((fill)=>fill.leg==='EXIT').reduce((sum,fill)=>sum+fill.quantity,0);if(entry!==row.cumulativeFilledQuantity||exit!==row.cumulativeExitQuantity||exit>entry||!row.paperPosition||row.paperPosition.quantity!==entry-exit){errors.push(`MISMATCH:${row.executionOrderId}`);unresolved.push(row.executionOrderId);}}
    const snapshot=await this.snapshot(sessionDate); if(snapshot.openPositionCount>0){errors.push('OPEN_POSITION_REQUIRES_RUNTIME_REHYDRATION');unresolved.push(...positionsOrderIds(rows));}
    const status=errors.length?'RECONCILIATION_REQUIRED':'CONSISTENT'; const result={sessionDate,status,unresolvedOrderIds:[...new Set(unresolved)],repairedOrderIds:[],errors,timestamp:new Date().toISOString()} as ExecutionReconciliationResult;
    this.health.set(sessionDate,{ready:status==='CONSISTENT',reconciliationRequired:status!=='CONSISTENT',status}); return result;
  }

  async initialize(sessionDate:string):Promise<ExecutionReconciliationResult>{await this.refreshCache(sessionDate,this.prisma);return this.reconcile(sessionDate);}
  getCachedSnapshot(sessionDate:string):PortfolioSnapshot|undefined{const snapshot=this.snapshots.get(sessionDate);return snapshot?structuredClone(snapshot):undefined;}
  getHealth(sessionDate:string):ExecutionHealth{return this.health.get(sessionDate)??{ready:false,reconciliationRequired:true,status:'NOT_STARTED'};}

  async snapshot(sessionDate: string): Promise<PortfolioSnapshot> {
    const positions=await this.prisma.paperPortfolioPosition.findMany({where:{sessionDate},orderBy:{positionId:'asc'}}); const open=positions.filter((position)=>position.status==='OPEN');const closed=positions.filter((position)=>position.status==='CLOSED');const totalNotional=open.reduce((sum,position)=>sum+decimal(position.entryPrice)*position.quantity,0);const realized=positions.reduce((sum,position)=>sum+decimal(position.realizedPnl),0);
    const strategyBreakdown=Object.values(positions.reduce<Record<string,{strategyId:string;openPositionCount:number;totalNotional:number;realizedPnl:number;unrealizedPnl:number|null}>>((all,position)=>{const item=all[position.strategyId]??{strategyId:position.strategyId,openPositionCount:0,totalNotional:0,realizedPnl:0,unrealizedPnl:0};if(position.status==='OPEN'){item.openPositionCount++;item.totalNotional+=decimal(position.entryPrice)*position.quantity;}item.realizedPnl+=decimal(position.realizedPnl);all[position.strategyId]=item;return all;},{})); const underlyingBreakdown=Object.values(open.reduce<Record<string,{underlying:string;openPositionCount:number;totalNotional:number}>>((all,position)=>{const item=all[position.underlying]??{underlying:position.underlying,openPositionCount:0,totalNotional:0};item.openPositionCount++;item.totalNotional+=decimal(position.entryPrice)*position.quantity;all[position.underlying]=item;return all;},{}));
    return {sessionDate,timestamp:new Date().toISOString(),openPositionCount:open.length,closedPositionCount:closed.length,totalNotional,totalRealizedPnl:realized,totalUnrealizedPnl:null,portfolioEquityDelta:null,strategyBreakdown,underlyingBreakdown,dataQuality:'HEALTHY',stateVersion:positions.reduce((sum,position)=>sum+position.stateVersion,0)};
  }
  private async refreshCache(sessionDate:string,db:Db):Promise<void>{const positions=await db.paperPortfolioPosition.findMany({where:{sessionDate},orderBy:{positionId:'asc'}});const snapshot=buildSnapshot(sessionDate,positions);this.snapshots.set(sessionDate,snapshot);this.health.set(sessionDate,{ready:true,reconciliationRequired:false,status:'CONSISTENT'});}
}

function transitionRows(orderId:string, correlationId:string, timestamp:Date, last:string){const states=['RISK_APPROVED','SUBMISSION_PENDING','SUBMITTED','ACKNOWLEDGED',last];let previous='CREATED';return states.map((next,index)=>{const row={transitionId:executionId(`transition|${orderId}|${index + 1}|${next}`),previousState:previous,nextState:next,timestamp,correlationId};previous=next;return row;});}
function executionId(value:string):string{return `exec-${createHash('sha256').update(value).digest('hex').slice(0,24)}`;}
function decimal(value:Prisma.Decimal|null|undefined):number{return value?Number(value):0;}
function weighted(previous:number, previousQuantity:number, price:number, quantity:number):number{return(previous*previousQuantity+price*quantity)/(previousQuantity+quantity);}
function mapOrder(row:any):ExecutionOrder{return {executionOrderId:row.executionOrderId,intentId:row.intentId,strategyId:row.strategyId,runtimeId:row.runtimeId,sessionDate:row.sessionDate,instrumentKey:row.instrumentKey,side:row.side,quantity:row.quantity,requestedPrice:row.requestedPrice===null?undefined:decimal(row.requestedPrice),executionMode:'PAPER',status:row.status,cumulativeFilledQuantity:row.cumulativeFilledQuantity,cumulativeExitQuantity:row.cumulativeExitQuantity,remainingQuantity:row.remainingQuantity,averageFillPrice:row.averageFillPrice===null?null:decimal(row.averageFillPrice),averageExitPrice:row.averageExitPrice===null?null:decimal(row.averageExitPrice),createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString(),correlationId:row.correlationId,version:row.version,externalOrderId:row.externalOrderId??undefined,paperOrderId:row.paperOrderId??undefined,fills:row.fills.map((fill:any)=>({fillId:fill.fillId,executionOrderId:fill.executionOrderId,leg:fill.leg,quantity:fill.quantity,price:decimal(fill.price),timestamp:fill.timestamp.toISOString(),source:'PAPER_FILL_MODEL',quoteQuality:fill.quoteQuality,slippage:decimal(fill.slippage),correlationId:fill.correlationId})),transitions:row.transitions.map((item:any)=>({transitionId:item.transitionId,executionOrderId:item.executionOrderId,previousState:item.previousState,nextState:item.nextState,timestamp:item.timestamp.toISOString(),reason:item.reason??undefined,correlationId:item.correlationId}))};}
function positionsOrderIds(rows:any[]):string[]{return rows.filter((row)=>row.paperPosition?.status==='OPEN').map((row)=>row.executionOrderId);}
function buildSnapshot(sessionDate:string,positions:any[]):PortfolioSnapshot{const open=positions.filter((position)=>position.status==='OPEN');const closed=positions.filter((position)=>position.status==='CLOSED');const totalNotional=open.reduce((sum,position)=>sum+decimal(position.entryPrice)*position.quantity,0);const realized=positions.reduce((sum,position)=>sum+decimal(position.realizedPnl),0);const strategyBreakdown=Object.values(positions.reduce<Record<string,any>>((all,position)=>{const value=all[position.strategyId]??{strategyId:position.strategyId,openPositionCount:0,totalNotional:0,realizedPnl:0,unrealizedPnl:0};if(position.status==='OPEN'){value.openPositionCount++;value.totalNotional+=decimal(position.entryPrice)*position.quantity;}value.realizedPnl+=decimal(position.realizedPnl);all[position.strategyId]=value;return all;},{}));const underlyingBreakdown=Object.values(open.reduce<Record<string,any>>((all,position)=>{const value=all[position.underlying]??{underlying:position.underlying,openPositionCount:0,totalNotional:0};value.openPositionCount++;value.totalNotional+=decimal(position.entryPrice)*position.quantity;all[position.underlying]=value;return all;},{}));return {sessionDate,timestamp:new Date().toISOString(),openPositionCount:open.length,closedPositionCount:closed.length,totalNotional,totalRealizedPnl:realized,totalUnrealizedPnl:null,portfolioEquityDelta:null,strategyBreakdown,underlyingBreakdown,dataQuality:'HEALTHY',stateVersion:positions.reduce((sum,position)=>sum+position.stateVersion,0)};}
