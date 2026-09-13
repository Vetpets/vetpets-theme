/**
 * The live adapter's read cache, and the offer that used to outlive it.
 *
 * THE BUG THIS EXISTS FOR
 * ------------------------
 * The dashboard kept showing the pre-offer price after a successful 40%
 * redemption, even once the controller was fixed to call load() afterwards.
 * The adapter's readPortal() memoizes one /portal/subscription read and
 * shares it across getCustomer/getSubscription/listSubscriptions/
 * listDeliveries ("six adapter calls, one request"). mutate() (skip/delay/
 * cancel/reschedule) replaces that cache with its own fresh view on every
 * success, which is why those dashboards update correctly.
 * acceptRetentionOffer never did — its only cache invalidation was on a 401 —
 * so even a freshly-added load() call kept replaying the view from BEFORE the
 * click. This drives the REAL adapter (via vm, not a stand-in) to prove the
 * cache is actually invalidated, not merely that load() was called.
 *
 * Run with:  node --test test/retention-offer-cache.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '..', 'assets', 'subscription-portal-adapter.js'), 'utf8');

function view(amount, redeemed) {
  return {
    state: 'subscription',
    customer: { firstName: 'Test' },
    subscription: {
      status: 'active',
      subscriptionId: '5600001',
      nextBillingDate: '2026-07-10',
      upcomingCharge: { state: 'available', amount, currencyCode: 'USD' },
      cadence: { state: 'available', intervalDays: 30 },
      lines: [{ title: 'ExampleWipes Kit', productId: '1', variantId: '2', quantity: 2 }],
      deliveryAddress: null,
      payment: null,
      initialPayment: { state: 'unavailable', reason: 'x' },
      recentPayments: [],
      retentionOfferRedeemed: !!redeemed,
    },
  };
}

/** A real live adapter, executed via vm, over a network double we fully control. */
function adapterWith() {
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

  const calls = { subscription: 0, offer: 0 };
  const adapter = win.VetPetsPortal.createHttpAdapter({
    fetchImpl: (url) => {
      if (url.includes('/portal/subscription')) {
        calls.subscription++;
        // Before the offer: unredeemed at the pre-offer price. From the
        // second read on: redeemed, at the offer price — exactly what the
        // SERVER would report once the write lands.
        const body = calls.subscription === 1 ? view(0.70, false) : view(0.42, true);
        return Promise.resolve({
          status: 200, ok: true, text: () => Promise.resolve(JSON.stringify(body)),
        });
      }
      if (url.includes('/portal/retention-offer')) {
        calls.offer++;
        return Promise.resolve({
          status: 200, ok: true,
          text: () => Promise.resolve(JSON.stringify({
            status: 'ok', operation: 'offer', percentOff: 40,
            previousPrice: 0.70, normalValue: 0.70, offerPrice: 0.42,
            verified: true, refreshRequired: false,
          })),
        });
      }
      return Promise.reject(new Error('unexpected url ' + url));
    },
  });
  return { adapter, calls };
}

describe('the live adapter re-reads the subscription after a successful offer', () => {
  test('a read before the offer is cached, exactly as load() relies on', async () => {
    const { adapter, calls } = adapterWith();
    await adapter.getSubscription();
    await adapter.getSubscription();
    assert.equal(calls.subscription, 1, 'six adapter calls, one request — the whole point of the cache');
  });

  test('acceptRetentionOffer invalidates the cache, so the next read hits the network', async () => {
    const { adapter, calls } = adapterWith();

    const before = await adapter.getSubscription();
    assert.equal(before.pricing.total.amount, 0.70);
    assert.equal(before.retentionOfferRedeemed, false);

    await adapter.acceptRetentionOffer({ idempotencyKey: 'cache-proof-key-001' });
    assert.equal(calls.offer, 1);

    const after = await adapter.getSubscription();
    assert.equal(calls.subscription, 2, 'the stale cache must not be reused after a successful offer');
    assert.equal(after.pricing.total.amount, 0.42);
    assert.equal(after.retentionOfferRedeemed, true);
  });

  test('the source actually nulls the cache on success, not only on 401', () => {
    const start = source.indexOf('acceptRetentionOffer: function (opts) {');
    const end = source.indexOf('skipNextDelivery: function (id, opts) {', start);
    const block = source.slice(start, end);
    const pendingNulls = block.match(/pending = null;/g) || [];
    // One for the 401 branch, one for the success path below every refusal.
    assert.equal(pendingNulls.length, 2, block);
  });
});
