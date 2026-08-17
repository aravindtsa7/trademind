import assert from 'node:assert/strict';
import test from 'node:test';
import PrismaExecutionRepository from './prisma-execution.repository';
import { PaperExecutionFillSummary } from '../paper-trading/dto/paper-fill-model.dto';
import { PaperOrderStatus } from '../paper-trading/types/paper-trading.types';
import { DeterministicExecutionFaultInjector, InjectedExecutionFault } from './execution-fault-injection.test-helper';

const at=new Date('2026-08-17T04:00:00.000Z');
const fill:PaperExecutionFillSummary={status:'FILLED',requestedQuantity:75,filledQuantity:75,averageFillPrice:101,worstFillPrice:101,quotedBestPrice:101,fillQuality:'TOP_OF_BOOK_ESTIMATE',slippageVsBestQuote:0,slippageVsLtp:1,spreadCost:1,depthSlippage:0,totalExecutionSlippage:1,slippagePercent:1,sourceTimestamp:at.toISOString(),quoteDataQuality:'FRESH_TOP_OF_BOOK'};
const paperOrder:any={id:'paper-1',status:PaperOrderStatus.PENDING,signalTimestamp:at,signalType:'BUY_PE',contract:{instrumentKey:'NSE_FO|one',tradingSymbol:'NIFTY PE',optionType:'PE',strikePrice:25000,expiry:at,lotSize:75,quantity:75},entry:{entryTimestamp:at,observedEntryPremium:100,simulatedEntryPremium:101,executionFill:fill},exitConfiguration:{targetPercent:5,stopLossPercent:5,maximumHoldingMinutes:15},targetPremium:106,stopPremium:96};
const input={intent:{intentId:'intent-1',strategyId:'V2_TREND_DOWN_PE',runtimeId:'paper:v2',sessionDate:'2026-08-17',instrumentKey:'NSE_FO|one',side:'BUY_PE' as const,quantity:75,requestedPrice:100,executionMode:'PAPER' as const,timestamp:at.toISOString(),correlationId:'corr-1'},order:paperOrder,underlying:'NIFTY 50',fill};

test('Prisma entry failure is surfaced and cannot report a successful execution',async()=>{
  let invoked=false;const client={$transaction:async()=>{invoked=true;throw new Error('DB_DOWN');}};
  const repository=new PrismaExecutionRepository(client as any);
  await assert.rejects(()=>repository.createPaperEntry(input),/DB_DOWN/);assert.equal(invoked,true);
});

test('Prisma exit transaction failure is surfaced without reporting a durable exit',async()=>{
  let invoked=false;const client={$transaction:async()=>{invoked=true;throw new Error('EXIT_ROLLBACK');}};
  const repository=new PrismaExecutionRepository(client as any);
  await assert.rejects(()=>repository.recordPaperExit('exec-1','2026-08-17',fill,at,'TARGET_EXIT'),/EXIT_ROLLBACK/);
  assert.equal(invoked,true);
});

test('Prisma execution order IDs are deterministic for duplicate intent callbacks',()=>{
  assert.equal(PrismaExecutionRepository.executionOrderId('intent-1'),PrismaExecutionRepository.executionOrderId('intent-1'));
  assert.notEqual(PrismaExecutionRepository.executionOrderId('intent-1'),PrismaExecutionRepository.executionOrderId('intent-2'));
});

test('injected entry transaction fault runs before any durable mutation',async()=>{
  let mutations=0;const client={$transaction:async(callback:any)=>callback({executionOrder:{findUnique:async()=>{mutations++;return undefined;}}})};
  const faults=new DeterministicExecutionFaultInjector();faults.arm('DURING_ENTRY_DB_TRANSACTION');const repository=new PrismaExecutionRepository(client as any,faults);
  await assert.rejects(()=>repository.createPaperEntry(input),InjectedExecutionFault);assert.equal(mutations,0);
});

test('injected exit/reconciliation faults fail before DB reads or writes',async()=>{
  let transactions=0;const client={$transaction:async()=>{transactions++;throw new Error('should not run');},executionOrder:{findMany:async()=>{throw new Error('should not read');}}};
  const faults=new DeterministicExecutionFaultInjector();faults.arm('BEFORE_EXIT_DB_TRANSACTION');const repository=new PrismaExecutionRepository(client as any,faults);
  await assert.rejects(()=>repository.recordPaperExit('exec-1','2026-08-17',fill,at,'TARGET_EXIT'),InjectedExecutionFault);assert.equal(transactions,0);
  faults.arm('DURING_RECONCILIATION');await assert.rejects(()=>repository.reconcile('2026-08-17'),InjectedExecutionFault);
});

test('injected in-transaction exit fault aborts before a durable exit mutation',async()=>{
  let updates=0;const current={executionOrderId:'exec-1',sessionDate:'2026-08-17',cumulativeFilledQuantity:75,cumulativeExitQuantity:0,fills:[],transitions:[],paperPosition:{positionId:'position-1'}};
  const client={$transaction:async(callback:any)=>callback({executionOrder:{findUnique:async()=>current,update:async()=>{updates++;return current;}}})};
  const faults=new DeterministicExecutionFaultInjector();faults.arm('DURING_EXIT_DB_TRANSACTION');const repository=new PrismaExecutionRepository(client as any,faults);
  await assert.rejects(()=>repository.recordPaperExit('exec-1','2026-08-17',fill,at,'TARGET_EXIT'),InjectedExecutionFault);assert.equal(updates,0);
});
