/**
 * A failed action must not destroy the page around it.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * The first real Skip against live billing failed server-side. run()'s catch
 * called fail(), which replaced the entire dashboard with the full-page error
 * screen — "We couldn't load your subscription / SUB-503 · August 31, 2026" —
 * even though the subscription had loaded perfectly seconds earlier and
 * nothing about it had changed. The customer lost their whole view because one
 * action did not go through.
 *
 * Run with:  node --test test/mutation-ux.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const controllerSource = readFileSync(
  resolve(here, '..', 'assets', 'subscription-portal.js'),
  'utf8',
);

const AUTH_FAILURE_CODES = (() => {
  const m = /var AUTH_FAILURE_CODES = (\{[\s\S]*?\});/.exec(controllerSource);
  return new Function(`return ${m[1]}`)();
})();

const NS = {
  PortalError(code, message) {
    const err = new Error(message || code);
    err.name = 'PortalError';
    err.code = code;
    err.reference = null;
    return err;
  },
  dates: { toISO: (d) => d.toISOString().slice(0, 10) },
};

function method(name) {
  const re = new RegExp(
    `Portal\\.prototype\\.${name} = function \\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\};`,
  );
  const m = re.exec(controllerSource);
  assert.ok(m, `Portal.prototype.${name} must exist`);
  return new Function('AUTH_FAILURE_CODES', 'NS', `return function (${m[1]}) {${m[2]}\n};`)(
    AUTH_FAILURE_CODES,
    NS,
  );
}

const run = method('run');
const fail = method('fail');
const actionFailed = method('actionFailed');
const refreshRequired = method('refreshRequired');
const buildReference = method('buildReference');

function portal() {
  const calls = { shown: [], toasts: [], rendered: 0, cleared: 0, sheetClosed: 0 };
  return {
    calls,
    cfg: { mode: 'live', locale: 'en', today: '2026-08-21' },
    state: { pending: null, error: null, success: null, sheet: null, draft: {}, inactive: [], data: null },
    adapter: { hasSession: () => true, clearSession() { calls.cleared += 1; } },
    hasSession() { return this.adapter.hasSession(); },
    clearSessionLocally() { this.adapter.clearSession(); },
    refreshAuthenticatedData() { return Promise.resolve(); },
    applyPending() {},
    render() { calls.rendered += 1; },
    closeSheet() { calls.sheetClosed += 1; },
    toast(m) { calls.toasts.push(m); },
    show(s) { calls.shown.push(s); },
    fail(err) { return fail.call(this, err); },
    actionFailed(err) { return actionFailed.call(this, err); },
    refreshRequired() { return refreshRequired.call(this); },
    buildReference(err) { return buildReference.call(this, err); },
    fmtDate() { return '24 October 2026'; },
  };
}

describe('a failed action keeps the dashboard', () => {
  test('a server failure never shows the full-page error screen', async () => {
    const p = portal();

    await run.call(p, 'skip', () => Promise.reject(NS.PortalError('upstream_error', 'boom')), {
      then() {},
    });

    // THE regression: no 'error' screen, and no error state behind it.
    assert.ok(!p.calls.shown.includes('error'), 'the dashboard must survive a failed action');
    assert.equal(p.state.error, null);
    // The customer is told something, inline.
    assert.equal(p.calls.toasts.length, 1);
    assert.match(p.calls.toasts[0], /did not go through/i);
    // And the sheet closed.
    assert.ok(p.calls.sheetClosed > 0);
  });

  test('every non-auth failure code stays on the page', async () => {
    for (const code of ['upstream_error', 'upstream_unavailable', 'server', 'network', 'in_progress', 'timeout', 'not_enabled']) {
      const p = portal();
      await run.call(p, 'skip', () => Promise.reject(NS.PortalError(code, '')), { then() {} });
      assert.ok(!p.calls.shown.includes('error'), `${code} must not take over the page`);
      assert.equal(p.state.error, null, code);
      assert.equal(p.calls.toasts.length, 1, code);
    }
  });

  test('an authentication failure still takes over — there is nothing to show', async () => {
    for (const code of Object.keys(AUTH_FAILURE_CODES)) {
      const p = portal();
      await run.call(p, 'skip', () => Promise.reject(NS.PortalError(code, '')), { then() {} });
      assert.deepEqual(p.calls.shown, ['login'], code);
      assert.equal(p.calls.cleared, 1, code);
    }
  });

  test('a timeout says the outcome is unknown, never that nothing changed', () => {
    const p = portal();
    actionFailed.call(p, NS.PortalError('timeout', ''));

    const msg = p.calls.toasts[0];
    assert.match(msg, /refresh/i);
    assert.ok(!/nothing has changed/i.test(msg));
    assert.ok(!/did not go through/i.test(msg));
  });

  test('an ordinary failure may say nothing changed, because nothing did', () => {
    const p = portal();
    actionFailed.call(p, NS.PortalError('upstream_error', ''));
    assert.match(p.calls.toasts[0], /nothing has changed/i);
  });
});

describe('a successful action confirms on the dashboard', () => {
  test('closes the sheet, stays put, re-renders and confirms', async () => {
    const p = portal();

    await run.call(p, 'skip', () => Promise.resolve({ id: 'sub_1', nextOrderDate: '2026-10-24' }), {
      then(st) {
        p.show('dashboard');
      },
      toast: () => 'Delivery skipped — next one 24 October 2026',
    });

    assert.ok(p.calls.sheetClosed > 0, 'the confirmation sheet must close');
    assert.deepEqual(p.calls.shown, ['dashboard'], 'stays on the dashboard');
    assert.ok(!p.calls.shown.includes('error'));
    assert.equal(p.calls.toasts.length, 1);
    assert.match(p.calls.toasts[0], /skipped/i);
  });

  test('the shipped skip action confirms inline rather than on a success screen', () => {
    const start = controllerSource.indexOf("case 'skip': {");
    const block = controllerSource.slice(start, controllerSource.indexOf("case 'undo'", start));
    // No takeover screen for a skip.
    assert.ok(!/show\('success'\)/.test(block));
    assert.match(block, /toast:/);
    assert.match(block, /show\('dashboard'\)/);
  });
});

describe('the write applied but the refresh did not', () => {
  test('is reported as success with a refresh prompt, never as a failure', async () => {
    const p = portal();

    await run.call(p, 'skip', () => Promise.resolve({ refreshRequired: true }), {
      then() {
        throw new Error('the normal success path must not run for a stale result');
      },
      toast: () => 'should not be used',
    });

    assert.ok(!p.calls.shown.includes('error'));
    assert.equal(p.state.error, null);
    assert.equal(p.calls.toasts.length, 1);

    const msg = p.calls.toasts[0];
    // It worked.
    assert.match(msg, /done/i);
    assert.match(msg, /refresh/i);
    // It must NOT claim nothing happened — that is what would tempt a customer
    // to run a real billing mutation a second time.
    assert.ok(!/nothing has changed/i.test(msg));
    assert.ok(!/did not go through/i.test(msg));
    assert.ok(!/failed/i.test(msg));
  });

  test('the sheet still closes on a stale success', async () => {
    const p = portal();
    await run.call(p, 'skip', () => Promise.resolve({ refreshRequired: true }), { then() {} });
    assert.ok(p.calls.sheetClosed > 0);
  });
});

describe('SUB-503 can no longer be produced by an action', () => {
  test('actionFailed writes no error reference at all', () => {
    const p = portal();
    actionFailed.call(p, NS.PortalError('upstream_error', ''));
    assert.equal(p.state.error, null, 'no reference, because there is no error screen');
  });

  test('the error screen remains reachable only from boot and retry', () => {
    // fail() is the only thing that shows it, and run() now routes only auth
    // failures there.
    const runBody = /Portal\.prototype\.run = function[\s\S]*?\n  \};/.exec(controllerSource)[0];
    assert.match(runBody, /AUTH_FAILURE_CODES\[err\.code\]/);
    assert.match(runBody, /self\.actionFailed\(err\)/);
  });
});
