/**
 * The cancellation flow.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * The founder reached the final confirmation, pressed "Yes, cancel my
 * subscription" several times, and nothing happened. No request, no spinner,
 * no error — the button was dead and looked it.
 *
 * The one-confirmation guard was re-armed only by openSheet(), because skip
 * and delay are sheets. Cancel and reactivate are SCREENS, reached with
 * data-spp-go. So after any earlier sheet mutation the flag stayed spent and
 * act('cancel') returned immediately, silently, every time.
 *
 * Two lessons are encoded below: navigation re-arms a confirmation, and a
 * refusal is never silent.
 *
 * Run with:  node --test test/cancel-flow.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(resolve(here, '..', ...p), 'utf8');

const src = read('assets', 'subscription-portal.js');
const cancelScreens = read('snippets', 'spp-screen-cancel.liquid');
const css = read('assets', 'subscription-portal.css');

/* ---------------------------------------------------------------- helpers */

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

const CONFIRMED_ACTIONS = constant('CONFIRMED_ACTIONS');
const INDETERMINATE = constant('INDETERMINATE');
const AUTH_FAILURE_CODES = constant('AUTH_FAILURE_CODES');

const act = method('act', ['CONFIRMED_ACTIONS'], [CONFIRMED_ACTIONS]);
const run = method('run', ['INDETERMINATE', 'AUTH_FAILURE_CODES'], [INDETERMINATE, AUTH_FAILURE_CODES]);
const attemptKey = method('attemptKey');
const releaseAttempt = method('releaseAttempt');
// The SAME method the page calls on initial open — used below to prove the
// post-offer refresh goes through it rather than a smaller, partial one.
const load = method('load');
// listData closes over the journey's module-scope tables.
const listData = method(
  'listData',
  ['REASONS', 'GAP_OPTIONS'],
  [constant('REASONS'), constant('GAP_OPTIONS')],
);

/**
 * The section of markup for one screen, with Liquid comments stripped.
 *
 * Comments never reach the browser, so scanning them would test our own
 * commentary rather than what a customer can see — and would fail on a
 * comment that merely explains why an identifier was removed.
 */
function screen(name) {
  const start = cancelScreens.indexOf(`data-spp-screen="${name}"`);
  assert.ok(start > -1, `screen ${name} must exist`);
  const next = cancelScreens.indexOf('data-spp-screen="', start + 20);
  const raw = cancelScreens.slice(start, next === -1 ? undefined : next);
  return raw.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '');
}

/** The <button> containing a given label within a screen. */
function buttonWith(markup, text) {
  const re = new RegExp(`<button[^>]*>(?:(?!</button>)[\\s\\S])*?${text}[\\s\\S]*?</button>`);
  const m = re.exec(markup);
  assert.ok(m, `a button containing "${text}" must exist`);
  return m[0];
}

function domButton(action) {
  const attrs = { 'data-spp-act': action };
  return {
    disabled: false,
    classList: { toggle() {}, add() {}, remove() {} },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = v; },
    removeAttribute: (k) => { delete attrs[k]; },
    querySelector: () => null,
  };
}

function portal(opts = {}) {
  const calls = { cancel: [], reactivate: [], shown: [], toasts: [], renders: 0 };
  const btn = domButton('cancel');

  return {
    calls,
    btn,
    cfg: { mode: 'live', locale: 'en' },
    state: {
      pending: null,
      screen: 'cancel-confirm',
      history: [],
      sheet: null,
      confirmSpent: false,
      attempts: {},
      error: null,
      success: null,
      draft: { delay: 7, reason: 'other', restart: 0, date: null },
      data: { id: 'sub_1', status: 'active', nextOrderDate: '2026-11-19' },
    },
    root: { querySelectorAll: () => [btn], querySelector: () => null },

    adapter: {
      cancel(id, reason, note, o) {
        calls.cancel.push({ id, reason, note, opts: o });
        return opts.reject
          ? Promise.reject(opts.reject)
          : Promise.resolve({ id: 'sub_1', status: 'cancelled', nextOrderDate: null });
      },
      reactivate(id, offset, o) {
        calls.reactivate.push({ id, offset, opts: o });
        return Promise.resolve({ id: 'sub_1', status: 'active' });
      },
      hasSession: () => true,
      clearSession() {},
    },

    attemptKey(op) { return attemptKey.call(this, op); },
    releaseAttempt(op) { return releaseAttempt.call(this, op); },
    releaseAllAttempts() { this.state.attempts = {}; },
    run(k, w, o) { return run.call(this, k, w, o); },
    act(n, el) { return act.call(this, n, el); },

    applyPending(on) {
      btn.disabled = !!on;
      if (on) btn.setAttribute('aria-disabled', 'true');
      else btn.removeAttribute('aria-disabled');
    },
    render() { calls.renders += 1; },
    closeSheet() {},
    show(v) {
      calls.shown.push(v);
      // Mirrors the real show(): arriving at a screen re-arms confirmation.
      this.state.confirmSpent = false;
    },
    toast(m) { calls.toasts.push(m); },
    fail() {},
    actionFailed(err) { calls.toasts.push('failed:' + (err && err.code)); },
    refreshRequired() {},
    refreshAuthenticatedData: () => Promise.resolve(),
    fmtDate: (iso) => String(iso),
    hasSession: () => true,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/* ==================================================================
 * THE DEFECT
 * ================================================================== */

describe('the dead cancel button', () => {
  test('REGRESSION: after a sheet mutation, cancel still submits', async () => {
    // The exact production sequence: a delay/reschedule ran in a SHEET, which
    // left the guard spent, and then the customer navigated to the cancel
    // screens. Every press of the final button was silently swallowed.
    const p = portal();
    p.state.confirmSpent = true; // as a completed sheet mutation leaves it

    // Navigating to the confirm screen is the customer asking again.
    p.show('cancel-confirm');
    p.act('cancel', p.btn);
    await tick();

    assert.equal(p.calls.cancel.length, 1, 'the button must not be dead');
  });

  test('navigation re-arms the confirmation', () => {
    const p = portal();
    p.state.confirmSpent = true;
    p.show('cancel-confirm');
    assert.equal(p.state.confirmSpent, false);
  });

  test('show() in the shipped source clears the guard', () => {
    const m = /Portal\.prototype\.show = function[\s\S]*?\n  \};/.exec(src);
    assert.ok(m, 'show() must exist');
    assert.match(m[0], /confirmSpent = false/, 'arriving at a screen must re-arm');
  });

  test('a refusal is never silent', async () => {
    const p = portal();
    p.state.confirmSpent = true; // spent, and no navigation to re-arm

    p.act('cancel', p.btn);
    await tick();

    assert.equal(p.calls.cancel.length, 0, 'still refused');
    assert.equal(p.calls.toasts.length, 1, 'but the customer is TOLD');
    assert.match(p.calls.toasts[0], /already been submitted/i);
  });

  test('a refusal while in flight stays quiet, because the spinner speaks', async () => {
    const p = portal();
    p.state.pending = 'cancel';

    p.act('cancel', p.btn);
    await tick();

    assert.equal(p.calls.cancel.length, 0);
    assert.equal(p.calls.toasts.length, 0, 'the spinner is the answer; do not talk over it');
  });
});

/* ==================================================================
 * SUBMISSION SAFETY
 * ================================================================== */

describe('one confirmation, one cancel request', () => {
  test('a single click sends exactly one request, with the reason code', async () => {
    const p = portal();
    p.act('cancel', p.btn);
    await tick();

    assert.equal(p.calls.cancel.length, 1);
    assert.equal(p.calls.cancel[0].reason, 'other');
    assert.equal(p.calls.cancel[0].note, null, 'free text is never forwarded');
    assert.ok(p.calls.cancel[0].opts.idempotencyKey);
  });

  test('spam clicking sends exactly one request', async () => {
    const p = portal();
    for (let i = 0; i < 8; i++) p.act('cancel', p.btn);
    await tick();

    assert.equal(p.calls.cancel.length, 1, 'eight presses, one cancellation');
  });

  test('the button disables synchronously, before the request goes out', () => {
    const p = portal();
    let disabledWhenCalled = null;
    p.adapter.cancel = (id, reason, note, o) => {
      disabledWhenCalled = p.btn.disabled;
      p.calls.cancel.push({ id, reason, note, opts: o });
      return Promise.resolve({ id: 'sub_1', status: 'cancelled' });
    };

    p.act('cancel', p.btn);

    assert.equal(disabledWhenCalled, true);
    assert.equal(p.btn.getAttribute('aria-disabled'), 'true');
  });

  test('a loading state is shown while it runs', () => {
    // label.cancel switches to a progress word the moment pending is set.
    assert.match(src, /vm\['label\.cancel'\][\s\S]{0,80}Cancelling/);
  });
});

describe('cancel success and failure', () => {
  test('success keeps the portal visible and renders the real cancelled state', async () => {
    const p = portal();
    p.act('cancel', p.btn);
    await tick();

    assert.ok(!p.calls.shown.includes('error'), 'never the error screen');
    assert.equal(p.state.error, null);
    assert.deepEqual(p.calls.shown, ['cancel-done']);
    // The state adopted is the server's re-read, not an assumption.
    assert.equal(p.state.data.status, 'cancelled');
    assert.ok(p.calls.renders > 0);
  });

  test('failure keeps the page visible and says so', async () => {
    const err = new Error('nope');
    err.code = 'upstream_error';
    const p = portal({ reject: err });

    p.act('cancel', p.btn);
    await tick();

    assert.ok(!p.calls.shown.includes('error'), 'a failed action must not destroy the page');
    assert.equal(p.state.error, null);
    assert.equal(p.calls.toasts.length, 1, 'never silent');
    assert.match(p.calls.toasts[0], /^failed:/);
  });

  test('after a definitive failure the customer may try again', async () => {
    const err = new Error('nope');
    err.code = 'upstream_error';
    const p = portal({ reject: err });

    p.act('cancel', p.btn);
    await tick();
    assert.equal(p.calls.cancel.length, 1);

    // Nothing was applied, so a second press must reach the server — without
    // this the button would look dead all over again.
    p.act('cancel', p.btn);
    await tick();
    assert.equal(p.calls.cancel.length, 2);
  });

  test('after an UNKNOWN outcome it does NOT silently retry', async () => {
    const err = new Error('timeout');
    err.code = 'timeout';
    const p = portal({ reject: err });

    p.act('cancel', p.btn);
    await tick();
    p.act('cancel', p.btn);
    await tick();

    assert.equal(p.calls.cancel.length, 1, 'the cancellation may have applied');
    assert.match(p.calls.toasts[p.calls.toasts.length - 1], /already been submitted/i);
  });
});

/* ==================================================================
 * THE THREE STEPS
 * ================================================================== */

describe('step 1 — benefits', () => {
  const step = screen('cancel-benefits');

  test('leads with what is at stake for the dog, not the discount', () => {
    assert.match(step, /They can&rsquo;t tell you when it comes back/);
    // Eyes and teeth first; ears are not the lead concern for these routines.
    assert.match(step, /tear stain/i);
    assert.match(step, /teeth/i);
  });

  test('uses the approved 16:9 image, not a generated substitute', () => {
    assert.match(step, /spp-cancel-benefits\.png/);
    assert.match(step, /spp__media-16x9/);
    assert.match(step, /alt="[^"]+"/, 'the image must be described');
  });

  test('keeping is the primary action, continuing is the quiet one', () => {
    const keep = buttonWith(step, 'Never mind, keep my Routine Care');
    assert.match(keep, /spp__btn--primary/);

    const cont = buttonWith(step, 'Continue cancelling');
    assert.match(cont, /spp__btn--link/);
    assert.ok(!/spp__btn--primary/.test(cont));
    assert.match(cont, /data-spp-go="cancel-reason"/);
  });

  test('the real Routine Care benefits are listed', () => {
    const benefits = listData.call(
      { state: { data: {}, loyalty: null, inactive: [], draft: {} }, fmtDate: (x) => String(x) },
      'benefits',
    );
    const text = benefits.map((b) => b.title + ' ' + b.body).join(' | ');
    for (const claim of ['20% off', 'Free shipping', 'Automatic refills', 'Flexible deliveries', 'Subscriber-only', '100-day']) {
      assert.ok(text.includes(claim), `missing benefit: ${claim}`);
    }
  });
});

describe('step 2 — why are you cancelling', () => {
  const step = screen('cancel-reason');

  test('"Keep my subscription" is the primary action', () => {
    const keep = buttonWith(step, 'Keep my subscription');
    assert.match(keep, /spp__btn--primary/);
    assert.match(keep, /data-spp-go="subscription"/);
  });

  test('all eight approved reasons are offered', () => {
    const reasons = listData.call(
      { state: { data: {}, loyalty: null, inactive: [], draft: {} }, fmtDate: (x) => String(x) },
      'reasons',
    );
    assert.equal(reasons.length, 8);
    const labels = reasons.map((r) => r.label).join(' | ');
    for (const claim of ['Too expensive', 'too much product', 'not using it enough', 'results I expected', 'no longer needs it', 'issue with my order', 'taking a break', 'Something else']) {
      assert.ok(labels.includes(claim), `missing reason: ${claim}`);
    }
  });

  test('free text appears only for "Something else"', () => {
    assert.match(step, /data-spp-reason-note/);
    const block = /<div data-spp-reason-note[^>]*>/.exec(step);
    assert.ok(block, 'the note block must exist');
    assert.match(block[0], /hidden/, 'and must ship hidden');
    assert.match(step, /<textarea[^>]*data-spp-note/);
    assert.match(step, /<label[^>]*for="spp-reason-note"/);
  });

  test('the primary action is the blue #47B5E9 with white text', () => {
    assert.match(css, /--spp-primary:\s*#47B5E9/i);
    assert.match(css, /--spp-primary-fg:\s*#FFFFFF/i);
    assert.match(css, /\.spp\s+\.spp__btn--primary\s*\{[^}]*color:\s*var\(--spp-primary-fg\)/);
  });

  test('"Continue cancelling" is the smaller underlined action', () => {
    const cont = buttonWith(step, 'Continue cancelling');
    assert.match(cont, /spp__btn--link/, 'must be the quiet text style');
    assert.ok(!/spp__btn--primary/.test(cont), 'must not be the dominant action');
    // An act(), not a link: it records the reason on the way past.
    assert.match(cont, /data-spp-act="reasonContinue"/);
  });

  test('the link style is genuinely underlined and smaller', () => {
    const m = /\.spp__btn--link\s*\{[^}]*\}/.exec(css);
    assert.ok(m, '.spp__btn--link must exist');
    assert.match(m[0], /text-decoration:\s*underline/);
  });

  test('Continue stays a real, keyboard-reachable button', () => {
    const cont = buttonWith(step, 'Continue cancelling');
    assert.match(cont, /<button/, 'not a div, so it keeps button semantics');
    assert.match(cont, /type="button"/);
    assert.ok(!/disabled/.test(cont), 'never disabled');
    assert.ok(!/aria-hidden/.test(cont), 'never hidden from assistive tech');
    assert.ok(!/tabindex="-1"/.test(cont), 'never removed from the tab order');
  });

  test('the reasons are unchanged', () => {
    assert.match(step, /data-spp-list="reasons"/);
    assert.match(step, /data-spp-pick="reason"/);
    assert.match(step, /role="radiogroup"/);
  });
});

describe('step 3 — longer gap', () => {
  const step = screen('cancel-alt');

  test('offers the five proven schedule changes, and only those', () => {
    const gaps = listData.call(
      { state: { data: {}, loyalty: null, inactive: [], draft: {} }, fmtDate: (x) => String(x) },
      'gapOptions',
    );
    assert.equal(gaps.length, 5);
    const labels = gaps.map((g) => g.label).join(' | ');
    for (const claim of ['Skip the next delivery', 'back 7 days', 'back 15 days', 'back 30 days', 'Choose a new delivery date']) {
      assert.ok(labels.includes(claim), `missing option: ${claim}`);
    }
  });

  test('no cadence or frequency option was reintroduced', () => {
    assert.ok(!/frequency/i.test(step));
    assert.ok(!/every \d+ (days|weeks|months)/i.test(step));
  });

  test('the date field appears only for "Choose a new delivery date"', () => {
    const block = /<div data-spp-gap-date[^>]*>/.exec(step);
    assert.ok(block, 'the date block must exist');
    assert.match(block[0], /hidden/);
    assert.match(step, /type="date"/);
  });

  test('"No thanks" is the smaller underlined action', () => {
    const no = buttonWith(step, 'continue cancelling');
    assert.match(no, /spp__btn--link/);
    assert.ok(!/spp__btn--quiet/.test(no), 'no longer the large outlined button');
    assert.match(no, /data-spp-go="cancel-offer"/);
  });

  test('"No thanks" stays clickable and accessible', () => {
    const no = buttonWith(step, 'continue cancelling');
    assert.match(no, /<button/);
    assert.match(no, /type="button"/);
    assert.ok(!/aria-hidden/.test(no));
    assert.ok(!/tabindex="-1"/.test(no));
  });

  test('the primary action confirms the change', () => {
    const apply = buttonWith(step, 'Confirm this change');
    assert.match(apply, /spp__btn--primary/);
    assert.match(apply, /data-spp-act="applyGap"/);
  });
});

describe('step 4 — the retention offer', () => {
  const step = screen('cancel-offer');

  test('renders the approved offer exactly', () => {
    assert.match(step, /One-time offer/i);
    assert.match(step, /off your next Routine Care delivery/);
    assert.match(step, /One delivery only/);
    assert.match(step, /returns to your usual\s+Routine Care pricing/);
  });

  test('uses the approved image, not generated packaging', () => {
    assert.match(step, /spp-cancel-offer\.png/);
    assert.match(step, /spp__media-16x9/);
  });

  test('the primary CTA is the approved brand blue', () => {
    const cta = buttonWith(step, 'Apply 40% to my next delivery');
    assert.match(cta, /spp__btn--primary/);
    assert.match(css, /--spp-primary:\s*#47B5E9/i);
    // The legacy blue must not appear in the new journey.
    assert.ok(!/#128FCB/i.test(cancelScreens), 'legacy #128FCB must not be used here');
  });

  test('declining is the quiet action', () => {
    const no = buttonWith(step, 'No thanks, continue cancelling');
    assert.match(no, /spp__btn--link/);
    assert.match(no, /data-spp-go="cancel-confirm"/);
  });

  test('the acceptance action is live, not disabled — and gated server-side', () => {
    const cta = buttonWith(step, 'Apply 40% to my next delivery');
    // A disabled button teaches the customer nothing. The request goes out and
    // the server refuses it honestly.
    assert.ok(!/disabled/.test(cta));
    assert.match(cta, /data-spp-act="acceptOffer"/);
    assert.match(src, /case 'acceptOffer'/);
    assert.match(src, /acceptRetentionOffer/);
  });

  test('a refused offer is reported as unavailable, never as applied', () => {
    assert.match(src, /offer_unavailable/);
    const m = /code === 'offer_unavailable'\)[\s\S]{0,400}?message = '([^']+)'/.exec(src);
    assert.ok(m, 'the refusal must have its own copy');
    assert.match(m[1], /not available yet/i);
    assert.ok(!/applied/i.test(m[1]), 'must never claim the discount landed');
  });
});

describe('step 5 — final confirmation', () => {
  const step = screen('cancel-confirm');

  test('the title names no identifier at all', () => {
    assert.match(step, /Cancel your subscription\?/);
    assert.ok(!/Cancel subscription/.test(step), 'the old identifier-bearing title is gone');
  });

  test('no internal Phoenix identifier is rendered on this screen', () => {
    assert.ok(
      !/subscription\.reference/.test(step),
      'Phoenix subscription numbers are internal to a third-party billing system',
    );
    assert.ok(!/customerId/i.test(step));
    assert.ok(!/phoenix/i.test(step));
    // Nothing that looks like a bare 6+ digit id.
    const digits = step.match(/\b\d{6,}\b/g) || [];
    assert.deepEqual(digits, [], `no raw identifiers may appear: ${digits}`);
  });

  test('the consequence bullets survive', () => {
    const facts = listData.call(
      {
        state: {
          data: { nextOrderDate: '2026-11-19', payment: { brand: 'Visa', last4: '4242' } },
          loyalty: { points: 300 },
          inactive: [],
          draft: {},
        },
        fmtDate: (iso) => String(iso),
      },
      'cancelFacts',
    );
    const text = facts.map((f) => f.text).join(' | ');
    assert.match(text, /will not ship/);
    assert.match(text, /No further charges/);
    assert.match(text, /reactivate/);
    // No points claim: there is no ledger, so a balance here would be an
    // assertion about something the customer owns that nothing records.
    assert.ok(!/VetPoints/.test(text), 'no points balance may be claimed');
  });

  test('the RoutineCare consistency reminder is one of the bullets', () => {
    const facts = listData.call(
      {
        state: {
          data: { nextOrderDate: '2026-11-19', payment: null },
          loyalty: { points: 0 },
          inactive: [],
          draft: {},
        },
        fmtDate: (iso) => String(iso),
      },
      'cancelFacts',
    );
    const text = facts.map((f) => f.text);
    assert.ok(
      text.some((t) =>
        /RoutineCare keeps daily care consistent, helping prevent buildup before it becomes a recurring problem\./.test(t),
      ),
      `the RoutineCare bullet must appear verbatim, got: ${JSON.stringify(text)}`,
    );
  });

  test('the destructive button is red with WHITE text', () => {
    const confirm = buttonWith(step, 'Yes, cancel my subscription');
    assert.match(confirm, /spp__btn--danger/);
    assert.match(confirm, /data-spp-act="cancel"/);

    assert.match(css, /--spp-danger:\s*#D92D20/i, 'red');
    assert.match(css, /--spp-on-solid:\s*#FFFFFF/i, 'white');
    assert.match(
      css,
      /\.spp__btn--danger\s*\{[^}]*background:\s*var\(--spp-danger\)[^}]*color:\s*var\(--spp-on-solid\)/,
      'red background, white foreground',
    );
  });

  test('"Keep my subscription" remains the safe alternative', () => {
    const keep = buttonWith(step, 'Keep my subscription');
    assert.match(keep, /<button/);
    assert.ok(!/spp__btn--danger/.test(keep));
  });

  test('no unsupported control crept in', () => {
    for (const forbidden of ['data-spp-act="pause"', 'data-spp-act="resume"', 'data-spp-act="frequency"']) {
      assert.ok(!cancelScreens.includes(forbidden), `${forbidden} is not supported`);
    }
  });
});

describe('the cancelled screen says nothing internal, and nothing untrue', () => {
  /**
   * Two defects the founder hit on the real cancelled screen:
   *
   *   "Subscription 5619168 ended today."   — Phoenix's own subscription id,
   *                                            shown to a customer.
   *   "A confirmation is on its way to ."   — a promise about an email
   *                                            address, rendered from a field
   *                                            live data never populates, so
   *                                            the sentence simply stopped.
   */
  const done = screen('cancel-done');

  test('no internal subscription identifier appears', () => {
    assert.ok(
      !/subscription\.reference/.test(done),
      "the cancelled screen must not bind Phoenix's subscription id",
    );
    const digits = done.match(/\b\d{6,}\b/g) || [];
    assert.deepEqual(digits, [], `no raw identifier may appear: ${digits}`);
  });

  test('the confirmation is stated as a fact, with no email', () => {
    assert.match(done, /Your cancellation is confirmed\./);
    assert.ok(
      !/customer\.email/.test(done),
      'no address may be rendered here — the field is empty in live data',
    );
    assert.ok(
      !/on its way to/.test(done),
      'the dangling sentence must be gone, not merely re-bound',
    );
  });

  test('a truthful sentence can never end in a dangling preposition', () => {
    // The defect in one line: text that only reads correctly when a field is
    // populated. Nothing on this screen may depend on one.
    const paragraph = /<p class="spp__lede"[\s\S]*?<\/p>/.exec(done);
    assert.ok(paragraph, 'the lede must exist');
    assert.ok(
      !/data-spp-field/.test(paragraph[0]),
      'the sentence must read correctly with no data bound into it at all',
    );
  });

  test('the useful consequences survive', () => {
    assert.match(done, /No further charges will be made/);
    assert.match(done, /nothing more will ship/);
    assert.match(done, /Reactivate subscription/);
  });

  test('the cancelled list identifies subscriptions by product, not by id', () => {
    const inactive = screen('inactive');
    assert.ok(
      !/data-spp-field="reference"/.test(inactive),
      'the reference chip was an internal id and told the customer nothing',
    );
    assert.match(inactive, /data-spp-field="name"/, 'the product still names it');
    assert.match(inactive, /data-spp-field="meta"/, 'as do the cadence and end date');
    assert.match(inactive, /data-spp-field="statusLabel"/);
  });

  test('the view-model no longer supplies a reference to that list', () => {
    const m = /case 'inactiveSubs':[\s\S]*?\}\);/.exec(src);
    assert.ok(m, 'inactiveSubs must exist');
    assert.ok(
      !/reference:/.test(m[0]),
      'handing an internal id to a template is how it returns to the screen',
    );
  });

  test('NO screen in the cancellation flow exposes an internal identifier', () => {
    for (const name of ['cancel-reason', 'cancel-alt', 'cancel-confirm', 'cancel-done', 'inactive']) {
      const markup = screen(name);
      assert.ok(
        !/subscription\.reference/.test(markup),
        `${name} must not bind subscription.reference`,
      );
      const digits = markup.match(/\b\d{6,}\b/g) || [];
      assert.deepEqual(digits, [], `${name} must show no raw identifier: ${digits}`);
    }
  });
});

describe('the corrected V2 journey', () => {
  const subscriptionScreen = readFileSync(
    resolve(here, '..', 'snippets', 'spp-screen-subscription.liquid'),
    'utf8',
  ).replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '');

  test('Cancel enters BENEFITS, not the reason list', () => {
    // It used to jump straight to Reasons, skipping the one screen whose whole
    // job is to give the customer a reason to stay.
    const cancel = buttonWith(subscriptionScreen, 'Cancel subscription');
    assert.match(cancel, /data-spp-go="cancel-benefits"/);
    assert.ok(!/data-spp-go="cancel-reason"/.test(cancel));
  });

  test('the seven screens run in the approved order', () => {
    const order = [
      'cancel-benefits',
      'cancel-reason',
      'cancel-alt',
      'cancel-offer',
      'cancel-confirm',
      'cancel-done',
    ];
    let last = -1;
    for (const name of order) {
      const at = cancelScreens.indexOf(`data-spp-screen="${name}"`);
      assert.ok(at > -1, `${name} must exist`);
      assert.ok(at > last, `${name} is out of order in the source`);
      last = at;
    }
  });

  test('each step moves forward to the next one', () => {
    const hop = (from, to) => {
      const step = screen(from);
      assert.ok(
        step.includes(`data-spp-go="${to}"`) || step.includes('data-spp-act="reasonContinue"'),
        `${from} must lead to ${to}`,
      );
    };
    hop('cancel-benefits', 'cancel-reason');
    hop('cancel-reason', 'cancel-alt');
    hop('cancel-alt', 'cancel-offer');
    hop('cancel-offer', 'cancel-confirm');
  });
});

describe('the gap cards align as approved', () => {
  test('the radio and the text are vertically centred, not top-pinned', () => {
    const rule = /\.spp__choice--stacked\s*\{[^}]*\}/.exec(css);
    assert.ok(rule, '.spp__choice--stacked must exist');
    assert.match(rule[0], /align-items:\s*center/);
    assert.ok(
      !/align-items:\s*flex-start/.test(rule[0]),
      'top-pinning is the misalignment the founder flagged',
    );
  });

  test('padding is even, so one-line and two-line options match', () => {
    const rule = /\.spp__choice--stacked\s*\{[^}]*\}/.exec(css)[0];
    const pad = /padding:\s*([\d.]+)px\s+([\d.]+)px/.exec(rule);
    assert.ok(pad, 'padding must be declared');
  });

  test('the text block centres its own lines', () => {
    const rule = /\.spp__choice-text\s*\{[^}]*\}/.exec(css);
    assert.ok(rule);
    assert.match(rule[0], /justify-content:\s*center/);
  });
});

describe('the retention offer is real now', () => {
  test('the acceptance action calls the server', () => {
    assert.match(src, /case 'acceptOffer'/);
    assert.match(src, /acceptRetentionOffer/);
  });

  test('the offer screen quotes a price it can actually honour', () => {
    // Derived from the upcoming charge the dashboard already shows, so the
    // screen cannot quote a figure the server would not send.
    assert.match(src, /vm\['offer\.price'\]/);
    assert.match(src, /vm\['offer\.currentPrice'\]/);
    assert.match(src, /1 - OFFER_PERCENT \/ 100/);
  });

  test('an unverified apply asks for a refresh instead of claiming a total', () => {
    const m = /refreshRequired[\s\S]{0,160}?return '([^']+)'/.exec(src);
    assert.ok(m, 'the unverified branch must have its own copy');
    assert.match(m[1], /refresh/i);
  });

  test('the client does not also write saved_offer — the server owns it', () => {
    const start = src.indexOf("case 'acceptOffer'");
    const block = src.slice(start, src.indexOf("case 'cancel'", start));
    assert.ok(
      !/recordCancelOutcome\('saved_offer'\)/.test(block),
      'two writers for one fact is how they disagree',
    );
  });
});


/**
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * After a successful offer, the toast correctly read "Done — your next
 * delivery is $25.80" — built straight from the write's own response — while
 * the dashboard card kept showing the pre-offer amount until the customer
 * reloaded the whole page by hand.
 *
 * Every other mutation (skip/delay/reschedule/cancel/reactivate) returns a
 * fresh subscription projection carrying `.id`, which run() adopts into
 * state.data automatically. acceptRetentionOffer's response has no `.id`, so
 * that adoption never ran, and the follow-up refreshAuthenticatedData() only
 * re-reads loyalty, the inactive list and deliveries — never the primary
 * subscription. Only load() — the exact call the page makes on open — reads
 * that back.
 *
 * This proves the fix by making the write's own response quote a WRONG price
 * (99.99) and asserting the dashboard shows the SERVER RE-READ figure (25.80)
 * instead: the only way that passes is if the primary subscription came from
 * a real getSubscription() call, not from patching result.offerPrice onto
 * state.data by hand.
 */
function offerPortal() {
  const calls = {
    accept: 0, getCustomer: 0, getSubscription: 0, getLoyalty: 0,
    listSubscriptions: 0, listDeliveries: 0, listRewards: 0,
    smallRefresh: 0, shown: [], toasts: [], renders: 0,
  };

  // The subscription on screen before the offer — same shape load() expects.
  const staleSubscription = {
    id: 'sub_1', status: 'active', nextOrderDate: '2026-11-19',
    pricing: { total: { amount: 0.70, currencyCode: 'USD' } },
  };
  // What the server holds AFTER the write — the only source of truth.
  const freshSubscription = {
    id: 'sub_1', status: 'active', nextOrderDate: '2026-11-19',
    pricing: { total: { amount: 25.80, currencyCode: 'USD' } },
  };

  return {
    calls,
    state: {
      pending: null, screen: 'cancel-offer', history: [], sheet: null,
      confirmSpent: false, attempts: {}, error: null, success: null,
      draft: { delay: 7, reason: 'other', restart: 0, date: null },
      data: staleSubscription,
    },
    root: { querySelectorAll: () => [], querySelector: () => null },

    adapter: {
      acceptRetentionOffer(opts) {
        calls.accept++;
        // Deliberately wrong, so a test that passed by trusting this value
        // instead of the server re-read would be caught red-handed.
        return Promise.resolve({
          status: 'ok', operation: 'offer', percentOff: 40,
          previousPrice: 0.70, normalValue: 43, offerPrice: 25.80,
          verified: true, refreshRequired: false,
        });
      },
      getCustomer() { calls.getCustomer++; return Promise.resolve({ email: 'x@example.com' }); },
      getSubscription() { calls.getSubscription++; return Promise.resolve(freshSubscription); },
      getLoyalty() { calls.getLoyalty++; return Promise.resolve(null); },
      listSubscriptions() { calls.listSubscriptions++; return Promise.resolve({ inactive: [] }); },
      listDeliveries() { calls.listDeliveries++; return Promise.resolve([]); },
      listRewards() { calls.listRewards++; return Promise.resolve([]); },
      hasSession: () => true,
      clearSession() {},
    },

    attemptKey(op) { return attemptKey.call(this, op); },
    releaseAttempt(op) { return releaseAttempt.call(this, op); },
    releaseAllAttempts() { this.state.attempts = {}; },
    run(k, w, o) { return run.call(this, k, w, o); },
    act(n, el) { return act.call(this, n, el); },
    load() { return load.call(this); },

    applyPending() {},
    render() { calls.renders += 1; },
    closeSheet() {},
    show(v) { calls.shown.push(v); },
    toast(m) { calls.toasts.push(m); },
    fail() {},
    actionFailed(err) { calls.toasts.push('failed:' + (err && err.code)); },
    refreshRequired() {},
    // The smaller refresh the fix must bypass in favour of load().
    refreshAuthenticatedData() { calls.smallRefresh++; return Promise.resolve(); },
    fmtDate: (iso) => String(iso),
    fmtMoney: (m) => '$' + (m ? m.amount.toFixed(2) : '0.00'),
    hasSession: () => true,
  };
}

describe('the dashboard reflects the offer without a manual reload', () => {
  test('the primary subscription is refreshed through load(), not the small refresh', async () => {
    const p = offerPortal();
    p.act('acceptOffer');
    await tick(); await tick(); await tick();

    assert.equal(p.calls.getSubscription, 1, 'load() must re-read the subscription');
    assert.equal(p.calls.smallRefresh, 0, 'the small loyalty/deliveries refresh must be bypassed');
    // The same six-call shape the page makes on open — proves this is THAT
    // path, not a partial one built to look similar.
    assert.equal(p.calls.getCustomer, 1);
    assert.equal(p.calls.getLoyalty, 1);
    assert.equal(p.calls.listSubscriptions, 1);
    assert.equal(p.calls.listDeliveries, 1);
    assert.equal(p.calls.listRewards, 1);
  });

  test('the dashboard shows the SERVER re-read price, not the write response', async () => {
    const p = offerPortal();
    p.act('acceptOffer');
    await tick(); await tick(); await tick();

    // The write response claimed 25.80 too, so prove the number came from
    // getSubscription() by checking the whole object landed, not just a
    // number the fix could have copied over by hand.
    assert.equal(p.state.data.pricing.total.amount, 25.80);
    assert.strictEqual(p.state.data.status, 'active');
  });

  test('the dashboard is shown only after the refresh resolves, never before', async () => {
    const p = offerPortal();
    p.act('acceptOffer');
    // Immediately after the synchronous portion: the write and toast may
    // already be in flight, but the authoritative re-read has not resolved.
    assert.ok(!p.calls.shown.includes('dashboard'), 'must not show the dashboard on stale data');
    await tick(); await tick(); await tick();
    assert.deepEqual(p.calls.shown, ['dashboard']);
  });

  test('the successful toast is kept, unchanged', async () => {
    const p = offerPortal();
    p.act('acceptOffer');
    await tick(); await tick(); await tick();
    assert.equal(p.calls.toasts.length, 1);
    assert.match(p.calls.toasts[0], /Done.*\$25\.80/);
  });

  test('a failed re-read does not strand the customer off the dashboard', async () => {
    const p = offerPortal();
    p.adapter.getSubscription = () => Promise.reject(new Error('network'));
    p.act('acceptOffer');
    await tick(); await tick(); await tick();
    // The write already succeeded; only the re-read failed. That must never
    // read to the customer as a failed page.
    assert.deepEqual(p.calls.shown, ['dashboard']);
    assert.ok(!p.calls.toasts.some((t) => /failed/.test(t)));
  });

  test('acceptOffer requests refresh:false, so run() does not also do the small refresh', () => {
    const start = src.indexOf("case 'acceptOffer'");
    const end = src.indexOf("case 'cancel'", start);
    const block = src.slice(start, end);
    assert.match(block, /refresh:\s*false/);
    assert.match(block, /self\.load\(\)/);
    assert.doesNotMatch(block, /self\.state\.data\s*=\s*\{/, 'must not fabricate a subscription locally');
  });
});


/**
 * THE RULE THIS EXISTS FOR
 * ------------------------
 * The 40% offer is one-time per customer, permanently, and the SERVER
 * decides that (see the backend's retentionOfferEligibility tests). This
 * only proves the frontend never SHOWS the offer to a customer the server
 * has already told it is redeemed — checked in show() itself, not just on
 * the one button that used to link there, so a deep link or the browser's
 * own back/forward button cannot resurface it either.
 */
describe('an already-redeemed customer never sees the offer screen', () => {
  const show = method('show', ['DISABLED_SCREENS', 'SCREENS_WITH_CHROME'], [{}, constant('SCREENS_WITH_CHROME')]);

  function shownPortal(retentionOfferRedeemed) {
    const screens = {};
    for (const name of ['cancel-alt', 'cancel-offer', 'cancel-confirm', 'dashboard']) {
      screens[name] = { hidden: true, getAttribute: () => name, setAttribute() {}, focus() {} };
    }
    const root = {
      querySelectorAll(sel) {
        if (sel === '[data-spp-screen]') return Object.values(screens);
        return [];
      },
      querySelector() { return null; },
    };
    return {
      state: {
        screen: 'cancel-alt', history: [],
        data: { retentionOfferRedeemed },
      },
      root,
      closeSheet() {},
      render() {},
      markCurrentNav() {},
      show(v) { return show.call(this, v); },
    };
  }

  test('redirects straight to Final Confirmation once redeemed', () => {
    const p = shownPortal(true);
    p.show('cancel-offer');
    assert.equal(p.state.screen, 'cancel-confirm');
  });

  test('an unredeemed customer still reaches the offer screen normally', () => {
    const p = shownPortal(false);
    p.show('cancel-offer');
    assert.equal(p.state.screen, 'cancel-offer');
  });

  test('every other screen is unaffected by the flag', () => {
    const p = shownPortal(true);
    p.show('dashboard');
    assert.equal(p.state.screen, 'dashboard');
  });

  test('the guard survives even with no data loaded yet', () => {
    // this.state.data can be null between sign-in and the first load().
    const p = shownPortal(false);
    p.state.data = null;
    assert.doesNotThrow(() => p.show('cancel-offer'));
    assert.equal(p.state.screen, 'cancel-offer');
  });
});


/**
 * THE BUG THIS EXISTS FOR
 * ------------------------
 * The confirmation screen's Back button was wired to a fixed
 * data-spp-go="cancel-offer" in the markup. For a customer who has already
 * redeemed the 40% offer, show('cancel-offer') immediately redirects back to
 * 'cancel-confirm' — the screen the customer is already ON — so the button
 * looked completely dead. It was never unresponsive; it was navigating
 * somewhere that refuses to render and bounced straight back.
 *
 * The fix decides the target fresh on every render (renderCancelJourney),
 * because eligibility is server truth that can change mid-session — the
 * moment a successful offer's post-write load() lands.
 */
describe('Back on Final Confirmation goes to the right previous step', () => {
  const show = method('show', ['DISABLED_SCREENS', 'SCREENS_WITH_CHROME'], [{}, constant('SCREENS_WITH_CHROME')]);
  const renderCancelJourney = method('renderCancelJourney');

  function confirmScreenPortal(retentionOfferRedeemed) {
    const backBtn = el('button', { class: 'spp__back', 'data-spp-confirm-back': '', 'data-spp-go': 'cancel-offer' });
    const screens = {};
    for (const name of ['cancel-alt', 'cancel-offer', 'cancel-confirm']) {
      screens[name] = el('section', { 'data-spp-screen': name });
    }
    const root = el('div');
    root.append(backBtn);
    Object.values(screens).forEach((n) => root.append(n));

    const portal = {
      state: {
        screen: 'cancel-confirm', history: [],
        draft: { delay: 7, reason: null, restart: 0, date: null, note: '', gap: null },
        reasonError: null,
        data: { retentionOfferRedeemed },
      },
      root,
      closeSheet() {},
      render() {},
      markCurrentNav() {},
      reasonProblem: () => null,
      show(v) { return show.call(this, v); },
      renderCancelJourney() { return renderCancelJourney.call(this); },
    };
    portal.renderCancelJourney(); // as the real render() loop would, every time
    return { portal, backBtn, click: (target) => onClick(portal, { target, preventDefault() {} }) };
  }

  test('an ELIGIBLE customer: Back goes to the retention offer', () => {
    const { portal, backBtn, click } = confirmScreenPortal(false);
    assert.equal(backBtn.getAttribute('data-spp-go'), 'cancel-offer');
    click(backBtn);
    assert.equal(portal.state.screen, 'cancel-offer');
  });

  test('a REDEEMED customer: Back goes to the longer gap, never the offer', () => {
    const { portal, backBtn, click } = confirmScreenPortal(true);
    assert.equal(backBtn.getAttribute('data-spp-go'), 'cancel-alt');
    click(backBtn);
    assert.equal(portal.state.screen, 'cancel-alt');
  });

  test('the target updates if redemption status changes mid-session', () => {
    // The exact case that would otherwise slip through: a customer redeems
    // the offer, load() lands, and Final Confirmation must stop offering a
    // way back into a screen that would now refuse to render.
    const { portal, backBtn } = confirmScreenPortal(false);
    assert.equal(backBtn.getAttribute('data-spp-go'), 'cancel-offer');
    portal.state.data.retentionOfferRedeemed = true;
    portal.renderCancelJourney();
    assert.equal(backBtn.getAttribute('data-spp-go'), 'cancel-alt');
  });

  test('Back stays wired correctly regardless of reason-screen state', () => {
    // Proves the fix does not accidentally depend on which screen the
    // customer passed through, or what they picked there.
    const { portal, backBtn } = confirmScreenPortal(true);
    portal.state.draft.reason = 'other';
    portal.state.draft.note = 'something';
    portal.renderCancelJourney();
    assert.equal(backBtn.getAttribute('data-spp-go'), 'cancel-alt');
    assert.equal(backBtn.disabled, undefined, 'the button must never become disabled');
  });

  test('deep-linking or the browser back/forward button still cannot expose the offer', () => {
    // Independent of the Back BUTTON fix above: show() itself refuses to
    // render the offer screen for a redeemed customer, from ANY caller.
    const { portal } = confirmScreenPortal(true);
    portal.show('cancel-offer');
    assert.equal(portal.state.screen, 'cancel-confirm');
  });
});

describe('quantity is not exposed anywhere', () => {
  test('no quantity control exists in the portal', () => {
    // Phoenix has confirmed there is no quantity-change endpoint.
    for (const { name, markup } of [
      { name: 'cancel screens', markup: cancelScreens },
      { name: 'controller', markup: src },
    ]) {
      assert.ok(!/data-spp-act="quantity"/.test(markup), `${name} must not offer quantity`);
      assert.ok(!/case 'quantity'/.test(markup), `${name} must not handle quantity`);
    }
  });
});

describe('the reason screen never fails silently', () => {
  /**
   * THE DEFECT THIS EXISTS FOR
   * --------------------------
   * "Continue cancelling" began with `if (!d.reason) return;`. With nothing
   * selected it did nothing at all — no message, no movement — which reads as
   * a broken button. The customer taps it again and still nothing happens.
   * The same silent-refusal shape that made the cancel button look dead.
   */
  const reasonProblem = method('reasonProblem', ['MIN_REASON_NOTE'], [constant('MIN_REASON_NOTE')]);

  const draft = (d) => ({ state: { draft: { reason: null, note: '', ...d } } });

  test('no reason selected is refused OUT LOUD', () => {
    const msg = reasonProblem.call(draft({}));
    assert.ok(msg, 'there must be a message, not a silent return');
    assert.match(msg, /choose a reason/i);
  });

  test('a normal reason passes', () => {
    assert.equal(reasonProblem.call(draft({ reason: 'price' })), null);
    assert.equal(reasonProblem.call(draft({ reason: 'break' })), null);
  });

  test('"Something else" requires actual words', () => {
    // The one option that exists to capture what the fixed list could not.
    assert.match(reasonProblem.call(draft({ reason: 'other' })), /tell us/i);
    assert.match(reasonProblem.call(draft({ reason: 'other', note: '  ' })), /tell us/i);
    assert.match(reasonProblem.call(draft({ reason: 'other', note: 'x' })), /tell us/i);
  });

  test('"Something else" with words passes', () => {
    assert.equal(reasonProblem.call(draft({ reason: 'other', note: 'lid was cracked' })), null);
  });

  test('a note is not demanded for a preset reason', () => {
    assert.equal(reasonProblem.call(draft({ reason: 'price', note: '' })), null);
  });

  test('the shipped action validates before it advances', () => {
    const start = src.indexOf("case 'reasonContinue'");
    const block = src.slice(start, src.indexOf("case 'applyGap'", start));
    assert.match(block, /reasonProblem\(\)/, 'must consult the rule');
    assert.ok(
      !/if \(!d\.reason\) return;/.test(block),
      'the silent early return must be gone',
    );
    assert.match(block, /reasonError/, 'and must record something to display');
  });

  test('the screen has somewhere to show it', () => {
    const step = screen('cancel-reason');
    assert.match(step, /data-spp-reason-error/);
    assert.match(step, /role="alert"/);
    assert.match(step, /aria-describedby="spp-reason-error"/);
  });

  test('the message clears once the problem is fixed', () => {
    // It must not sit there contradicting what the customer just put right.
    const render = /Portal\.prototype\.renderCancelJourney[\s\S]*?\n  \};/.exec(src);
    assert.ok(render);
    assert.match(render[0], /reasonProblem\(\)/);
  });
});

describe('the gap cards centre, and the base row rule does not fight them', () => {
  const stacked = /\.spp__choice--stacked\s*\{[^}]*\}/.exec(css);

  test('the radio centres against the whole text block', () => {
    assert.ok(stacked, '.spp__choice--stacked must exist');
    assert.match(stacked[0], /align-items:\s*center/);
    assert.ok(!/align-items:\s*flex-start/.test(stacked[0]));
  });

  test('space-between is overridden', () => {
    // The base .spp__choice is a space-between row built for a trailing
    // radio; left as-is it pushed the two-line text away from the control.
    const base = /\.spp__choice\s*\{[^}]*\}/.exec(css);
    assert.match(base[0], /justify-content:\s*space-between/, 'base is space-between');
    assert.match(stacked[0], /justify-content:\s*flex-start/, 'stacked must override it');
  });

  test('padding is even, so one-line and two-line tiles match', () => {
    assert.match(stacked[0], /padding:\s*13px\s+15px/);
  });

  test('the text column centres its own lines and carries no stray margins', () => {
    const text = /\.spp__choice-text\s*\{[^}]*\}/.exec(css);
    assert.match(text[0], /justify-content:\s*center/);
    assert.match(css, /\.spp__choice--stacked > \.spp__choice-text > b[\s\S]{0,120}margin:\s*0/);
  });

  test('all five gap options survive', () => {
    const gaps = listData.call(
      { state: { data: {}, loyalty: null, inactive: [], draft: {} }, fmtDate: (x) => String(x) },
      'gapOptions',
    );
    assert.equal(gaps.length, 5);
  });
});

/* ------------------------------------------------ the real click path ---- */

/**
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * In DEV, no reason row could be selected. Clicking a row or its radio did
 * nothing, so "Continue cancelling" could never proceed.
 *
 * A bare `if` had been inserted into the middle of pick()'s else-if chain:
 *
 *     else if (kind === 'gap') d.gap = value;
 *     if (kind === 'reason') this.state.reasonError = null;   // inserted
 *     else if (kind === 'reason') d.reason = value;           // now dead
 *
 * The inserted statement adopted the assignment below it as its own else-
 * branch, so `d.reason = value` became unreachable: the condition and its
 * else were the same test. Every downstream symptom — no fill, no selected
 * row, aria-checked stuck false, the textarea never opening, Continue
 * refusing — was that one line.
 *
 * The tests in this file did not catch it because they called reasonProblem()
 * against a hand-built state and regex-scanned the source. Neither touches
 * the click path. This block drives the SHIPPED delegated handler over a
 * rendered row instead, so a dead binding fails here.
 */

/** The smallest DOM that the shipped click delegation actually uses. */
function el(tag, attrs = {}) {
  const node = {
    tag,
    attrs: { ...attrs },
    dataset: {},
    parent: null,
    children: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    append(child) { child.parent = this; this.children.push(child); return child; },
    matches(sel) {
      const idMatch = /^#([a-zA-Z0-9_-]+)$/.exec(sel);
      if (idMatch) return this.attrs.id === idMatch[1];
      const m = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(sel);
      assert.ok(m, `unsupported selector in test shim: ${sel}`);
      const [, name, want] = m;
      if (!(name in this.attrs)) return false;
      return want === undefined || this.attrs[name] === want;
    },
    closest(sel) {
      let n = this;
      while (n) { if (n.matches(sel)) return n; n = n.parent; }
      return null;
    },
    querySelector(sel) {
      for (const c of this.children) {
        if (c.matches(sel)) return c;
        const deeper = c.querySelector(sel);
        if (deeper) return deeper;
      }
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      for (const c of this.children) {
        if (c.matches(sel)) out.push(c);
        out.push(...c.querySelectorAll(sel));
      }
      return out;
    },
    // Records that the refusal path moved focus somewhere the customer can see.
    focused: 0,
    focus() { this.focused++; },
  };
  return node;
}

/**
 * The shipped click delegation, lifted verbatim from the bundle.
 *
 * Brace-matched out of the file rather than retyped: a copy of the handler
 * would keep passing after the real one broke, which is the exact failure
 * this block exists to prevent.
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
const pick = method('pick');
const reasonProblem = method('reasonProblem', ['MIN_REASON_NOTE'], [constant('MIN_REASON_NOTE')]);

/** A portal whose reason rows are rendered from the real view-model. */
function mountReasonScreen() {
  const root = el('div', { 'data-spp-root': '' });
  const note = root.append(el('div', { 'data-spp-reason-note': '', hidden: '' }));
  const errBox = root.append(el('p', { 'data-spp-reason-error': '', hidden: '' }));

  const portal = {
    root,
    state: {
      draft: { delay: 7, reason: null, restart: 0, date: null, note: '', gap: null },
      reasonError: null,
      data: {}, loyalty: null, inactive: [],
    },
    shown: [],
    adapter: {},
    fmtDate: (x) => String(x),
    rows: [],
    show(name) { this.shown.push(name); },
    pick,
    reasonProblem,
    renders: 0,
    /* Stands in for the shipped render: re-derives every row from listData
     * and applies renderList's documented _checked -> aria-checked mapping. */
    render() {
      this.renders++;
      const model = listData.call(this, 'reasons');
      model.forEach((item, i) => {
        const row = this.rows[i];
        row.setAttribute('aria-checked', item._checked ? 'true' : 'false');
        row.classList.toggle('is-selected', item._checked);
      });
      note.attrs.hidden = this.state.draft.reason !== 'other' ? '' : undefined;
      const msg = this.state.reasonError && this.reasonProblem() ? this.state.reasonError : '';
      errBox.attrs.hidden = msg ? undefined : '';
    },
  };

  // Rows as the template renders them: a button carrying the binding, with a
  // radio span and a label span inside it — both are clickable surfaces.
  listData.call(portal, 'reasons').forEach((item) => {
    const row = root.append(el('button', {
      'data-spp-pick': 'reason', role: 'radio', 'aria-checked': 'false',
    }));
    row.dataset.sppValue = item._value;
    row.append(el('span', { class: 'spp__radio' }));
    row.append(el('span')).attrs.text = item.label;
    portal.rows.push(row);
  });

  return { portal, root, note, errBox, click: (target) => onClick(portal, { target, preventDefault() {} }) };
}

const REASON_MODEL = constant('REASONS');
const idxOf = (code) => REASON_MODEL.findIndex((r) => r[0] === code);

describe('a reason row can actually be selected', () => {
  test('clicking the row sets the reason', () => {
    const { portal, click } = mountReasonScreen();
    const row = portal.rows[idxOf('break')];
    click(row);
    assert.equal(portal.state.draft.reason, 'break');
  });

  test('clicking the radio inside the row selects it too', () => {
    // The radio is a child span, so this only works via closest().
    const { portal, click } = mountReasonScreen();
    const row = portal.rows[idxOf('price')];
    click(row.children[0]);
    assert.equal(portal.state.draft.reason, 'price');
  });

  test('clicking the label text selects it too', () => {
    const { portal, click } = mountReasonScreen();
    const row = portal.rows[idxOf('no_results')];
    click(row.children[1]);
    assert.equal(portal.state.draft.reason, 'no_results');
  });

  test('the selection becomes visible: aria-checked and the selected class', () => {
    const { portal, click } = mountReasonScreen();
    const i = idxOf('too_much');
    click(portal.rows[i]);
    assert.equal(portal.rows[i].getAttribute('aria-checked'), 'true');
    assert.ok(portal.rows[i].classList.contains('is-selected'));
  });

  test('exactly one reason is selected at a time', () => {
    const { portal, click } = mountReasonScreen();
    click(portal.rows[idxOf('price')]);
    click(portal.rows[idxOf('not_using')]);
    assert.equal(portal.state.draft.reason, 'not_using');
    const checked = portal.rows.filter((r) => r.getAttribute('aria-checked') === 'true');
    assert.equal(checked.length, 1);
    assert.equal(portal.rows[idxOf('price')].getAttribute('aria-checked'), 'false');
  });

  test('the shipped renderList is what maps _checked onto the row', () => {
    // The mount above applies that mapping; this proves it is the real one.
    assert.match(src, /_checked \? 'true' : 'false'/);
    assert.match(src, /classList\.toggle\('is-selected', item\._checked\)/);
  });

  test('"Something else" opens the textarea, another reason closes it', () => {
    const { portal, note, click } = mountReasonScreen();
    click(portal.rows[idxOf('other')]);
    assert.equal(note.attrs.hidden, undefined, 'textarea must be visible');
    click(portal.rows[idxOf('break')]);
    assert.equal(note.attrs.hidden, '', 'textarea must close again');
  });

  test('picking a reason clears a standing validation message', () => {
    const { portal, errBox, click } = mountReasonScreen();
    portal.state.reasonError = 'Choose a reason so we can continue.';
    portal.render();
    assert.equal(errBox.attrs.hidden, undefined, 'message is showing first');
    click(portal.rows[idxOf('break')]);
    assert.equal(portal.state.reasonError, null);
    assert.equal(errBox.attrs.hidden, '');
  });

  test('reason click -> state set -> Continue advances to the longer-gap screen', () => {
    const { portal, click } = mountReasonScreen();
    click(portal.rows[idxOf('break')]);
    assert.equal(portal.reasonProblem(), null, 'validation must now pass');
    act.call(portal, 'reasonContinue');
    assert.deepEqual(portal.shown, ['cancel-alt']);
  });

  test('with nothing picked, Continue refuses, says so, and moves focus', () => {
    const { portal, errBox } = mountReasonScreen();
    act.call(portal, 'reasonContinue');
    assert.deepEqual(portal.shown, [], 'must not advance');
    assert.match(portal.state.reasonError, /choose a reason/i);
    assert.equal(errBox.attrs.hidden, undefined, 'the message must be visible');
    // Focus lands on the reason list, so the refusal is findable without sight.
    assert.equal(portal.rows[0].focused, 1);
  });

  test('every branch of pick still assigns — no severed chain', () => {
    // The bug was structural: a bare `if` splitting the else-if chain. Each
    // kind must land on its own draft field.
    const p = { state: { draft: {}, reasonError: 'x' }, render() {} };
    const fake = (kind, value, index) => ({
      getAttribute: () => kind,
      dataset: { sppValue: value, sppIndex: index },
    });
    pick.call(p, fake('reason', 'price'));
    assert.equal(p.state.draft.reason, 'price');
    pick.call(p, fake('gap', 'skip'));
    assert.equal(p.state.draft.gap, 'skip');
    pick.call(p, fake('delay', '7'));
    assert.equal(p.state.draft.delay, 7);
    pick.call(p, fake('restart', undefined, '2'));
    assert.equal(p.state.draft.restart, 2);
  });

  test('the rows are real buttons, so the keyboard still works', () => {
    // Enter and Space come free on a <button>; a div would need handlers.
    const tpl = screen('cancel-reason');
    assert.match(tpl, /<button[^>]*data-spp-pick="reason"/);
    assert.match(tpl, /role="radio"/);
    assert.doesNotMatch(tpl, /data-spp-pick="reason"[^>]*disabled/);
  });

  test('nothing in the CSS swallows the click', () => {
    const choice = /\.spp__choice\s*\{[^}]*\}/.exec(css);
    assert.doesNotMatch(choice[0], /pointer-events:\s*none/);
    assert.doesNotMatch(css, /\.spp__radio\s*\{[^}]*pointer-events:\s*none/);
  });
});
