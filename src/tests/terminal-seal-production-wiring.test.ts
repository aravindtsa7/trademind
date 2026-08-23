import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

/**
 * A10 final correction: static-wiring checks against the REAL V2/V4/V8 live
 * entrypoints (not a mirrored local harness) proving each one uses
 * StrategyTerminalOutcomeArbiter.sealAfterCloseOut() -- the single production
 * seam that runs close-out to completion (or escalates to FAULTED) BEFORE the
 * durable SUMMARY/CLEAN_SHUTDOWN write -- gates every direct
 * StrategyHostLifecycle.fault() call from an external trigger behind
 * isSealing(), and (the A10 acceptance-fail correction) never executes any
 * potentially-throwing statement AFTER the authoritative SUMMARY append has
 * succeeded, anywhere in the terminal path. These files execute a live
 * trading script on import (`void run().catch(...)`), so they are inspected
 * as text rather than imported.
 */
const runtimes: Record<'V2' | 'V4' | 'V8', string> = {
  V2: 'src/tests/test-live-paper-trading.ts',
  V4: 'src/tests/test-live-v4-nifty-momentum-shadow.ts',
  V8: 'src/tests/test-live-v8-nifty-bullish-reclaim-shadow.ts',
};

function source(file: string): string {
  return readFileSync(resolve(process.cwd(), file), 'utf8');
}

/**
 * Returns the index one past the `)` that matches the `(` immediately
 * preceding `fromIndex` (i.e. `fromIndex` must point at the character right
 * after an opening `(`). A plain depth counter is sufficient here -- every
 * parenthesis in the spans this test inspects is a real, balanced JS
 * paren (template-literal interpolations like `${x.toFixed(2)}` still nest
 * correctly under simple counting).
 */
function matchParen(text: string, fromIndex: number): number {
  let depth = 1;
  let i = fromIndex;
  for (; i < text.length && depth > 0; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') depth -= 1;
  }
  if (depth !== 0) throw new Error(`Unbalanced parentheses scanning from index ${fromIndex}`);
  return i; // index just past the matching ')'
}

/** Same idea for `{`/`}`, given an index just past the opening `{`. */
function matchBrace(text: string, fromIndex: number): number {
  let depth = 1;
  let i = fromIndex;
  for (; i < text.length && depth > 0; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') depth -= 1;
  }
  if (depth !== 0) throw new Error(`Unbalanced braces scanning from index ${fromIndex}`);
  return i; // index just past the matching '}'
}

/** Extracts the body of a `const <name> = ... => { ... };` (or `async (...) => {...}`) function by name, as [bodyStart, bodyEnd) indices into `text` (bodyEnd points just past the matching '}'). */
function functionBody(text: string, declaration: string): { start: number; end: number } {
  const declIndex = text.indexOf(declaration);
  if (declIndex < 0) throw new Error(`Could not find declaration: ${declaration}`);
  const braceOpen = text.indexOf('{', declIndex);
  if (braceOpen < 0) throw new Error(`Could not find opening brace after: ${declaration}`);
  const start = braceOpen + 1;
  const end = matchBrace(text, start) - 1; // index of the matching '}'
  return { start, end };
}

test('V2/V4/V8 each seal their terminal outcome through sealAfterCloseOut(), never a bare commit() call in their shutdown path', () => {
  for (const [name, file] of Object.entries(runtimes)) {
    const text = source(file);
    assert.ok(text.includes('terminalOutcomeArbiter.sealAfterCloseOut('), `${name}: expected sealAfterCloseOut() to be the production finalization seam`);
    assert.ok(!text.includes('terminalOutcomeArbiter.commit('), `${name}: a bare commit() call would let close-out run AFTER the durable write instead of before it`);
  }
});

test('V2/V4/V8 each write CLEAN_SHUTDOWN before SUMMARY inside their sealAfterCloseOut() write callback', () => {
  for (const [name, file] of Object.entries(runtimes)) {
    const text = source(file);
    const sealStart = text.indexOf('terminalOutcomeArbiter.sealAfterCloseOut(');
    assert.ok(sealStart >= 0, `${name}: expected a sealAfterCloseOut() call`);
    const sealBlock = text.slice(sealStart, text.indexOf('\n  };', sealStart) > 0 ? text.indexOf('\n  };', sealStart) : text.length);
    const cleanShutdownIndex = sealBlock.indexOf("'CLEAN_SHUTDOWN'");
    const summaryIndex = sealBlock.indexOf("recordType: 'SUMMARY'");
    assert.ok(cleanShutdownIndex >= 0, `${name}: expected a CLEAN_SHUTDOWN append inside the seal write callback`);
    assert.ok(summaryIndex >= 0, `${name}: expected a SUMMARY append inside the seal write callback`);
    assert.ok(cleanShutdownIndex < summaryIndex, `${name}: CLEAN_SHUTDOWN (non-authoritative) must be durable before SUMMARY (the A9-authoritative record) so a CLEAN_SHUTDOWN write failure can never leave a misleading VALID_COMPLETED SUMMARY behind`);
  }
});

test('V2/V4/V8 each gate every direct external StrategyHostLifecycle.fault() call behind terminalOutcomeArbiter.isSealing()', () => {
  for (const [name, file] of Object.entries(runtimes)) {
    const text = source(file);
    const faultCallSites = [...text.matchAll(/host\??\.fault\(/g)];
    assert.ok(faultCallSites.length > 0, `${name}: expected at least one external host.fault() call site (reconnectFailed, or equivalent)`);
    for (const match of faultCallSites) {
      const precedingLine = text.slice(Math.max(0, match.index! - 220), match.index!);
      assert.ok(
        precedingLine.includes('isSealing()'),
        `${name}: host.fault() call at offset ${match.index} must be gated by !terminalOutcomeArbiter.isSealing() so a racing external fault trigger cannot flip host state once the arbiter has already frozen a different outcome. Context: ${JSON.stringify(precedingLine.slice(-160))}`,
      );
    }
  }
});

/**
 * A10 acceptance-fail correction: the authoritative SUMMARY append must be
 * the LAST potentially-throwing operation, both (a) inside the
 * sealAfterCloseOut() writer callback itself, and (b) in the enclosing
 * shutdown()/terminal-hook body as a whole -- nothing may run after
 * sealAfterCloseOut() resolves. This is checked structurally (paren/brace
 * matching against the real file), not by a substring the source could
 * satisfy while still hiding trailing statements.
 */
test('V2/V4/V8: the SUMMARY append is the final statement inside the sealAfterCloseOut() writer callback -- nothing (no console.log, no further appends) follows it', () => {
  for (const [name, file] of Object.entries(runtimes)) {
    const text = source(file);
    const sealCallIndex = text.indexOf('terminalOutcomeArbiter.sealAfterCloseOut(');
    assert.ok(sealCallIndex >= 0, `${name}: expected a sealAfterCloseOut() call`);
    const sealArgsOpen = text.indexOf('(', sealCallIndex + 'terminalOutcomeArbiter.sealAfterCloseOut'.length);
    const sealArgsClose = matchParen(text, sealArgsOpen + 1); // index just past sealAfterCloseOut(...)'s matching ')'
    const sealArgsText = text.slice(sealArgsOpen + 1, sealArgsClose - 1);

    // The writer is the second top-level argument: locate it by its arrow-function
    // signature `(finalReason) => {` (V2/V4/V8 all name the parameter identically).
    const writerSignature = '(finalReason) => {';
    const writerSigIndex = sealArgsText.indexOf(writerSignature);
    assert.ok(writerSigIndex >= 0, `${name}: expected the sealAfterCloseOut() writer callback signature "${writerSignature}"`);
    const writerBodyStart = writerSigIndex + writerSignature.length;
    const writerBodyEnd = matchBrace(sealArgsText, writerBodyStart) - 1; // index of writer's own matching '}'
    const writerBody = sealArgsText.slice(writerBodyStart, writerBodyEnd);

    // Locate the SUMMARY append call (`forwardJournal.append(` or `journal.append(`
    // whose object literal contains `recordType: 'SUMMARY'`) and find where its own
    // call parentheses close.
    const summaryRecordIndex = writerBody.indexOf("recordType: 'SUMMARY'");
    assert.ok(summaryRecordIndex >= 0, `${name}: expected a SUMMARY append inside the writer callback`);
    const appendCallIndex = writerBody.lastIndexOf('.append(', summaryRecordIndex);
    assert.ok(appendCallIndex >= 0, `${name}: expected an X.append(...) call wrapping the SUMMARY record`);
    const appendOpenParen = appendCallIndex + '.append('.length;
    const appendCloseParen = matchParen(writerBody, appendOpenParen); // index just past the append(...) call's matching ')'

    const afterSummaryAppend = writerBody.slice(appendCloseParen).replace(/^;/, '');
    assert.equal(
      afterSummaryAppend.trim(),
      '',
      `${name}: found executable content after the SUMMARY append inside the writer callback -- the durable SUMMARY append must be the final statement. Trailing content: ${JSON.stringify(afterSummaryAppend.trim().slice(0, 200))}`,
    );
  }
});

test('V2/V4/V8: nothing potentially-throwing runs after sealAfterCloseOut() resolves in the shutdown()/onEod terminal-hook body -- no reportShutdownObservability(), console.log, tracker/counters read, or listener removal follows the seal', () => {
  const declarations: Record<'V2' | 'V4' | 'V8', string> = {
    V2: 'const shutdown = async (reason: string, onCloseOutComplete?: () => void): Promise<void> => {',
    V4: "const shutdown = async (reason = 'SESSION_END', onCloseOutComplete?: () => void): Promise<void> => {",
    V8: 'const shutdown = async (reason: string) => {',
  };
  for (const [name, file] of Object.entries(runtimes)) {
    const text = source(file);
    const declaration = declarations[name as 'V2' | 'V4' | 'V8'];
    const { start, end } = functionBody(text, declaration);
    const body = text.slice(start, end);

    const sealCallIndex = body.indexOf('terminalOutcomeArbiter.sealAfterCloseOut(');
    assert.ok(sealCallIndex >= 0, `${name}: expected sealAfterCloseOut() inside shutdown()`);
    const sealArgsOpen = body.indexOf('(', sealCallIndex + 'terminalOutcomeArbiter.sealAfterCloseOut'.length);
    const sealArgsClose = matchParen(body, sealArgsOpen + 1); // index just past sealAfterCloseOut(...)'s matching ')'

    const afterSeal = body.slice(sealArgsClose).replace(/^;/, '');
    assert.equal(
      afterSeal.trim(),
      '',
      `${name}: found executable content in shutdown()/onEod after sealAfterCloseOut() resolves. A successful VALID_COMPLETED SUMMARY (written inside sealAfterCloseOut()) must never be followed by any statement whose failure could reject this hook and fault an already-completed host. Trailing content: ${JSON.stringify(afterSeal.trim().slice(0, 300))}`,
    );
  }
});

/**
 * A10 V2 final post-SUMMARY micro-fix: performDurableEodExit() is a SEPARATE
 * wrapper around `await shutdown(...)` -- the "nothing after sealAfterCloseOut()
 * inside shutdown()" check above does not see into this function, so it must be
 * checked independently. Codex's acceptance-fail defect was exactly this: V2's
 * onEod hook (performDurableEodExit) still ran runtime.getStatus(),
 * orderManager.getActiveOrders(), and a V2_EOD_SUMMARY console.log AFTER
 * `await shutdown(...)` had already sealed and durably written SUMMARY.
 */
test('V2: performDurableEodExit() treats `await shutdown(...)` as its final executable statement -- no status/order read, log, or other operation follows it', () => {
  const text = source(runtimes.V2);
  const { start, end } = functionBody(text, 'const performDurableEodExit = async (): Promise<void> => {');
  const body = text.slice(start, end);

  // Anchored on the real call's first argument (not the generic `await shutdown(...)`
  // phrase, which also appears verbatim inside this function's own explanatory comment).
  const shutdownCallIndex = body.indexOf("await shutdown('EOD_NSE_SESSION_CLOSE'");
  assert.ok(shutdownCallIndex >= 0, "V2: expected an `await shutdown('EOD_NSE_SESSION_CLOSE', ...)` call inside performDurableEodExit()");
  const shutdownArgsOpen = body.indexOf('(', shutdownCallIndex + 'await shutdown'.length);
  const shutdownArgsClose = matchParen(body, shutdownArgsOpen + 1); // index just past shutdown(...)'s matching ')'

  const afterShutdownCall = body.slice(shutdownArgsClose).replace(/^;/, '');
  assert.equal(
    afterShutdownCall.trim(),
    '',
    `V2: found executable content in performDurableEodExit() after \`await shutdown(...)\` -- a successful VALID_COMPLETED SUMMARY (already durably written by then) must never be followed by a statement whose failure could reject StrategyHostLifecycle's onEod and fault an already-completed host. Trailing content: ${JSON.stringify(afterShutdownCall.trim().slice(0, 300))}`,
  );

  // The V2_EOD_SUMMARY status/order reads and log must now live INSIDE the
  // shutdown(...) call's own arguments (i.e. the onCloseOutComplete callback,
  // which sealAfterCloseOut() runs pre-seal) -- not merely absent from after it.
  const shutdownArgsText = body.slice(shutdownArgsOpen + 1, shutdownArgsClose - 1);
  assert.ok(shutdownArgsText.includes('V2_EOD_SUMMARY'), 'V2: expected the V2_EOD_SUMMARY log to be passed into shutdown() as pre-seal close-out observability');
  assert.ok(shutdownArgsText.includes('runtime.getStatus()'), 'V2: expected runtime.getStatus() to run pre-seal, inside the shutdown() call arguments');
  assert.ok(shutdownArgsText.includes('orderManager.getActiveOrders()'), 'V2: expected orderManager.getActiveOrders() to run pre-seal, inside the shutdown() call arguments');
});

test('V2/V4/V8: the real entrypoints do not reintroduce a post-SUMMARY statement via a differently-named wrapper (reportShutdownObservability, counters.snapshot, tracker reads, console.log, or an awaited call) anywhere after the sealAfterCloseOut() call', () => {
  // Belt-and-suspenders literal scan in addition to the structural brace/paren
  // checks above: these specific symbols, if ever found textually AFTER the
  // sealAfterCloseOut( call within the same shutdown()-sized window, are exactly
  // what Codex's acceptance-fail flagged (V2's reportShutdownObservability(),
  // V4's finishEod tracker read/log, V8's counters.snapshot() + console.log).
  const forbiddenAfterSeal: Record<'V2' | 'V4' | 'V8', string[]> = {
    V2: ['reportShutdownObservability('],
    V4: ['tracker.getClosed()', 'V4_EOD_SUMMARY'],
    V8: ['counters.snapshot()', 'V8_EOD_SUMMARY'],
  };
  for (const [name, file] of Object.entries(runtimes)) {
    const text = source(file);
    const sealCallIndex = text.indexOf('terminalOutcomeArbiter.sealAfterCloseOut(');
    assert.ok(sealCallIndex >= 0, `${name}: expected a sealAfterCloseOut() call`);
    const sealArgsOpen = text.indexOf('(', sealCallIndex + 'terminalOutcomeArbiter.sealAfterCloseOut'.length);
    const sealArgsClose = matchParen(text, sealArgsOpen + 1);
    // Look only in the ~400 chars immediately following the seal call (well past
    // any closing `};` of the enclosing function) -- long enough to catch a
    // reintroduced trailing statement, short enough not to false-positive on an
    // unrelated later function that happens to reuse one of these symbols.
    const window = text.slice(sealArgsClose, sealArgsClose + 400);
    for (const forbidden of forbiddenAfterSeal[name as 'V2' | 'V4' | 'V8']) {
      assert.ok(!window.includes(forbidden), `${name}: found forbidden post-seal symbol "${forbidden}" within 400 chars after sealAfterCloseOut() -- this must run pre-seal (inside the closeOut callback) or not at all. Window: ${JSON.stringify(window)}`);
    }
  }
});
