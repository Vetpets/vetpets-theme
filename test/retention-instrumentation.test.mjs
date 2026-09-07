/**
 * Live retention instrumentation: screen-view beacons, decline detection,
 * reliable reason capture with journey reuse, and gap-save attribution.
 *
 * THE GATE THIS EXISTS FOR
 * ------------------------
 * cancellation_started/reason_selected/longer_gap_reached/offer_shown/
 * offer_declined/final_confirmation_reached must become the real, live
 * denominators behind the founder dashboard's funnel and Offer Take Rate —
 * so each one has to fire exactly when the spec says, on the SAME journey,
 * and reason capture has to survive a flaky network without ever silently
 * losing what the customer picked.
 *
 * Run with:  node --test test/retention-instrumentation.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '..', 'assets', 'subscription-portal.js'), 'utf8');

/** Pull a prototype method out of the shipped file and make it callable. */
function method(name, extraNames = [], extraValues = []) {
  const re = new RegExp(
    `Portal\\.prototype\\.${name} = function \\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\};`,
  );
  const m = re.exec(src);
  assert.ok(m, `Portal.prototype.${name} must exist`);
  return new Function(...extraNames, `return function (${m[1]}) {${m[2]}\n};`)(...extraValues);
}

/** Read a module-scope constant out of the shipped file: object, array or number. */
function constant(name) {
  const m = new RegExp(
    `var ${name} = (\\{[\\s\\S]*?\\}|\\[[\\s\\S]*?\\]|\\d+);`,
  ).exec(src);
  assert.ok(m, `${name} must exist`);
  return new Function(`return ${m[1]}`)();
}

const DISABLED_SCREENS = {};
const SCREENS_WITH_CHROME = constant('SCREENS_WITH_CHROME');
const RETENTION_SCREEN_EVENTS = constant('RETENTION_SCREEN_EVENTS');
const CONFIRMED_ACTIONS = constant('CONFIRMED_ACTIONS');
const INDETERMINATE = constant('INDETERMINATE');
const AUTH_FAILURE_CODES = constant('AUTH_FAILURE_CODES');

const beaconScreenView = method('beaconScreenView', ['RETENTION_SCREEN_EVENTS'], [RETENTION_SCREEN_EVENTS]);
const show = method('show', ['DISABLED_SCREENS', 'SCREENS_WITH_CHROME'], [DISABLED_SCREENS, SCREENS_WITH_CHROME]);
const attemptKey = method('attemptKey');
const releaseAttempt = method('releaseAttempt');
const run = method('run', ['INDETERMINATE', 'AUTH_FAILURE_CODES'], [INDETERMINATE, AUTH_FAILURE_CODES]);
const act = method('act', ['CONFIRMED_ACTIONS'], [CONFIRMED_ACTIONS]);
// Retries would otherwise really wait 300ms/700ms; the retry LOGIC is what
// is under test, not the clock, so time is collapsed to immediate.
const submitReason = method('submitReason', ['sppWait'], [() => Promise.resolve()]);

/**
 * The shipped click delegation, lifted verbatim from the bundle — a copy
 * would keep passing after the real one broke, which is what this guards.
 */
function delegatedClickHandler() {
  const open = "this.root.addEventListener('click', function (e) {";
  const at = src.indexOf(open);
  assert.ok(at > -1, 'the delegated click handler must exist');
  let i = at + open.length - 1, depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > -1, 'the click handler must be brace-balanced');
  const body = src.slice(at + open.length, end);
  return new Function('self', 'e', body);
}
const onClick = delegatedClickHandler();

function el(tag, attrs = {}) {
  const node = {
    tag,
    attrs: { ...attrs },
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    matches(sel) {
      const m = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(sel);
      assert.ok(m, `unsupported selector in test shim: ${sel}`);
      const [, name, want] = m;
      if (!(name in this.attrs)) return false;
      return want === undefined || this.attrs[name] === want;
    },
    closest(sel) { return this.matches(sel) ? this : null; },
  };
  return node;
}

/* ================================================================== *
 * Screen-view beacons
 * ================================================================== */

describe('screen-view beacons name the right event and share one journey', () => {
  function portal({ retentionOfferRedeemed = false, recordRetentionEvent } = {}) {
    const events = [];
    const screens = {};
    for (const name of ['cancel-reason', 'cancel-alt', 'cancel-offer', 'cancel-confirm', 'dashboard']) {
      screens[name] = { hidden: true, getAttribute: () => name, setAttribute() {}, focus() {} };
    }
    const root = {
      querySelectorAll(sel) { return sel === '[data-spp-screen]' ? Object.values(screens) : []; },
      querySelector() { return null; },
    };
    const p = {
      state: { screen: 'dashboard', history: [], retentionJourneyId: null, data: { retentionOfferRedeemed } },
      root,
      events,
      closeSheet() {},
      render() {},
      markCurrentNav() {},
      adapter: {
        recordRetentionEvent: recordRetentionEvent || function (eventType, journeyId) {
          events.push({ eventType, journeyId });
          return Promise.resolve({ journeyId: journeyId || 'j-minted' });
        },
      },
      beaconScreenView(v) { return beaconScreenView.call(this, v); },
      show(v) { return show.call(this, v); },
    };
    return p;
  }

  test('entering the reason screen fires cancellation_started and adopts the minted journey id', async () => {
    const p = portal();
    p.show('cancel-reason');
    await Promise.resolve().then(() => {});
    assert.deepEqual(p.events, [{ eventType: 'cancellation_started', journeyId: null }]);
    assert.equal(p.state.retentionJourneyId, 'j-minted');
  });

  test('the longer-gap screen fires longer_gap_reached on the SAME already-adopted journey', async () => {
    const p = portal();
    p.state.retentionJourneyId = 'j-existing';
    p.show('cancel-alt');
    await Promise.resolve().then(() => {});
    assert.deepEqual(p.events, [{ eventType: 'longer_gap_reached', journeyId: 'j-existing' }]);
    assert.equal(p.state.retentionJourneyId, 'j-existing', 'a beacon must never displace an id already held');
  });

  test('an eligible customer viewing the offer fires offer_shown', async () => {
    const p = portal({ retentionOfferRedeemed: false });
    p.show('cancel-offer');
    await Promise.resolve().then(() => {});
    assert.deepEqual(p.events.map((e) => e.eventType), ['offer_shown']);
    assert.equal(p.state.screen, 'cancel-offer');
  });

  test('a REDEEMED customer never triggers offer_shown — they land on confirm, which beacons that instead', async () => {
    const p = portal({ retentionOfferRedeemed: true });
    p.show('cancel-offer');
    await Promise.resolve().then(() => {});
    assert.deepEqual(p.events.map((e) => e.eventType), ['final_confirmation_reached']);
    assert.equal(p.state.screen, 'cancel-confirm');
  });

  test('final_confirmation_reached fires on reaching the confirm screen directly', async () => {
    const p = portal();
    p.show('cancel-confirm');
    await Promise.resolve().then(() => {});
    assert.deepEqual(p.events.map((e) => e.eventType), ['final_confirmation_reached']);
  });

  test('a screen with no mapped retention event beacons nothing', async () => {
    const p = portal();
    p.show('dashboard');
    await Promise.resolve().then(() => {});
    assert.deepEqual(p.events, []);
  });

  test('an older/mock adapter with no recordRetentionEvent never throws', () => {
    const p = portal();
    p.adapter = {};
    assert.doesNotThrow(() => p.show('cancel-reason'));
  });

  test('a rejected beacon promise is swallowed — telemetry never surfaces as a customer-visible failure', async () => {
    const p = portal({ recordRetentionEvent: () => Promise.reject(new Error('network')) });
    assert.doesNotThrow(() => p.show('cancel-reason'));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(p.state.retentionJourneyId, null, 'no id to adopt from a failed beacon');
  });
});

/* ================================================================== *
 * offer_declined — leaving the offer screen without accepting it
 * ================================================================== */

describe('offer_declined fires exactly when the customer walks away from the offer', () => {
  function portal({ screen = 'cancel-offer', retentionJourneyId = 'j-1' } = {}) {
    const events = [];
    return {
      events,
      state: { screen, retentionJourneyId, data: {} },
      adapter: {
        recordRetentionEvent: (eventType, journeyId) => {
          events.push({ eventType, journeyId });
          return Promise.resolve(null);
        },
      },
      show(v) { this.state.screen = v; },
    };
  }

  test('continuing from cancel-offer to cancel-confirm emits offer_declined once, on the held journey', () => {
    const p = portal();
    const link = el('a', { 'data-spp-go': 'cancel-confirm' });
    onClick(p, { target: link, preventDefault() {} });
    assert.deepEqual(p.events, [{ eventType: 'offer_declined', journeyId: 'j-1' }]);
    assert.equal(p.state.screen, 'cancel-confirm');
  });

  test('leaving cancel-offer for any OTHER destination is not a decline', () => {
    const p = portal();
    onClick(p, { target: el('a', { 'data-spp-go': 'dashboard' }), preventDefault() {} });
    assert.deepEqual(p.events, []);
  });

  test('reaching cancel-confirm from a screen other than cancel-offer is not a decline', () => {
    const p = portal({ screen: 'cancel-alt' });
    onClick(p, { target: el('a', { 'data-spp-go': 'cancel-confirm' }), preventDefault() {} });
    assert.deepEqual(p.events, []);
  });

  test('an adapter with no recordRetentionEvent never throws on decline', () => {
    const p = portal();
    p.adapter = {};
    const link = el('a', { 'data-spp-go': 'cancel-confirm' });
    assert.doesNotThrow(() => onClick(p, { target: link, preventDefault() {} }));
  });
});

/* ================================================================== *
 * Reliable reason capture — retry, no duplicates, journey reuse
 * ================================================================== */

describe('submitReason: retry-safe delivery that reuses the beacon-opened journey', () => {
  function portal({ recordCancelReason } = {}) {
    const calls = [];
    const p = {
      calls,
      state: {
        pending: null, attempts: {}, retentionJourneyId: null,
        reasonSaveError: null, draft: { reason: 'too_expensive', note: '' },
      },
      adapter: { recordCancelReason },
      attemptKey(op) { return attemptKey.call(this, op); },
      releaseAttempt(op) { return releaseAttempt.call(this, op); },
      applyPending() {},
      render() {},
      shown: [],
      show(v) { this.shown.push(v); },
      submitReason(code, note) { return submitReason.call(this, code, note); },
    };
    return p;
  }

  test('a clean first attempt sends the held journey id and one key, then advances', async () => {
    const p = portal({
      recordCancelReason: (code, note, opts) => {
        p.calls.push(opts);
        return Promise.resolve({ journeyId: 'j-reason' });
      },
    });
    p.state.retentionJourneyId = 'j-open';
    p.submitReason('too_expensive', '');
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].journeyId, 'j-open');
    assert.equal(p.state.retentionJourneyId, 'j-reason', 'the reason write wins the tie over an earlier beacon');
    assert.deepEqual(p.shown, ['cancel-alt']);
    assert.equal(p.state.reasonSaveError, null);
  });

  test('a retry after success replays the SAME idempotency key on the second attempt', async () => {
    const p = portal({
      recordCancelReason: (code, note, opts) => {
        p.calls.push(opts.idempotencyKey);
        return p.calls.length === 1
          ? Promise.reject(Object.assign(new Error('net'), { code: 'network' }))
          : Promise.resolve({ journeyId: 'j-1' });
      },
    });
    p.submitReason('too_expensive', '');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(p.calls.length, 2);
    assert.equal(p.calls[0], p.calls[1], 'a network failure must not mint a fresh key — the server may already have applied it');
    assert.deepEqual(p.shown, ['cancel-alt']);
  });

  test('a DEFINITIVE server rejection mints a fresh key for the next attempt', async () => {
    const p = portal({
      recordCancelReason: (code, note, opts) => {
        p.calls.push(opts.idempotencyKey);
        return p.calls.length === 1
          ? Promise.reject(Object.assign(new Error('busy'), { code: 'in_progress' }))
          : Promise.resolve({ journeyId: 'j-1' });
      },
    });
    p.submitReason('too_expensive', '');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(p.calls.length, 2);
    assert.notEqual(p.calls[0], p.calls[1], 'a spent key can never succeed on retry — the server permanently blocks reuse');
  });

  test('invalid_journey drops the held journey id so the retry never resends a foreign one', async () => {
    const seenJourneyIds = [];
    const p = portal({
      recordCancelReason: (code, note, opts) => {
        seenJourneyIds.push(opts.journeyId);
        return seenJourneyIds.length === 1
          ? Promise.reject(Object.assign(new Error('bad journey'), { code: 'invalid_journey' }))
          : Promise.resolve({ journeyId: 'j-fresh' });
      },
    });
    p.state.retentionJourneyId = 'j-foreign';
    p.submitReason('too_expensive', '');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    assert.deepEqual(seenJourneyIds, ['j-foreign', null]);
  });

  test('exhausting every retry never advances the screen and preserves the selection', async () => {
    const p = portal({
      recordCancelReason: () => Promise.reject(Object.assign(new Error('down'), { code: 'network' })),
    });
    p.submitReason('too_expensive', '');
    // Two retries beyond the first attempt: three ticks to exhaust them all.
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));

    assert.deepEqual(p.shown, [], 'a failed save must never pretend to have advanced the flow');
    assert.equal(p.state.draft.reason, 'too_expensive', 'the selection survives a save failure');
    assert.ok(p.state.reasonSaveError, 'a recoverable error must be shown, never a silent loss');
    assert.equal(p.state.pending, null, 'the customer must be able to try again');
  });

  test('a second call while a submission is already in flight is a no-op', async () => {
    let calls = 0;
    const p = portal({
      recordCancelReason: () => { calls++; return new Promise(() => {}); }, // never resolves
    });
    p.submitReason('too_expensive', '');
    p.submitReason('too_expensive', '');
    await Promise.resolve();
    assert.equal(calls, 1);
  });
});

/* ================================================================== *
 * Gap-save attribution — the explicit journey context, and only there
 * ================================================================== */

describe('applyGap sends the held retention journey id to the mutation, and only when one exists', () => {
  function portal({ retentionJourneyId } = {}) {
    const calls = [];
    const confirmBtn = { disabled: false, setAttribute() {}, removeAttribute() {} };
    return {
      calls,
      confirmBtn,
      cfg: { mode: 'live' },
      state: {
        pending: null, attempts: {}, draft: { gap: 'skip' }, confirmSpent: false,
        retentionJourneyId: retentionJourneyId ?? null,
        data: { id: 'sub_1', nextOrderDate: '2026-09-24' },
      },
      root: { querySelectorAll: () => [confirmBtn], querySelector: () => null },
      adapter: {
        skipNextDelivery(id, opts) { calls.push({ id, opts }); return Promise.resolve({ id: 'sub_1' }); },
        recordCancelOutcome: () => Promise.resolve(null),
      },
      attemptKey(op) { return attemptKey.call(this, op); },
      releaseAttempt(op) { return releaseAttempt.call(this, op); },
      releaseAllAttempts() { this.state.attempts = {}; },
      run(key, work, o) { return run.call(this, key, work, o); },
      act(name, e) { return act.call(this, name, e); },
      applyPending() {},
      render() {},
      closeSheet() {},
      show() {},
      toast() {},
      fail() {},
      actionFailed() {},
      refreshRequired() {},
      refreshAuthenticatedData: () => Promise.resolve(),
      fmtDate: () => '24 September 2026',
      hasSession: () => true,
    };
  }

  test('a gap-save reached FROM the cancellation journey carries that exact journey id', async () => {
    const p = portal({ retentionJourneyId: 'j-cancel-attempt' });
    p.act('applyGap');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].opts.retentionJourneyId, 'j-cancel-attempt');
  });

  test('an ordinary dashboard skip with no cancellation journey open sends none', async () => {
    const p = portal(); // retentionJourneyId stays null — not reached via the cancel flow
    p.act('applyGap');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].opts.retentionJourneyId, null, 'must not be misclassified as a retention save');
  });
});
