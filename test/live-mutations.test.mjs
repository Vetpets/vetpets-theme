/**
 * The live adapter's mutation surface.
 *
 * What matters here is what the BROWSER sends. The server derives identity
 * from the session and ignores anything else, but the client should not be
 * offering it a choice in the first place: no CustomerId, no email, and no
 * free text a customer typed.
 *
 * Run with:  node --test test/live-mutations.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '..', 'assets', 'subscription-portal-adapter.js'), 'utf8');

const VIEW = {
  state: 'subscription',
  customer: { firstName: 'Test' },
  subscription: {
    status: 'active',
    subscriptionId: '5600001',
    nextBillingDate: '2026-07-10',
    upcomingCharge: { state: 'available', amount: 1.2, currencyCode: 'USD' },
    cadence: { state: 'available', intervalDays: 30 },
    lines: [{ title: 'ExampleWipes Kit', productId: '1', variantId: '2', quantity: 2 }],
    deliveryAddress: null,
    payment: null,
    initialPayment: { state: 'unavailable', reason: 'x' },
    recentPayments: [],
  },
};

/** Build a live adapter over a recording fetch. */
function adapterWith(responder) {
  const store = new Map([['vp_portal_session', 'session-token-abc']]);
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
  vm.runInContext(source, ctx);

  const sent = [];
  const adapter = win.VetPetsPortal.createHttpAdapter({
    fetchImpl: (url, init) => {
      const body = JSON.parse(init.body);
      sent.push({ url, body });
      return Promise.resolve(responder ? responder(url, body) : okView());
    },
  });
  return { adapter, sent, store };
}

function okView() {
  return {
    status: 200,
    ok: true,
    text: () => Promise.resolve(JSON.stringify({ status: 'ok', view: VIEW })),
  };
}
function errorAt(status, error) {
  return {
    status,
    ok: false,
    text: () => Promise.resolve(JSON.stringify({ error })),
  };
}

describe('what the browser sends', () => {
  test('each action posts to its own route', async () => {
    const cases = [
      ['skipNextDelivery', (a) => a.skipNextDelivery('sub_1'), '/portal/skip', {}],
      ['delayNextDelivery', (a) => a.delayNextDelivery('sub_1', 15), '/portal/delay', { days: 15 }],
      [
        'rescheduleNextDelivery',
        (a) => a.rescheduleNextDelivery('sub_1', '2026-12-01'),
        '/portal/reschedule',
        { date: '2026-12-01' },
      ],
      ['cancel', (a) => a.cancel('sub_1', 'price', 'free text'), '/portal/cancel', { reason: 'price' }],
      ['reactivate', (a) => a.reactivate('sub_1', 14), '/portal/reactivate', {}],
    ];

    for (const [name, run, path, extra] of cases) {
      const { adapter, sent } = adapterWith();
      await run(adapter);

      assert.equal(sent.length, 1, name);
      assert.ok(sent[0].url.endsWith(path), `${name} -> ${sent[0].url}`);
      for (const [k, v] of Object.entries(extra)) {
        assert.deepEqual(sent[0].body[k], v, `${name}.${k}`);
      }
    }
  });

  test('always confirms explicitly and carries an idempotency key', async () => {
    const { adapter, sent } = adapterWith();
    await adapter.skipNextDelivery('sub_1');

    assert.equal(sent[0].body.confirm, true);
    assert.equal(typeof sent[0].body.idempotencyKey, 'string');
    assert.ok(sent[0].body.idempotencyKey.length >= 8);
  });

  test('a retry may reuse the caller’s key, so it cannot apply twice', async () => {
    const { adapter, sent } = adapterWith();
    await adapter.skipNextDelivery('sub_1', { idempotencyKey: 'caller-supplied-key-1' });
    await adapter.skipNextDelivery('sub_1', { idempotencyKey: 'caller-supplied-key-1' });

    assert.equal(sent[0].body.idempotencyKey, 'caller-supplied-key-1');
    assert.equal(sent[1].body.idempotencyKey, 'caller-supplied-key-1');
  });

  test('two separate attempts get different keys', async () => {
    const { adapter, sent } = adapterWith();
    await adapter.skipNextDelivery('sub_1');
    await adapter.skipNextDelivery('sub_1');
    assert.notEqual(sent[0].body.idempotencyKey, sent[1].body.idempotencyKey);
  });

  test('sends no CustomerId, no email and no free text', async () => {
    const { adapter, sent } = adapterWith();
    await adapter.cancel('sub_1', 'pet', 'my dog sadly passed away');

    const keys = Object.keys(sent[0].body).sort();
    assert.deepEqual(keys, ['confirm', 'idempotencyKey', 'reason', 'session']);

    const serialised = JSON.stringify(sent[0].body);
    assert.ok(!/customerid/i.test(serialised));
    assert.ok(!serialised.includes('@'));
    // The note the customer typed must not reach a third-party billing system.
    assert.ok(!serialised.includes('passed away'));
  });
});

describe('what the browser does with the answer', () => {
  test('adopts the server’s re-read rather than an optimistic guess', async () => {
    const { adapter } = adapterWith();
    const result = await adapter.skipNextDelivery('sub_1');

    // Straight from the returned view, not from anything the client assumed.
    assert.equal(result.nextOrderDate, '2026-07-10');
    assert.equal(result.status, 'active');

    // And a following read is served from that same view, with no extra call.
    const again = await adapter.getSubscription();
    assert.equal(again.nextOrderDate, '2026-07-10');
  });

  test('a 401 clears the session so the page returns to sign-in', async () => {
    const { adapter, store } = adapterWith(() => errorAt(401, 'unauthenticated'));

    const err = await adapter.cancel('sub_1', 'price').catch((e) => e);
    assert.equal(err.code, 'unauthenticated');
    assert.equal(store.has('vp_portal_session'), false);
  });

  test('a closed capability gate is reported as such, not as a server fault', async () => {
    const { adapter } = adapterWith(() => errorAt(403, 'not_enabled'));
    const err = await adapter.skipNextDelivery('sub_1').catch((e) => e);
    assert.equal(err.code, 'not_enabled');
  });

  test('a duplicate in flight is not reported as a failure', async () => {
    const { adapter } = adapterWith(() => errorAt(409, 'operation_in_progress'));
    const err = await adapter.cancel('sub_1', 'price').catch((e) => e);
    assert.equal(err.code, 'in_progress');
    assert.ok(!/failed/i.test(err.message));
  });

  test('a timeout never claims the change did or did not happen', async () => {
    const { adapter } = adapterWith(() => errorAt(504, 'upstream_timeout'));
    const err = await adapter.skipNextDelivery('sub_1').catch((e) => e);

    assert.equal(err.code, 'timeout');
    // The copy must not assert an outcome we cannot know.
    assert.ok(!/cancelled|skipped|failed|did not/i.test(err.message));
    assert.match(err.message, /refresh/i);
  });

  test('a malformed success body is refused rather than rendered', async () => {
    const { adapter } = adapterWith(() => ({
      status: 200,
      ok: true,
      text: () => Promise.resolve('{"status":"ok"}'), // no view
    }));
    const err = await adapter.skipNextDelivery('sub_1').catch((e) => e);
    // `instanceof Error` is useless here: the adapter runs in a vm realm, so
    // its Error is a different constructor from this file's.
    assert.equal(err.name, 'PortalError');
    assert.equal(err.code, 'server');
    assert.ok(!/undefined/.test(err.message));
  });

  test('no mutation is attempted without a session', async () => {
    const { adapter, sent, store } = adapterWith();
    store.delete('vp_portal_session');

    const err = await adapter.skipNextDelivery('sub_1').catch((e) => e);
    assert.equal(err.code, 'unauthenticated');
    assert.equal(sent.length, 0, 'nothing may be sent without a session');
  });
});
