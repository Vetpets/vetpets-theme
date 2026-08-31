/**
 * The frontend half of the authentication state machine.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * `run()` is the mutation runner: after any successful work it re-reads
 * loyalty, subscriptions and deliveries. `sendLink` also used `run()`, so a
 * SUCCESSFUL magic-link request immediately performed three AUTHENTICATED
 * portal reads — before any link had been opened, before any handoff existed
 * and before any session existed. Those reads failed as `unauthenticated`,
 * run()'s catch called fail(), and the customer saw SUB-503 instead of
 * "Check your inbox". Production matched exactly: a magic_link row, no
 * auth_handoff, no portal_session, and SUB-503 on screen.
 *
 * These tests execute the SHIPPED function bodies, lifted out of
 * assets/subscription-portal.js, against stand-ins. They are behavioural, not
 * source greps: a regression has to change what the code does, not merely how
 * it is written.
 *
 * Run with:  node --test test/auth-state-machine.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const controllerSource = readFileSync(
  resolve(here, '..', 'assets', 'subscription-portal.js'),
  'utf8',
);
const adapterSource = readFileSync(
  resolve(here, '..', 'assets', 'subscription-portal-adapter.js'),
  'utf8',
);

/** The shipped AUTH_FAILURE_CODES table, parsed from the controller. */
const AUTH_FAILURE_CODES = (() => {
  const m = /var AUTH_FAILURE_CODES = (\{[\s\S]*?\});/.exec(controllerSource);
  assert.ok(m, 'AUTH_FAILURE_CODES must exist');
  return new Function(`return ${m[1]}`)();
})();

/** Minimal stand-in for the adapter namespace the controller closes over. */
const NS = {
  PortalError(code, message) {
    const err = new Error(message || code);
    err.name = 'PortalError';
    err.code = code;
    err.reference = null;
    return err;
  },
  dates: {
    toISO(d) {
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${d.getFullYear()}-${m}-${day}`;
    },
  },
};

/** Lift one `Portal.prototype.<name>` out of the shipped file and compile it. */
function method(name) {
  const re = new RegExp(
    `Portal\\.prototype\\.${name} = function \\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\};`,
  );
  const m = re.exec(controllerSource);
  assert.ok(m, `Portal.prototype.${name} must exist`);
  const factory = new Function(
    'AUTH_FAILURE_CODES',
    'NS',
    `return function (${m[1]}) {${m[2]}\n};`,
  );
  return factory(AUTH_FAILURE_CODES, NS);
}

const run = method('run');
const fail = method('fail');
const buildReference = method('buildReference');
const refreshAuthenticatedData = method('refreshAuthenticatedData');

/** A portal stand-in that records what the real one would have done. */
function portal(overrides = {}) {
  const calls = { shown: [], refreshed: 0, cleared: 0, toasts: [], rendered: 0 };
  return {
    calls,
    cfg: { mode: 'live', today: '2026-08-21', locale: 'en' },
    state: { pending: null, error: null, success: null, sheet: null, draft: {}, inactive: [] },
    adapter: {
      hasSession: () => true,
      clearSession() {
        calls.cleared += 1;
      },
    },
    hasSession() {
      return this.adapter.hasSession();
    },
    clearSessionLocally() {
      this.adapter.clearSession();
    },
    refreshAuthenticatedData() {
      calls.refreshed += 1;
      return Promise.resolve();
    },
    applyPending() {},
    render() {
      calls.rendered += 1;
    },
    closeSheet() {},
    toast(m) {
      calls.toasts.push(m);
    },
    show(screen) {
      calls.shown.push(screen);
    },
    fail(err) {
      return fail.call(this, err);
    },
    buildReference(err) {
      return buildReference.call(this, err);
    },
    fmtDate() {
      return '30 August 2026';
    },
    ...overrides,
  };
}

describe('requesting a magic link never reads the portal', () => {
  test('refresh:false performs no authenticated read and shows the sent screen', async () => {
    const p = portal();
    let showedSent = false;

    await run.call(p, 'sendLink', () => Promise.resolve({ ok: true, expiresInMinutes: 15 }), {
      closeSheet: false,
      refresh: false,
      then() {
        showedSent = true;
        p.show('sent');
      },
    });

    assert.equal(p.calls.refreshed, 0, 'no authenticated read may happen before a session exists');
    assert.ok(showedSent);
    assert.deepEqual(p.calls.shown, ['sent']);
    // Crucially: no error screen.
    assert.ok(!p.calls.shown.includes('error'));
  });

  test('the old behaviour is what produced SUB-503: without refresh:false it reads', async () => {
    const p = portal();

    await run.call(p, 'skip', () => Promise.resolve({ id: 'sub_1' }), {
      then() {},
    });

    // A subscription mutation SHOULD refresh — that is what run() is for.
    assert.equal(p.calls.refreshed, 1);
  });

  test('an unauthenticated refresh lands on sign-in, not the error screen', async () => {
    const p = portal();
    p.adapter.hasSession = () => false;
    // Use the real refresh, which guards on hasSession.
    p.refreshAuthenticatedData = function () {
      return refreshAuthenticatedData.call(this);
    };

    await run.call(p, 'skip', () => Promise.resolve({ id: 'sub_1' }), { then() {} });

    assert.deepEqual(p.calls.shown, ['login']);
    assert.equal(p.state.error, null);
  });

  test('both auth actions in the shipped file pass refresh:false', () => {
    for (const act of ['sendLink', 'resend']) {
      const start = controllerSource.indexOf(`this.run('${act}'`);
      assert.notEqual(start, -1, `${act} must call run()`);
      // The options object follows the work function within this window.
      const block = controllerSource.slice(start, start + 600);
      assert.match(block, /refresh: false/, `${act} must not trigger an authenticated read`);
    }
  });
});

describe('a 401 returns to a clean auth screen', () => {
  test('fail() on unauthenticated clears the session and shows login', () => {
    const p = portal();

    fail.call(p, NS.PortalError('unauthenticated', 'nope'));

    assert.equal(p.calls.cleared, 1, 'the dead token must be dropped');
    assert.deepEqual(p.calls.shown, ['login']);
    assert.equal(p.state.error, null, 'no error state may linger behind the auth screen');
    assert.equal(p.state.pending, null);
  });

  test('every auth failure code routes to login, never to the error screen', () => {
    for (const code of Object.keys(AUTH_FAILURE_CODES)) {
      const p = portal();
      fail.call(p, NS.PortalError(code, ''));
      assert.deepEqual(p.calls.shown, ['login'], `${code} must show sign-in`);
      assert.equal(p.state.error, null);
    }
  });

  test('a genuine service failure still shows the error screen', () => {
    const p = portal();

    fail.call(p, NS.PortalError('upstream_unavailable', 'phoenix down'));

    assert.deepEqual(p.calls.shown, ['error']);
    assert.equal(p.state.error.code, 'upstream_unavailable');
    assert.match(p.state.error.reference, /^SUB-503 /);
  });

  test('the adapter clears sessionStorage without a network call', () => {
    const store = new Map();
    const win = {
      document: { querySelector: () => null },
      location: { search: '', pathname: '/', hash: '' },
      history: { state: null, replaceState() {} },
      sessionStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, v),
        removeItem: (k) => store.delete(k),
      },
      URLSearchParams,
      fetch: () => Promise.reject(new Error('no network in tests')),
    };
    const ctx = vm.createContext({ window: win, URLSearchParams, JSON, Promise, Math, Date, console });
    vm.runInContext(adapterSource, ctx);

    let requests = 0;
    const adapter = win.VetPetsPortal.createHttpAdapter({
      fetchImpl: () => {
        requests += 1;
        return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve('{}') });
      },
    });

    store.set('vp_portal_session', 'stale-token');
    assert.equal(adapter.hasSession(), true);

    adapter.clearSession();

    assert.equal(adapter.hasSession(), false);
    assert.equal(store.has('vp_portal_session'), false);
    assert.equal(requests, 0, 'clearing a dead token must not call the server');
  });
});

describe('retry uses the same rule as boot', () => {
  test('retry with no session shows sign-in and never renders SUB-503', () => {
    const start = controllerSource.indexOf("case 'retry':");
    assert.notEqual(start, -1, 'the retry action must exist');
    const end = controllerSource.indexOf("case '", start + 10);
    const block = controllerSource.slice(start, end);

    // It must consult hasSession and route every failure through fail(),
    // rather than carrying its own handler that can drift from boot's.
    assert.match(block, /hasSession\(\)/);
    assert.match(block, /this\.fail\(/);
    assert.match(block, /catch\(function \(e\) \{ self\.fail\(e\); \}\)/);
    // And it must not classify errors itself.
    assert.ok(!/unauthenticated'\s*\|\||show\('error'\)/.test(block));
  });

  test('boot shares the single failure handler', () => {
    const onFailure = /function onFailure\(err\) \{([\s\S]*?)\n    \}/.exec(controllerSource);
    assert.ok(onFailure, 'bootLive must have onFailure');
    // No duplicated code list: the rule lives in fail() alone.
    assert.match(onFailure[1], /self\.fail\(err\)/);
    assert.ok(!/unauthenticated/.test(onFailure[1]), 'the auth rule must not be duplicated here');
  });
});

describe('SUB-503 is reserved for an authenticated service failure', () => {
  test('auth codes never produce a SUB-503 reference', () => {
    const p = portal();
    for (const code of Object.keys(AUTH_FAILURE_CODES)) {
      const ref = buildReference.call(p, NS.PortalError(code, ''));
      assert.ok(!ref.startsWith('SUB-503'), `${code} must not read as SUB-503`);
      assert.ok(ref.startsWith('SUB-AUTH'));
    }
  });

  test('service and network failures keep their own codes', () => {
    const p = portal();
    assert.match(buildReference.call(p, NS.PortalError('network', '')), /^SUB-000 /);
    assert.match(buildReference.call(p, NS.PortalError('mock_in_production', '')), /^SUB-CFG /);
    assert.match(buildReference.call(p, NS.PortalError('upstream_error', '')), /^SUB-503 /);
    assert.match(buildReference.call(p, NS.PortalError('server', '')), /^SUB-503 /);
  });
});
