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
const sectionSource = readFileSync(
  resolve(here, '..', 'sections', 'subscription-portal.liquid'),
  'utf8'
);

/** Real captures from the storefront. See test/fixtures/README.md. */
const renderedRoot = readFileSync(resolve(here, 'fixtures', 'preview-root.html'), 'utf8');
const redirect = JSON.parse(readFileSync(resolve(here, 'fixtures', 'preview-redirect.json'), 'utf8'));

/** Pull one attribute out of the captured root element. */
function renderedAttr(name) {
  const match = renderedRoot.match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : null;
}

/**
 * A stand-in for the rendered portal root.
 *
 * `attributes` is whatever the storefront put on the element. Passing `null`
 * models a page with no portal on it at all.
 */
function makeDocument(attributes) {
  const element = attributes === null
    ? null
    : { getAttribute: (name) => (name in attributes ? attributes[name] : null) };

  return {
    querySelector: (selector) => (selector === '[data-spp-portal]' ? element : null),
  };
}

/** Minimal browser surface the adapter touches. */
function makeWindow(search = '', doc = makeDocument(null)) {
  const store = new Map();
  const replaced = [];

  return {
    document: doc,
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

/**
 * Preview-aware link requests.
 *
 * The defect these tests exist for: the adapter used to read `preview_theme_id`
 * from `location.search`. Shopify consumes that parameter into an HttpOnly
 * cookie and redirects to a clean URL, so by the time anyone submits the
 * sign-in form it is gone — every "preview" link came back to the live theme,
 * which carries no portal template at all.
 *
 * The identity now comes from Liquid, rendered into the page server-side where
 * the preview cookie IS honoured. Fixtures 1 and 2 are live captures, so these
 * assertions are statements about production, not about a mock.
 */
describe('preview theme id', () => {
  const DEV_THEME = '181692858635';

  /**
   * A portal booted on the post-redirect URL — no preview_theme_id anywhere in
   * the address bar — with `themeId` as the value the storefront rendered into
   * `data-spp-theme-id`. The adapter has to find it in the DOM or not at all.
   */
  function adapterOn(themeId) {
    const doc = makeDocument(
      themeId === undefined ? null : { 'data-spp-theme-id': themeId }
    );
    const win = makeWindow(redirect.finalUrl.slice(redirect.finalUrl.indexOf('?')), doc);
    const NS = loadAdapter(win);
    const sent = [];
    const adapter = NS.createHttpAdapter({
      fetchImpl: (url, init) => {
        sent.push({ url, init });
        return Promise.resolve({ status: 202, ok: true, text: () => Promise.resolve('{}') });
      },
    });
    return { NS, adapter, sent, win };
  }

  // 1 — the query parameter is already gone.
  test('the preview parameter does not survive Shopify’s redirect', () => {
    assert.equal(redirect.status, 302);
    assert.ok(redirect.requestedUrl.includes('preview_theme_id=181692858635'));
    assert.ok(!redirect.location.includes('preview_theme_id'));
    assert.ok(!redirect.finalUrl.includes('preview_theme_id'));

    // And the cookie it was traded for is unreadable from script, so there is
    // no recovering it client-side.
    assert.equal(redirect.setCookieHttpOnly, true);
  });

  // 2 — the rendered dev portal still knows which theme it is.
  test('the rendered dev portal exposes the theme id after the redirect', () => {
    assert.equal(renderedAttr('data-spp-theme-id'), DEV_THEME);
    assert.equal(renderedAttr('data-spp-mode'), 'live');

    // The attribute is emitted from Liquid's own theme identity, not echoed
    // back from anything the browser sent.
    assert.ok(sectionSource.includes('assign theme_id = theme.id'));
    assert.ok(sectionSource.includes('data-spp-theme-id="{{ theme_id }}"'));

    // ...and the adapter reads that exact attribute off that exact element.
    const doc = makeDocument({ 'data-spp-theme-id': renderedAttr('data-spp-theme-id') });
    const NS = loadAdapter(makeWindow('', doc));
    assert.equal(NS.renderedThemeId(), DEV_THEME);
  });

  // 3 — the request carries it.
  test('the link request sends preview_theme_id taken from the rendered page', async () => {
    const { adapter, sent, win } = adapterOn(renderedAttr('data-spp-theme-id'));

    await adapter.requestMagicLink('person@example.com');

    // Precondition: nothing usable in the address bar at this moment.
    assert.ok(!win.location.search.includes('preview_theme_id'));

    const body = JSON.parse(sent[0].init.body);
    assert.equal(body.preview_theme_id, DEV_THEME);
    // Nothing else about the browser's context is volunteered.
    assert.deepEqual(Object.keys(body).sort(), ['email', 'preview_theme_id']);
  });

  // 4 — anything else is omitted.
  test('another or missing theme id is omitted, so production stays canonical', async () => {
    for (const themeId of [
      undefined, // no portal root at all
      null, // root present, attribute absent
      '',
      '181640724747', // the live theme
      '1816928586350', // a near miss
      '18169285863', // a prefix
      'https://evil.example',
      '181692858635 ; DROP',
    ]) {
      const { adapter, sent } = adapterOn(themeId);
      await adapter.requestMagicLink('person@example.com');

      const body = JSON.parse(sent[0].init.body);
      assert.equal(
        'preview_theme_id' in body,
        false,
        `theme id ${JSON.stringify(themeId)} must not produce a preview return`
      );
    }
  });

  test('previewThemeId gates on exact equality, not a pattern', () => {
    const { NS } = adapterOn(undefined);

    assert.equal(NS.previewThemeId(DEV_THEME), DEV_THEME);
    assert.equal(NS.previewThemeId(181692858635), DEV_THEME); // numeric attribute
    assert.equal(NS.previewThemeId(' 181692858635 '), DEV_THEME); // stray whitespace
    assert.equal(NS.previewThemeId('999999999999'), null);
    assert.equal(NS.previewThemeId('../181692858635'), null);
    assert.equal(NS.previewThemeId(null), null);
  });

  // 5 — the browser never decides where the link points.
  test('the adapter sends an id, never a destination', async () => {
    const { adapter, sent } = adapterOn(DEV_THEME);

    await adapter.requestMagicLink('person@example.com');

    const body = JSON.parse(sent[0].init.body);
    // No URL, path, origin or redirect field exists to smuggle a destination
    // through. The server builds the return URL from its own fixed constants.
    for (const key of Object.keys(body)) {
      assert.ok(
        !/url|redirect|return|next|origin|host|path/i.test(key),
        `unexpected destination-shaped field: ${key}`
      );
    }
    assert.ok(!/https?:/i.test(sent[0].init.body));
    // Same-origin, first-party path.
    assert.ok(sent[0].url.startsWith('/apps/subscriptions'));
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
