import assert from 'node:assert/strict';
import test from 'node:test';
import { noExecutionFaults } from './execution-fault-injection';
import { DeterministicExecutionFaultInjector, InjectedExecutionFault } from './execution-fault-injection.test-helper';

test('execution failpoints are disabled by default and require explicit test injection',()=>{
  assert.doesNotThrow(()=>noExecutionFaults.hit('DURING_ENTRY_DB_TRANSACTION'));
  const faults=new DeterministicExecutionFaultInjector();faults.arm('DURING_ENTRY_DB_TRANSACTION');
  assert.throws(()=>faults.hit('DURING_ENTRY_DB_TRANSACTION'),InjectedExecutionFault);
  assert.doesNotThrow(()=>faults.hit('DURING_ENTRY_DB_TRANSACTION'));
  assert.deepEqual(faults.hits,['DURING_ENTRY_DB_TRANSACTION','DURING_ENTRY_DB_TRANSACTION']);
});
