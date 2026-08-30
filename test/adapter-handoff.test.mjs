/**
 * Live adapter — handoff and session handling.
 *
 * Run with Node's built-in runner, no dependencies and no package.json:
 *
 *   node --test test/adapter-handoff.test.mjs
 *
 * The theme has no test framework and must not gain one: `node_modules` in a
 * theme repository is a deployment hazard. `node:test` needs neither.
 *
 * What matters here is security-shaped, not cosmetic:
 *   - the handoff code leaves the address bar before anything can read it;
 *   - the session lands in sessionStorage and NOWHERE else;
 *   - no email, CustomerId or token is ever stored or sent by the browser.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '..', 'assets', 'subscription-portal-adapter.js'), 'utf8');

/** Minimal browser surface the adapter touches. */
function makeWindow(search = '') {
  const store = new Map();
  const replaced = [];

  return {
    location: { search, pathname: '/pages/subscription-policy', hash: '' },
    history: {
      state: null,
      replaceState(state, title, url) {
        replaced.push(url);
        const q = url.indexOf('?');
        this.__window.location.search = q === -1 ? '' : url.slice(q);
        this.__window.location.pathname = q === -1 ? url : url.slice(0, q);
      },
    },
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
    // Deliberately absent: localStorage. If the adapter ever reaches for it,
    // these tests throw rather than quietly persisting a credential to disk.
    URLSearchParams,
    fetch: () => Promise.reject(new Error('no network in tests')),
    __replaced: replaced,
    __store: store,
  };
}

function loadAdapter(win) {
  win.history.__window = win;
  const context = vm.createContext({ window: win, URLSearchParams, JSON, Promise, Math, Date, console });
  vm.runInContext(source, context);
  return win.VetPetsPortal;
}

describe('takeHandoffFromUrl', () => {
  let win;
  let NS;

  beforeEach(() => {
    win = makeWindow('?spp_dev=1&view=subscription-portal&vp_handoff=CODE-123');
    NS = loadAdapter(win);
  });

  test('returns the code and strips it from the address bar', () => {
    const code = NS.takeHandoffFromUrl();

    assert.equal(code, 'CODE-123');
    assert.equal(win.__replaced.length, 1);
    assert.ok(!win.__replaced[0].includes('vp_handoff'));
    assert.ok(!win.__replaced[0].includes('CODE-123'));
  });

  test('keeps the other parameters, so the dev route survives the strip', () => {
    NS.takeHandoffFromUrl();

    const rewritten = win.__replaced[0];
    assert.ok(rewritten.includes('spp_dev=1'));
    assert.ok(rewritten.includes('view=subscription-portal'));
    assert.ok(rewritten.startsWith('/pages/subscription-policy'));
  });

  test('a second read finds nothing — the code is gone, not merely hidden', () => {
    assert.equal(NS.takeHandoffFromUrl(), 'CODE-123');
    assert.equal(NS.takeHandoffFromUrl(), null);
  });

  test('returns null when there is no handoff, and rewrites nothing', () => {
    const clean = makeWindow('?spp_dev=1');
    const ns = loadAdapter(clean);

    assert.equal(ns.takeHandoffFromUrl(), null);
    assert.equal(clean.__replaced.length, 0);
  });
});

describe('preview theme id', () => {
  test('is read from the URL and sent with a link request', async () => {
    const win = makeWindow('?preview_theme_id=181692858635');
    const NS = loadAdapter(win);
    const sent = [];
    const adapter = NS.createHttpAdapter({
      fetchImpl: (url, init) => {
        sent.push({ url, init });
        return Promise.resolve({ status: 202, ok: true, text: () => Promise.resolve('{}') });
      },
    });

    await adapter.requestMagicLink('person@example.com');

    assert.equal(JSON.parse(sent[0].init.body).preview_theme_id, '181692858635');
  });

  test('is omitted entirely on the canonical storefront', async () => {
    const win = makeWindow('');
    const NS = loadAdapter(win);
    const sent = [];
    const adapter = NS.createHttpAdapter({
      fetchImpl: (url, init) => {
        sent.push({ url, init });
        return Promise.resolve({ status: 202, ok: true, text: () => Promise.resolve('{}') });
      },
    });

    await adapter.requestMagicLink('person@example.com');

    const body = JSON.parse(sent[0].init.body);
    assert.equal('preview_theme_id' in body, false);
  });

  test('refuses a non-numeric value rather than forwarding it', () => {
    const win = makeWindow('?preview_theme_id=https://evil.example');
    const NS = loadAdapter(win);
    assert.equal(NS.previewThemeId(), null);
  });
});

describe('live adapter — session handling', () => {
  function adapterWith(responses) {
    const win = makeWindow('');
    const NS = loadAdapter(win);
    const sent = [];

    const adapter = NS.createHttpAdapter({
      basePath: '/apps/subscriptions',
      fetchImpl: (url, init) => {
        sent.push({ url, init });
        const next = responses.shift() ?? { status: 500, body: '{}' };
        return Promise.resolve({
          status: next.status,
          ok: next.status >= 200 && next.status < 300,
          text: () => Promise.resolve(next.body),
        });
      },
    });

    return { adapter, sent, win };
  }

  test('stores the session in sessionStorage only, never in a URL', async () => {
    const { adapter, win } = adapterWith([
      { status: 200, body: JSON.stringify({ status: 'ok', session: 'SESSION-TOKEN' }) },
    ]);

    await adapter.exchangeHandoff('CODE-123');

    assert.equal(win.__store.get('vp_portal_session'), 'SESSION-TOKEN');
    assert.ok(!win.location.search.includes('SESSION-TOKEN'));
    assert.equal(win.__replaced.length, 0);
  });

  test('sends the session in the body, never in the query string', async () => {
    const { adapter, sent } = adapterWith([
      { status: 200, body: JSON.stringify({ status: 'ok', session: 'SESSION-TOKEN' }) },
      { status: 200, body: JSON.stringify({ state: 'no-subscription' }) },
    ]);

    await adapter.exchangeHandoff('CODE-123');
    await adapter.getCustomer();

    const read = sent[1];
    assert.ok(!read.url.includes('SESSION-TOKEN'));
    assert.ok(!read.url.includes('?'));
    assert.equal(JSON.parse(read.init.body).session, 'SESSION-TOKEN');
  });

  test('never sends an email or a customer id', async () => {
    const { adapter, sent } = adapterWith([
      { status: 200, body: JSON.stringify({ status: 'ok', session: 'S' }) },
      { status: 200, body: JSON.stringify({ state: 'no-subscription' }) },
    ]);

    await adapter.exchangeHandoff('CODE-123');
    await adapter.getCustomer();

    const body = JSON.parse(sent[1].init.body);
    assert.equal(Object.keys(body).join(','), 'session');
  });

  test('a rejected exchange stores nothing and reports one failure', async () => {
    const { adapter, win } = adapterWith([{ status: 400, body: JSON.stringify({ error: 'invalid_handoff' }) }]);

    await assert.rejects(
      () => adapter.exchangeHandoff('REPLAYED'),
      (err) => err.code === 'expired_link',
    );
    assert.equal(win.__store.has('vp_portal_session'), false);
  });

  test('a 401 clears the stored session so the page returns to sign-in', async () => {
    const { adapter, win } = adapterWith([
      { status: 200, body: JSON.stringify({ status: 'ok', session: 'S' }) },
      { status: 401, body: JSON.stringify({ error: 'unauthenticated' }) },
    ]);

    await adapter.exchangeHandoff('CODE');
    assert.equal(adapter.hasSession(), true);

    await assert.rejects(() => adapter.getCustomer(), (err) => err.code === 'unauthenticated');
    assert.equal(adapter.hasSession(), false);
  });

  test('sign-out clears storage and stays successful even if the call fails', async () => {
    const { adapter, win } = adapterWith([
      { status: 200, body: JSON.stringify({ status: 'ok', session: 'S' }) },
      { status: 500, body: '{}' },
    ]);

    await adapter.exchangeHandoff('CODE');
    const result = await adapter.signOut();

    assert.equal(result.ok, true);
    assert.equal(win.__store.has('vp_portal_session'), false);
  });

  test('six reads make one backend request', async () => {
    const { adapter, sent } = adapterWith([
      { status: 200, body: JSON.stringify({ status: 'ok', session: 'S' }) },
      { status: 200, body: JSON.stringify({ state: 'no-subscription' }) },
    ]);

    await adapter.exchangeHandoff('CODE');
    await Promise.all([
      adapter.getCustomer(),
      adapter.listSubscriptions(),
      adapter.listDeliveries(),
      adapter.getLoyalty(),
      adapter.listRewards(),
    ]);

    // One exchange plus one portal read. Not five reads.
    assert.equal(sent.length, 2);
  });

  test('returns every field the controller dereferences on a subscription', async () => {
    // The controller reads sub.address.city, sub.payment.brand and
    // sub.pricing.total directly. Live Phoenix data can lack an address or a
    // card, so this pins the CONTRACT: the keys are always present, and their
    // values are either an object or null — never undefined, which would make
    // a guard in the controller look unnecessary until it threw.
    const { adapter } = adapterWith([
      { status: 200, body: JSON.stringify({ status: 'ok', session: 'S' }) },
      {
        status: 200,
        body: JSON.stringify({
          state: 'subscription',
          subscription: {
            status: 'active',
            subscriptionId: 'SUB-1',
            nextBillingDate: '2026-09-08',
            upcomingCharge: { state: 'unavailable', reason: 'no-queued-order' },
            cadence: { state: 'unavailable', reason: 'unknown' },
            lines: [{ title: 'FreshWipes', productId: 'p1', variantId: 'v1', quantity: 2 }],
            deliveryAddress: null,
            payment: null,
            recentPayments: [],
          },
        }),
      },
    ]);

    await adapter.exchangeHandoff('CODE');
    const sub = await adapter.getSubscription();

    for (const key of ['address', 'payment', 'pricing', 'lines', 'status', 'nextOrderDate']) {
      assert.ok(key in sub, `missing key: ${key}`);
      assert.notEqual(sub[key], undefined, `undefined value: ${key}`);
    }
    assert.equal(sub.address, null);
    assert.equal(sub.payment, null);
    assert.equal(sub.pricing.total, null);
    assert.equal(sub.lines.length, 1);
  });

  test('invents no loyalty balance when there is no ledger behind it', async () => {
    const { adapter } = adapterWith([
      { status: 200, body: JSON.stringify({ status: 'ok', session: 'S' }) },
    ]);

    await adapter.exchangeHandoff('CODE');
    assert.equal(await adapter.getLoyalty(), null);
    // Length, not deepEqual: the array is built inside the vm realm, so its
    // prototype differs from this realm's Array.
    assert.equal((await adapter.listRewards()).length, 0);
  });
});
