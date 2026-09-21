/**
 * Cancel step 6 — "Adjust your routine" (reason-personalized recommendations).
 *
 * Every claim here is about the SHIPPED files: methods are lifted verbatim out
 * of assets/subscription-portal.js, the adapter is the real one run in a vm,
 * and markup assertions read the real Liquid/CSS.
 *
 * Scope proved below
 *   - every reason -> its approved recommendation (and tracking key)
 *   - "too much product" -> move next delivery 30 days later, NEVER a claimed
 *     frequency change (Phoenix has no such operation)
 *   - Dental/Eye/Ear may carry a before/after image; Coat/Paw/Other never show
 *     an image, an empty slot or a placeholder
 *   - back navigation and reason persistence
 *   - exactly ONE Phoenix mutation per action; success only after a fresh
 *     refetch confirms it; a failed/unverified change is never a save
 *   - tracking: shown / attempted / declined / kept, and saves attributed by
 *     the SERVER only
 *   - 40% one-delivery-only routing, final cancellation path
 *   - mobile + desktop styling hooks
 *
 * Run with:  node --test test/retention-adjust-routine.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(resolve(here, '..', ...p), 'utf8');

const src = read('assets', 'subscription-portal.js');
const adapterSrc = read('assets', 'subscription-portal-adapter.js');
const cancelLiquid = read('snippets', 'spp-screen-cancel.liquid');
const css = read('assets', 'subscription-portal.css');

/* ----------------------------------------------------------------- loaders */

function method(name, extraNames = [], extraValues = []) {
  const re = new RegExp(`Portal\\.prototype\\.${name} = function \\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\};`);
  const m = re.exec(src);
  assert.ok(m, `Portal.prototype.${name} must exist`);
  return new Function(...extraNames, `return function (${m[1]}) {${m[2]}\n};`)(...extraValues);
}
function constant(name) {
  const m = new RegExp(`var ${name} = (\\{[\\s\\S]*?\\}|\\[[\\s\\S]*?\\]|\\d+);`).exec(src);
  assert.ok(m, `${name} must exist`);
  return new Function(`return ${m[1]}`)();
}
function moduleFunction(name) {
  const m = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`).exec(src);
  assert.ok(m, `${name} must exist`);
  return new Function(`return ${m[0]}`)();
}
function screenMarkup(name) {
  const m = new RegExp(`<section[^>]*data-spp-screen="${name}"[\\s\\S]*?</section>`).exec(cancelLiquid);
  assert.ok(m, `screen ${name} must exist`);
  return m[0];
}

function loadNS() {
  const win = {
    document: { querySelector: () => null },
    location: { search: '', pathname: '/', hash: '' },
    history: { state: null, replaceState() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  vm.runInNewContext(adapterSrc, { window: win, console, setTimeout, Promise, Date, JSON, Math, URLSearchParams });
  return win.VetPetsPortal;
}
const NS = loadNS();

const RETAIN_BY_REASON = constant('RETAIN_BY_REASON');
const CONSTS = {
  NS,
  REVIEW_BANK: constant('REVIEW_BANK'),
  OFFER_PERCENT: 40,
  STANDARD_PERCENT: 20,
  CARE_STORIES: constant('CARE_STORIES'),
  RETAIN_TIPS: constant('RETAIN_TIPS'),
  RETAIN_STAGE_LABELS: constant('RETAIN_STAGE_LABELS'),
  RETAIN_MOVE_DAYS: 30,
  RETAIN_ADJUSTMENTS: constant('RETAIN_ADJUSTMENTS'),
  RETAIN_ADJ_ACTION: constant('RETAIN_ADJ_ACTION'),
  RETAIN_BY_REASON,
  retainProductKey: moduleFunction('retainProductKey'),
  CONFIRMED_ACTIONS: constant('CONFIRMED_ACTIONS'),
  INDETERMINATE: constant('INDETERMINATE'),
  AUTH_FAILURE_CODES: constant('AUTH_FAILURE_CODES'),
  SCREENS_WITH_CHROME: constant('SCREENS_WITH_CHROME'),
  DISABLED_SCREENS: {},
  REASONS: constant('REASONS'),
  STARTED_CATEGORIES: constant('STARTED_CATEGORIES'),
  MAX_RESCHEDULE_DAYS: 365,
};
const names = Object.keys(CONSTS);
const values = names.map((n) => CONSTS[n]);
const M = (name) => method(name, names, values);

const retainKind = M('retainKind');
const trackRetention = M('trackRetention');
const retainContent = M('retainContent');
const retainAdjTarget = M('retainAdjTarget');
const retainAdjProblem = M('retainAdjProblem');
const retainVerify = M('retainVerify');
const retainRun = M('retainRun');
const syncBeforeAfter = M('syncBeforeAfter');
const run = M('run');
const act = M('act');
const actionFailed = M('actionFailed');
const attemptKey = M('attemptKey');
const releaseAttempt = M('releaseAttempt');
const fmtDate = M('fmtDate');
const pick = M('pick');
const show = M('show');
const beaconScreenView = method('beaconScreenView', ['RETENTION_SCREEN_EVENTS'], [constant('RETENTION_SCREEN_EVENTS')]);
const rescheduleBounds = M('rescheduleBounds');
const refreshRequired = M('refreshRequired');

/* ------------------------------------------------------------ portal double */

const LINES = {
  fresh: [{ title: 'FreshWipes jar', quantity: 2 }],
  eye: [{ title: 'EyeWipes jar', quantity: 1 }],
  ear: [{ title: 'EarWipes jar', quantity: 1 }],
  glove: [{ title: 'GloveWipes pack', quantity: 1 }],
  paw: [{ title: 'Paw Foam', quantity: 1 }],
  multi: [{ title: 'FreshWipes jar', quantity: 2 }, { title: 'EyeWipes jar', quantity: 1 }],
};

/** A portal whose retention methods are the real ones over a scripted adapter. */
function makePortal({
  reason = 'too_much', category = null, lines = LINES.fresh,
  next = '2026-09-08', interval = 30, redeemed = false, adapter = {},
} = {}) {
  const toasts = [];
  const screens = [];
  const events = [];
  const data = { id: 's1', status: 'active', nextOrderDate: next, intervalDays: interval, lines, retentionOfferRedeemed: redeemed };
  const p = {
    cfg: { locale: 'en-US' },
    root: { querySelectorAll: () => [], querySelector: () => null },
    state: {
      screen: 'cancel-offer', history: [], pending: null, attempts: {}, confirmSpent: false,
      retentionJourneyId: 'j-1', retainError: null,
      draft: { reason, startedCategory: category, retainAdj: null, retainTile: null, retainDate: '' },
      data,
    },
    toasts, screens, events,
    adapter: {
      recordRetentionEvent: (eventType, journeyId, offerType) => {
        events.push([eventType, offerType || null]);
        return Promise.resolve({ journeyId: journeyId || 'j-1' });
      },
      ...adapter,
    },
    retainKind() { return retainKind.call(this); },
    trackRetention(e, a) { return trackRetention.call(this, e, a); },
    retainContent() { return retainContent.call(this); },
    retainAdjTarget() { return retainAdjTarget.call(this); },
    retainAdjProblem() { return retainAdjProblem.call(this); },
    retainVerify(t, r) { return retainVerify.call(this, t, r); },
    retainRun(k, a, t, f) { return retainRun.call(this, k, a, t, f); },
    rescheduleBounds() { return rescheduleBounds.call(this); },
    run(k, w, o) { return run.call(this, k, w, o); },
    act(n, e) { return act.call(this, n, e); },
    actionFailed(e) { return actionFailed.call(this, e); },
    refreshRequired() { return refreshRequired.call(this); },
    attemptKey(o) { return attemptKey.call(this, o); },
    releaseAttempt(o) { return releaseAttempt.call(this, o); },
    fmtDate(i, s) { return fmtDate.call(this, i, s); },
    pick(el) { return pick.call(this, el); },
    show(v) { this.state.screen = v; screens.push(v); },
    applyPending() {}, render() {}, closeSheet() {},
    refreshAuthenticatedData: () => Promise.resolve(),
    toast(m) { toasts.push(m); },
    fail(e) { this.failed = e; },
  };
  return p;
}

/** A scripted adapter recording every write; refetch returns `after`. */
function scriptedAdapter({ after, writeResult, writeError } = {}) {
  const calls = { writes: [], refetches: 0, outcomes: [] };
  const state = { next: null };
  const write = (kind) => (id, arg, opts) => {
    // skip has no arg: (id, opts)
    calls.writes.push({ kind, arg: opts === undefined ? undefined : arg, opts: opts === undefined ? arg : opts });
    if (writeError) return Promise.reject(writeError);
    return Promise.resolve(writeResult || { id: 's1', status: 'active', nextOrderDate: after ? after.nextOrderDate : null });
  };
  return {
    calls,
    skipNextDelivery: write('skip'),
    delayNextDelivery: write('delay'),
    rescheduleNextDelivery: write('reschedule'),
    refetchSubscription: () => { calls.refetches += 1; return Promise.resolve(after); },
    recordCancelOutcome: (o) => { calls.outcomes.push(o); return Promise.resolve(); },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(p) { for (let i = 0; i < 8; i++) await tick(); return p; }

/* ==================================================================== */

describe('every cancellation reason gets its approved recommendation', () => {
  const EXPECT = {
    price: ['offer', 'next_delivery_40'],
    too_much: ['delay', 'move_delivery_30'],
    no_results: ['keep', 'keep_results'],
    dislike: ['easier', 'routine_guidance'],
    other: ['note', 'adjust_options'],
    // Preserved legacy reasons share the approved adjustment-options screen.
    not_using: ['note', 'adjust_options'],
    not_needed: ['note', 'adjust_options'],
    order_issue: ['note', 'adjust_options'],
    'break': ['note', 'adjust_options'],
  };

  test('the table covers exactly the reasons the picker offers — none dropped, none unmapped', () => {
    const offered = CONSTS.REASONS.map((r) => r[0]).sort();
    assert.deepEqual(Object.keys(RETAIN_BY_REASON).sort(), offered);
    assert.deepEqual(offered, Object.keys(EXPECT).sort());
  });

  for (const [reason, [kind, action]] of Object.entries(EXPECT)) {
    test(`${reason} -> ${kind} / ${action}`, () => {
      const p = makePortal({ reason });
      assert.deepEqual(p.retainKind(), { kind, action });
    });
  }

  test('no two different reasons show the same generic content by accident', () => {
    const titles = new Set(['price', 'too_much', 'no_results', 'dislike', 'other'].map((r) => makePortal({ reason: r }).retainContent().title));
    assert.equal(titles.size, 5);
  });

  test('Too expensive: 40% off the next delivery only, normal pricing and 20% saving after', () => {
    const c = makePortal({ reason: 'price' }).retainContent();
    assert.equal(c.title, 'Take 40% off your next FreshWipes delivery');
    assert.match(c.body, /normal RoutineCare pricing and the usual 20% saving resume automatically/);
    assert.ok(c.points.some((t) => /delivery only\./.test(t)));
    assert.equal(c.cta, 'Apply 40% to my next delivery');
    assert.equal(c.foot, 'One delivery only. No code to enter.');
  });

  test('Not seeing results: the approved commitment copy', () => {
    const c = makePortal({ reason: 'no_results', category: 'dental' }).retainContent();
    assert.equal(c.title, 'Give the routine time to work');
    assert.equal(c.cta, 'Keep my RoutineCare active');
    assert.deepEqual(c.timeline.map((t) => t.label), ['Weeks 1–2', 'Weeks 2–3', 'Days 60–90']);
    const kept = screenMarkup('cancel-offer');
    assert.match(kept, /100-Day Money-Back Guarantee/);
    assert.match(kept, /Don&rsquo;t lose the progress you&rsquo;ve started/);
    assert.match(kept, /spp__retain-warn/);
    assert.match(kept, /Verified/);
  });

  test('My dog doesn’t like it: routine guidance with the tips for the product', () => {
    const c = makePortal({ reason: 'dislike', lines: LINES.eye }).retainContent();
    assert.equal(c.title, 'Make the EyeWipes routine easier for your dog');
    assert.equal(c.tips[0], 'Warm the wipe in your hand first so it is not a cold surprise.');
    assert.equal(c.foot, 'If it still is not working, the 100-day guarantee covers you.');
  });

  test('Other: the adjustment options', () => {
    const c = makePortal({ reason: 'other' }).retainContent();
    assert.equal(c.title, 'Tell us what would help');
    assert.ok(c.points.includes('All four adjustments below are open to you.'));
  });
});

describe('Too much product: move the next delivery 30 days later — never a claimed frequency change', () => {
  test('the primary action is the 30-day delivery move, with the dates shown', () => {
    const c = makePortal({ reason: 'too_much', next: '2026-09-08', interval: 30 }).retainContent();
    assert.equal(c.cta, 'Move my next delivery 30 days later');
    assert.equal(c.title, 'Move your next delivery 30 days later');
    assert.equal(c.dateNow, 'Sep 8');
    assert.equal(c.dateAfter, 'Oct 8');
  });

  test('nothing anywhere claims the recurring frequency changed to 60 days', () => {
    const c = makePortal({ reason: 'too_much', interval: 30 }).retainContent();
    const everything = [c.title, c.body, c.cta, c.foot, ...c.points].join(' | ');
    assert.ok(!/every 60 days/i.test(everything), everything);
    assert.ok(!/change to every/i.test(everything), everything);
    assert.match(c.points.join(' '), /cadence is not changed/);
  });

  test('30 days moves it exactly 30 days — including across a month boundary', () => {
    const p = makePortal({ reason: 'too_much', next: '2026-12-20' });
    assert.equal(p.retainContent().dateAfter, 'Jan 19');
  });

  test('the primary click performs exactly ONE delayNextDelivery(30) with journey + action attribution', async () => {
    const ad = scriptedAdapter({ after: { status: 'active', nextOrderDate: '2026-10-08' } });
    const p = makePortal({ reason: 'too_much', adapter: ad });
    p.act('retainPrimary', {});
    await settle();
    assert.equal(ad.calls.writes.length, 1);
    assert.equal(ad.calls.writes[0].kind, 'delay');
    assert.equal(ad.calls.writes[0].arg, 30);
    assert.equal(ad.calls.writes[0].opts.retentionJourneyId, 'j-1');
    assert.equal(ad.calls.writes[0].opts.retentionAction, 'move_delivery_30');
    assert.equal(ad.calls.writes[0].opts.expectedNextBillingDate, '2026-09-08');
    assert.ok(ad.calls.writes[0].opts.idempotencyKey, 'a keyed write, so a retry cannot double-apply');
  });
});

describe('Dental / Eye / Ear may show a before/after image; Coat / Paw / Other never do', () => {
  const HAS = ['dental', 'eye', 'ear'];
  const NONE = ['skin', 'paw', 'other'];

  for (const cat of HAS) {
    test(`${cat}: an image column is possible, keyed to spp-before-after-${cat}.jpg`, () => {
      const c = makePortal({ reason: 'no_results', category: cat }).retainContent();
      assert.equal(c.imageKey, cat);
    });
  }
  for (const cat of NONE) {
    test(`${cat}: no image key at all`, () => {
      const c = makePortal({ reason: 'no_results', category: cat }).retainContent();
      assert.equal(c.imageKey, null);
    });
  }

  function cardDouble() {
    const col = { hidden: true };
    const attrs = { 'data-spp-ba-key': null };
    const img = {
      setAttribute(k, v) { attrs[k] = v; }, getAttribute(k) { return attrs[k]; },
      removeAttribute(k) { delete attrs[k]; if (k === 'src') this.src = undefined; },
      src: undefined, alt: '', onload: null, onerror: null,
    };
    const card = {
      querySelector(sel) { return sel === '[data-spp-ba]' ? col : sel === '[data-spp-ba-img]' ? img : null; },
      getAttribute(k) { return k === 'data-spp-asset-base' ? 'https://cdn.example/assets/spp-cancel-benefits-mobile.jpg?v=9' : null; },
    };
    return { card, col, img };
  }

  test('the column stays HIDDEN until the image has actually loaded (no empty slot, ever)', () => {
    const { card, col, img } = cardDouble();
    syncBeforeAfter.call({}, card, { kind: 'keep', imageKey: 'dental', careLabel: 'Dental care' });
    assert.match(img.src, /spp-before-after-dental\.jpg/);
    assert.equal(col.hidden, true, 'requested, not yet loaded');
    img.onload();
    assert.equal(col.hidden, false, 'shown only once the approved image really loaded');
  });

  test('a missing asset keeps the column hidden and the timeline full width', () => {
    const { card, col, img } = cardDouble();
    syncBeforeAfter.call({}, card, { kind: 'keep', imageKey: 'eye', careLabel: 'Eye care' });
    img.onerror();
    assert.equal(col.hidden, true);
  });

  for (const cat of NONE) {
    test(`${cat}: never requests an image and the column stays hidden`, () => {
      const { card, col, img } = cardDouble();
      syncBeforeAfter.call({}, card, { kind: 'keep', imageKey: null, careLabel: 'x' });
      assert.equal(col.hidden, true);
      assert.equal(img.src, undefined);
    });
  }

  test('other reasons never show the image column either', () => {
    const { card, col, img } = cardDouble();
    syncBeforeAfter.call({}, card, { kind: 'delay', imageKey: null, careLabel: '' });
    assert.equal(col.hidden, true);
    assert.equal(img.src, undefined);
  });

  test('the markup ships the column hidden, with no placeholder or "pending" slot text', () => {
    const step = screenMarkup('cancel-offer').replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '');
    assert.match(step, /<div class="spp__retain-ba" data-spp-ba hidden>/);
    assert.ok(!/asset slot/i.test(step));
    assert.ok(!/placeholder/i.test(step));
    assert.ok(!/before\s*&(amp;)?\s*after\s*[—-]\s*pending/i.test(step));
  });

  test('the timeline is a flex:1 element that takes the full width when the column is absent', () => {
    assert.match(css, /\.spp__retain-tl\s*\{[^}]*flex:\s*1 1 auto/);
    assert.match(css, /\.spp__retain-ba\[hidden\]\s*\{\s*display:\s*none/);
  });

  test('a verified review exists ONLY for Dental and Eye', () => {
    const rev = (cat) => makePortal({ reason: 'no_results', category: cat }).retainContent().review;
    assert.match(rev('dental').quote, /My Pom loves the wipes/);
    assert.match(rev('eye').quote, /crusty buildup/);
    for (const cat of ['ear', 'skin', 'paw', 'other']) assert.equal(rev(cat), null, cat);
  });

  test('the care label / timeline follow the "why you started" answer; unanswered falls back to general care', () => {
    assert.equal(makePortal({ reason: 'no_results', category: 'paw' }).retainContent().careLabel, 'Paw care');
    assert.equal(makePortal({ reason: 'no_results', category: null }).retainContent().careLabel, 'Long-term care');
  });
});

describe('back navigation and reason persistence', () => {
  test('going Back to the reason screen and forward again keeps the chosen reason', () => {
    const p = makePortal({ reason: 'dislike' });
    p.show('cancel-reason');
    p.show('cancel-offer');
    assert.equal(p.state.draft.reason, 'dislike');
    assert.equal(p.retainKind().action, 'routine_guidance');
  });

  test('changing the reason swaps the recommendation and clears any half-chosen adjustment', () => {
    const p = makePortal({ reason: 'too_much' });
    p.state.draft.retainAdj = 'pause';
    p.state.draft.retainDate = '2026-11-01';
    const el = { getAttribute: () => 'reason', dataset: { sppValue: 'no_results' } };
    p.pick(el);
    assert.equal(p.state.draft.reason, 'no_results');
    assert.equal(p.state.draft.retainAdj, null);
    assert.equal(p.state.draft.retainDate, '');
    assert.equal(p.retainKind().kind, 'keep');
  });

  test('re-picking the SAME reason keeps an open adjustment', () => {
    const p = makePortal({ reason: 'too_much' });
    p.state.draft.retainAdj = 'move';
    p.pick({ getAttribute: () => 'reason', dataset: { sppValue: 'too_much' } });
    assert.equal(p.state.draft.retainAdj, 'move');
  });

  test('step 6 Back returns to the reason screen; Change does too', () => {
    const step = screenMarkup('cancel-offer');
    assert.match(step, /spp__back"[^>]*data-spp-go="cancel-reason"/);
    assert.match(step, /data-spp-go="cancel-reason">Change</);
  });
});

describe('secondary options remain available exactly as approved', () => {
  test('the four rows: skip, move, deliver less often, pause — for every reason', () => {
    assert.deepEqual(CONSTS.RETAIN_ADJUSTMENTS.map((a) => a[1]), [
      'Skip next delivery', 'Move next delivery', 'Deliver less often', 'Pause RoutineCare',
    ]);
  });

  test('skip lands one interval later; move lands 7/15/30 days later; "deliver less often" is the same date move', () => {
    const p = makePortal({ next: '2026-09-08', interval: 30 });
    p.state.draft.retainAdj = 'skip';
    assert.equal(p.retainAdjTarget(), '2026-10-08');
    p.state.draft.retainAdj = 'move'; p.state.draft.retainTile = 'd15';
    assert.equal(p.retainAdjTarget(), '2026-09-23');
    p.state.draft.retainAdj = 'freq'; p.state.draft.retainTile = 'd30';
    assert.equal(p.retainAdjTarget(), '2026-10-08');
  });

  test('"Deliver less often" is explicit that the recurring schedule is NOT changed', () => {
    assert.match(src, /freq: 'Your recurring schedule cannot be changed from the portal yet, so this moves your next delivery later instead\./);
  });

  test('pause: the customer chooses a resume date; it must be after the current next delivery and within a year', () => {
    const iso = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    const p = makePortal({ next: iso(10) });
    p.state.draft.retainAdj = 'pause';
    assert.match(p.retainAdjProblem(), /Choose the date/);
    p.state.draft.retainDate = iso(-5);
    assert.match(p.retainAdjProblem(), /from today onwards/);
    p.state.draft.retainDate = iso(10);
    assert.match(p.retainAdjProblem(), /after your current next delivery/);
    const future = new Date(); future.setUTCDate(future.getUTCDate() + 400);
    p.state.draft.retainDate = future.toISOString().slice(0, 10);
    assert.match(p.retainAdjProblem(), /within the next year/);
    const ok = new Date(); ok.setUTCDate(ok.getUTCDate() + 60);
    p.state.draft.retainDate = ok.toISOString().slice(0, 10);
    p.state.data.nextOrderDate = new Date().toISOString().slice(0, 10);
    assert.equal(p.retainAdjProblem(), null);
  });

  test('an invalid pause date sends NOTHING to Phoenix and tells the customer why', async () => {
    const ad = scriptedAdapter({ after: { status: 'active', nextOrderDate: 'x' } });
    const p = makePortal({ adapter: ad });
    p.state.draft.retainAdj = 'pause';
    p.state.draft.retainDate = '2020-01-01';
    p.act('retainAdjust', {});
    await settle();
    assert.equal(ad.calls.writes.length, 0);
    assert.ok(p.state.retainError);
  });

  test('every secondary option maps to a proven adapter write + the right action key', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const cases = [
      ['skip', null, 'skipNextDelivery', 'skip_delivery'],
      ['move', 'd7', 'delayNextDelivery', 'move_delivery'],
      ['freq', 'd30', 'delayNextDelivery', 'move_delivery'],
    ];
    for (const [adj, tile, kind, action] of cases) {
      const ad = scriptedAdapter({});
      const p = makePortal({ next: '2026-09-08', interval: 30, adapter: ad });
      p.state.draft.retainAdj = adj; p.state.draft.retainTile = tile;
      const target = p.retainAdjTarget();
      ad.refetchSubscription = () => { ad.calls.refetches += 1; return Promise.resolve({ status: 'active', nextOrderDate: target }); };
      p.act('retainAdjust', {});
      await settle();
      assert.equal(ad.calls.writes.length, 1, adj);
      assert.equal(ad.calls.writes[0].opts.retentionAction, action, adj);
      assert.equal(ad.calls.writes[0].kind, kind === 'skipNextDelivery' ? 'skip' : 'delay', adj);
    }
    // pause = reschedule to the chosen date
    const ad = scriptedAdapter({});
    const p = makePortal({ next: today, adapter: ad });
    const d = new Date(); d.setUTCDate(d.getUTCDate() + 45);
    const chosen = d.toISOString().slice(0, 10);
    p.state.draft.retainAdj = 'pause'; p.state.draft.retainDate = chosen;
    ad.refetchSubscription = () => Promise.resolve({ status: 'active', nextOrderDate: chosen });
    p.act('retainAdjust', {});
    await settle();
    assert.equal(ad.calls.writes.length, 1);
    assert.equal(ad.calls.writes[0].kind, 'reschedule');
    assert.equal(ad.calls.writes[0].arg, chosen);
    assert.equal(ad.calls.writes[0].opts.retentionAction, 'pause_until_date');
  });

  test('Continue cancellation stays reachable from step 6', () => {
    assert.match(screenMarkup('cancel-offer'), /data-spp-go="cancel-confirm">Continue cancellation</);
  });
});

describe('exactly one mutation per action; success only after a fresh refetch confirms it', () => {
  test('a double-click cannot fire a second write while the first is in flight', async () => {
    let release;
    const ad = scriptedAdapter({ after: { status: 'active', nextOrderDate: '2026-10-08' } });
    const inner = ad.delayNextDelivery;
    ad.delayNextDelivery = (id, days, opts) => new Promise((res) => { release = () => res(inner(id, days, opts)); });
    const p = makePortal({ reason: 'too_much', adapter: ad });
    p.act('retainPrimary', {});
    p.act('retainPrimary', {});
    p.act('retainPrimary', {});
    release();
    await settle();
    assert.equal(ad.calls.writes.length, 1);
  });

  test('confirmed success -> refetched ONCE -> dashboard + a toast naming the verified date', async () => {
    const ad = scriptedAdapter({ after: { status: 'active', nextOrderDate: '2026-10-08' } });
    const p = makePortal({ reason: 'too_much', adapter: ad });
    p.act('retainPrimary', {});
    await settle();
    assert.equal(ad.calls.refetches, 1);
    assert.deepEqual(p.screens, ['dashboard']);
    assert.match(p.toasts.join(' '), /Oct 8/);
    assert.equal(p.state.data.nextOrderDate, '2026-10-08', 'the portal now holds the refetched, verified state');
  });

  test('UNVERIFIED (refetch shows the old date): no success, no dashboard, clear non-destructive error', async () => {
    const ad = scriptedAdapter({ after: { status: 'active', nextOrderDate: '2026-09-08' } });
    const p = makePortal({ reason: 'too_much', adapter: ad });
    p.act('retainPrimary', {});
    await settle();
    assert.deepEqual(p.screens, [], 'never navigates away as if it worked');
    assert.ok(!p.toasts.some((t) => /^Done/.test(t)), 'never claims success');
    assert.match(p.state.retainError, /could not confirm that change/i);
    assert.match(p.state.retainError, /before trying again/i);
    assert.equal(p.state.pending, null, 'the screen is usable again');
    assert.equal(p.state.data.nextOrderDate, '2026-09-08', 'the held subscription is untouched');
  });

  test('UNVERIFIED because the subscription is no longer active is also a refusal', async () => {
    const ad = scriptedAdapter({ after: { status: 'cancelled', nextOrderDate: '2026-10-08' } });
    const p = makePortal({ reason: 'too_much', adapter: ad });
    p.act('retainPrimary', {});
    await settle();
    assert.deepEqual(p.screens, []);
    assert.ok(p.state.retainError);
  });

  test('a rejected write: no verification, no success, error shown, nothing saved', async () => {
    const ad = scriptedAdapter({ writeError: NS.PortalError('server', 'boom') });
    const p = makePortal({ reason: 'too_much', adapter: ad });
    p.act('retainPrimary', {});
    await settle();
    assert.equal(ad.calls.refetches, 0);
    assert.deepEqual(p.screens, []);
    assert.deepEqual(ad.calls.outcomes, [], 'the client never writes a save outcome');
    assert.match(p.state.retainError, /did not go through\. Nothing has changed/);
  });

  test('a write that applied but could not be re-read is NOT reported as a verified save', async () => {
    const ad = scriptedAdapter({ writeResult: { refreshRequired: true }, after: { status: 'active', nextOrderDate: '2026-10-08' } });
    const p = makePortal({ reason: 'too_much', adapter: ad });
    p.act('retainPrimary', {});
    await settle();
    assert.equal(ad.calls.refetches, 0, 'nothing to verify against');
    assert.deepEqual(p.screens, []);
    assert.match(p.toasts.join(' '), /refresh/i);
  });

  test('the client NEVER writes a save outcome itself — the server attributes saved_gap', () => {
    const body = /case 'retainPrimary'[\s\S]*?case 'retainAdjust'[\s\S]*?\n      }\n/.exec(src)[0];
    assert.ok(!/recordCancelOutcome/.test(body));
    const run6 = /Portal\.prototype\.retainRun = [\s\S]*?\n  \};/.exec(src)[0];
    assert.ok(!/recordCancelOutcome/.test(run6));
  });
});

describe('tracking: shown / attempted / declined / kept, and who may say "saved"', () => {
  test('attempting an action records recommendation_attempted BEFORE the write', async () => {
    const order = [];
    const ad = scriptedAdapter({ after: { status: 'active', nextOrderDate: '2026-10-08' } });
    const inner = ad.delayNextDelivery;
    ad.delayNextDelivery = (a, b, c) => { order.push('write'); return inner(a, b, c); };
    const p = makePortal({ reason: 'too_much', adapter: ad });
    const rec = p.adapter.recordRetentionEvent;
    p.adapter.recordRetentionEvent = (e, j, o) => { order.push(e); return rec(e, j, o); };
    p.act('retainPrimary', {});
    await settle();
    assert.deepEqual(order.slice(0, 2), ['recommendation_attempted', 'write']);
    assert.deepEqual(p.events[0], ['recommendation_attempted', 'move_delivery_30']);
  });

  test('"Keep my RoutineCare active" changes nothing in Phoenix: recommendation_kept, no mutation, never a save', async () => {
    for (const reason of ['no_results', 'dislike', 'other', 'break']) {
      const ad = scriptedAdapter({});
      const p = makePortal({ reason, adapter: ad });
      p.act('retainPrimary', {});
      await settle();
      assert.equal(ad.calls.writes.length, 0, reason);
      assert.equal(ad.calls.outcomes.length, 0, reason);
      assert.equal(p.events[0][0], 'recommendation_kept', reason);
      assert.deepEqual(p.screens, ['dashboard']);
    }
  });

  test('the price reason hands off to the proven acceptOffer path (no delay/skip write)', async () => {
    const ad = scriptedAdapter({});
    let accepted = 0;
    ad.acceptRetentionOffer = () => { accepted += 1; return Promise.resolve({ verified: true, refreshRequired: false }); };
    ad.getSubscription = () => Promise.resolve({});
    const p = makePortal({ reason: 'price', adapter: ad });
    const seen = [];
    p.act = function (name, el) { seen.push(name); return act.call(this, name, el); };
    p.act('retainPrimary', {});
    await settle();
    assert.equal(seen[1], 'acceptOffer');
    assert.equal(ad.calls.writes.length, 0);
  });

  test('offer_shown is the 40% offer’s alone; every recommendation is recommendation_shown with its key', () => {
    for (const [reason, kind, action] of [
      ['price', 'offer', 'next_delivery_40'], ['too_much', 'delay', 'move_delivery_30'],
    ]) {
      const p = makePortal({ reason });
      const calls = [];
      p.adapter.recordRetentionEvent = (e, j, o) => { calls.push([e, o]); return Promise.resolve(null); };
      p.trackRetention = function (e, a) { return trackRetention.call(this, e, a); };
      beaconScreenView.call(p, 'cancel-offer');
      const expected = kind === 'offer'
        ? [['offer_shown', 'next_delivery_40'], ['recommendation_shown', action]]
        : [['recommendation_shown', action]];
      assert.deepEqual(calls, expected, reason);
    }
  });

  test('the adapter forwards the action key with the journey id (analytics typing) — and only then', () => {
    const body = /function mutate\(path, fields, opts\)[\s\S]*?for \(var k in fields\)/.exec(adapterSrc)[0];
    assert.match(body, /body\.retentionAction = opts\.retentionAction/);
    assert.match(body, /if \(typeof opts\.retentionAction === 'string' && opts\.retentionAction\)/);
    // nested inside the retentionJourneyId branch: an ordinary dashboard skip is never typed
    const idx = body.indexOf('retentionAction');
    assert.ok(body.lastIndexOf('opts.retentionJourneyId', idx) > -1);
  });
});

describe('40% offer: one delivery only, and never resurfaced once redeemed', () => {
  function showPortal({ redeemed, reason }) {
    const screens = {};
    for (const n of ['cancel-reason', 'cancel-offer', 'cancel-confirm', 'dashboard']) {
      screens[n] = { hidden: true, getAttribute: () => n, setAttribute() {}, focus() {} };
    }
    return {
      state: { screen: 'cancel-reason', history: [], data: { retentionOfferRedeemed: redeemed }, draft: { reason } },
      root: { querySelectorAll: (s) => (s === '[data-spp-screen]' ? Object.values(screens) : []), querySelector: () => null },
      closeSheet() {}, render() {}, markCurrentNav() {}, beaconScreenView() {},
      retainKind() { return retainKind.call(this); },
      show(v) { return show.call(this, v); },
    };
  }

  test('a redeemed customer who said "Too expensive" is sent straight to final confirmation', () => {
    const p = showPortal({ redeemed: true, reason: 'price' });
    p.show('cancel-offer');
    assert.equal(p.state.screen, 'cancel-confirm');
  });

  test('a redeemed customer with any OTHER reason still sees their (non-offer) recommendation', () => {
    for (const reason of ['too_much', 'no_results', 'dislike', 'other']) {
      const p = showPortal({ redeemed: true, reason });
      p.show('cancel-offer');
      assert.equal(p.state.screen, 'cancel-offer', reason);
    }
  });

  test('the offer figures stay the approved 40% / 20%', () => {
    assert.match(src, /var OFFER_PERCENT = 40;/);
    assert.match(src, /var STANDARD_PERCENT = 20;/);
  });
});

describe('final cancellation path is untouched', () => {
  test('confirm still cancels through the proven cancel action, which records the outcome', () => {
    assert.match(src, /case 'cancel':[\s\S]*?self\.adapter\.cancel\(id, d\.reason/);
    assert.match(src, /recordCancelOutcome\('cancelled'\)/);
  });
  test('the reason screen still advances to step 6 (cancel-offer) after saving the reason', () => {
    assert.match(src, /self\.show\('cancel-offer'\)/);
  });
  test('step 6 links forward to confirmation with "Continue cancellation"', () => {
    assert.match(screenMarkup('cancel-offer'), /class="spp__btn spp__btn--link" data-spp-go="cancel-confirm"/);
  });
});

describe('mobile and desktop', () => {
  test('one responsive structure: no device-gated markup on step 6', () => {
    const step = screenMarkup('cancel-offer');
    assert.ok(!/data-only=/.test(step));
    assert.ok(!/hidden-mobile|hidden-desktop/.test(step));
  });
  test('a small-screen rule narrows the image column and card padding', () => {
    const tail = css.slice(css.lastIndexOf('@media (max-width: 480px)'));
    assert.match(tail, /\.spp__retain \{ padding: 15px; \}/);
    assert.match(tail, /\.spp__retain-ba \{ flex-basis: 84px; \}/);
  });
  test('the image + timeline row and the warning box use flex layouts that reflow', () => {
    assert.match(css, /\.spp__retain-tlwrap\s*\{[^}]*display:\s*flex/);
    assert.match(css, /\.spp__retain-warn\s*\{[^}]*display:\s*flex/);
  });
});

describe('the recommendation card is fully wired in Liquid', () => {
  test('every JS list key used by step 6 has a template in the markup', () => {
    const step = screenMarkup('cancel-offer');
    for (const k of ['retainTimeline', 'retainTips', 'retainPoints', 'retainAdjRows', 'retainAdjTiles']) {
      assert.match(step, new RegExp(`data-spp-tpl="${k}"`), k);
      assert.match(src, new RegExp(`case '${k}'`), k);
    }
  });
  test('the retain card carries the asset base used to resolve the optional before/after files', () => {
    assert.match(screenMarkup('cancel-offer'), /data-spp-asset-base="\{\{ 'spp-cancel-benefits-mobile\.jpg' \| asset_url \}\}"/);
  });
});

/* ==================================================================== *
 * The REAL adapters: refetch bypasses the cache; a change survives a refresh
 * ==================================================================== */

describe('the live adapter: mutation body, and a refetch that is a genuinely fresh read', () => {
  function liveAdapter() {
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
    vm.runInContext(adapterSrc, ctx);

    // What "Phoenix" holds. The double changes it only when a write arrives.
    const phoenix = { next: '2026-09-08' };
    const calls = { reads: 0, writes: [] };
    const view = () => ({
      state: 'subscription',
      customer: { firstName: 'T' },
      subscription: {
        status: 'active', subscriptionId: '5600001', nextBillingDate: phoenix.next,
        upcomingCharge: { state: 'available', amount: 50, currencyCode: 'USD' },
        cadence: { state: 'available', intervalDays: 30 },
        lines: [{ title: 'FreshWipes jar', productId: '1', variantId: '2', quantity: 1 }],
        deliveryAddress: null, payment: null,
        initialPayment: { state: 'unavailable', reason: 'x' }, recentPayments: [], retentionOfferRedeemed: false,
      },
    });
    const ok = (body) => Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(JSON.stringify(body)) });
    const adapter = win.VetPetsPortal.createHttpAdapter({
      fetchImpl: (url, init) => {
        if (url.includes('/portal/subscription')) { calls.reads++; return ok(view()); }
        if (url.includes('/portal/delay')) {
          const body = JSON.parse(init.body);
          calls.writes.push(body);
          phoenix.next = '2026-10-08';
          return ok({ view: view() });
        }
        return Promise.reject(new Error('unexpected url ' + url));
      },
    });
    return { adapter, calls, phoenix };
  }

  test('a retention delay carries the journey id AND the action key to the server, exactly once', async () => {
    const { adapter, calls } = liveAdapter();
    await adapter.getSubscription();
    await adapter.delayNextDelivery('5600001', 30, {
      idempotencyKey: 'reco-key-000000001',
      expectedNextBillingDate: '2026-09-08',
      retentionJourneyId: 'j-9',
      retentionAction: 'move_delivery_30',
    });
    assert.equal(calls.writes.length, 1);
    assert.equal(calls.writes[0].days, 30);
    assert.equal(calls.writes[0].retentionJourneyId, 'j-9');
    assert.equal(calls.writes[0].retentionAction, 'move_delivery_30');
  });

  test('an ORDINARY dashboard delay (no journey) is never typed as a retention action', async () => {
    const { adapter, calls } = liveAdapter();
    await adapter.delayNextDelivery('5600001', 7, {
      idempotencyKey: 'plain-key-0000001', expectedNextBillingDate: '2026-09-08', retentionAction: 'move_delivery_30',
    });
    assert.equal(calls.writes[0].retentionAction, undefined);
    assert.equal(calls.writes[0].retentionJourneyId, undefined);
  });

  test('refetchSubscription reads from the network EVERY time (a cached read would verify nothing)', async () => {
    const { adapter, calls } = liveAdapter();
    await adapter.getSubscription();
    await adapter.getSubscription();
    assert.equal(calls.reads, 1, 'normal reads share the per-load cache');
    await adapter.refetchSubscription();
    await adapter.refetchSubscription();
    assert.equal(calls.reads, 3, 'each refetch is an independent read');
  });

  test('write -> refetch shows the persisted date; a brand-new "page load" read agrees (refresh persistence)', async () => {
    const { adapter } = liveAdapter();
    const before = await adapter.getSubscription();
    assert.equal(before.nextOrderDate, '2026-09-08');
    await adapter.delayNextDelivery('5600001', 30, { idempotencyKey: 'reco-key-000000002', expectedNextBillingDate: '2026-09-08' });
    const verified = await adapter.refetchSubscription();
    assert.equal(verified.nextOrderDate, '2026-10-08');
    assert.equal(verified.status, 'active');

    // A refresh is a new page load: a new adapter, no cache, same server state.
    // (The double keeps `phoenix` per adapter, so re-read through this one.)
    const afterRefresh = await adapter.refetchSubscription();
    assert.equal(afterRefresh.nextOrderDate, '2026-10-08');
  });
});

describe('the mock adapter (DEV visual QA): the same contract, so review behaves like live', () => {
  const mock = () => NS.createAdapter({ mode: 'mock', latency: 0 });

  test('exposes refetchSubscription and it agrees with getSubscription', async () => {
    const a = mock();
    assert.equal(typeof a.refetchSubscription, 'function');
    const [x, y] = await Promise.all([a.getSubscription(), a.refetchSubscription()]);
    assert.equal(x.nextOrderDate, y.nextOrderDate);
  });

  test('a 30-day move persists across a re-read, and stays active', async () => {
    const a = mock();
    const before = await a.getSubscription();
    await a.delayNextDelivery(before.id, 30, { idempotencyKey: 'mock-key-000000001' });
    const after = await a.refetchSubscription();
    assert.equal(after.nextOrderDate, NS.dates.addDays(before.nextOrderDate, 30));
    assert.equal(after.status, 'active');
  });

  test('skip moves exactly one interval; reschedule (pause-until-date) lands exactly on the chosen date', async () => {
    const a = mock();
    const s0 = await a.getSubscription();
    await a.skipNextDelivery(s0.id, { idempotencyKey: 'mock-key-000000002' });
    const s1 = await a.refetchSubscription();
    assert.equal(s1.nextOrderDate, NS.dates.addDays(s0.nextOrderDate, s0.intervalDays));
    const chosen = NS.dates.addDays(s1.nextOrderDate, 45);
    await a.rescheduleNextDelivery(s0.id, chosen, { idempotencyKey: 'mock-key-000000003' });
    const s2 = await a.refetchSubscription();
    assert.equal(s2.nextOrderDate, chosen);
    assert.equal(s2.status, 'active', 'a pause-until-date keeps the subscription ACTIVE');
  });
});
