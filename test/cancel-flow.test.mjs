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

function constant(name) {
  const m = new RegExp(`var ${name} = (\\{[\\s\\S]*?\\}|\\d+);`).exec(src);
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
const listData = method('listData');

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

describe('step 1 — why are you cancelling', () => {
  const step = screen('cancel-reason');

  test('"Keep my subscription" is the primary action', () => {
    const keep = buttonWith(step, 'Keep my subscription');
    assert.match(keep, /spp__btn--primary/);
    assert.match(keep, /data-spp-go="subscription"/);
  });

  test('the primary action is the blue #47B5E9 with white text', () => {
    assert.match(css, /--spp-primary:\s*#47B5E9/i);
    assert.match(css, /--spp-primary-fg:\s*#FFFFFF/i);
    assert.match(css, /\.spp\s+\.spp__btn--primary\s*\{[^}]*color:\s*var\(--spp-primary-fg\)/);
  });

  test('"Continue" is the smaller underlined action', () => {
    const cont = buttonWith(step, 'Continue');
    assert.match(cont, /spp__btn--link/, 'must be the quiet text style');
    assert.ok(!/spp__btn--primary/.test(cont), 'must not be the dominant action');
    assert.match(cont, /data-spp-go="cancel-alt"/, 'and must still go forward');
  });

  test('the link style is genuinely underlined and smaller', () => {
    const m = /\.spp__btn--link\s*\{[^}]*\}/.exec(css);
    assert.ok(m, '.spp__btn--link must exist');
    assert.match(m[0], /text-decoration:\s*underline/);
  });

  test('Continue stays a real, keyboard-reachable button', () => {
    const cont = buttonWith(step, 'Continue');
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

describe('step 2 — before you cancel', () => {
  const step = screen('cancel-alt');

  test('both retention cards survive untouched', () => {
    assert.match(step, /data-spp-act="altPrimary"/, 'the skip/delay offer');
    assert.match(step, /data-spp-sheet="delay"/, 'choose a new date');
    assert.match(step, /Push it back instead/);
  });

  test('the retention actions still reach their handlers', () => {
    assert.match(src, /case 'altPrimary'/, 'altPrimary must still be handled');
    assert.match(src, /openSheet\(el\.getAttribute\('data-spp-sheet'\)\)/);
  });

  test('"No thanks" is the smaller underlined action', () => {
    const no = buttonWith(step, 'continue to cancel');
    assert.match(no, /spp__btn--link/);
    assert.ok(!/spp__btn--quiet/.test(no), 'no longer the large outlined button');
    assert.match(no, /data-spp-go="cancel-confirm"/);
  });

  test('"No thanks" stays clickable and accessible', () => {
    const no = buttonWith(step, 'continue to cancel');
    assert.match(no, /<button/);
    assert.match(no, /type="button"/);
    assert.ok(!/aria-hidden/.test(no));
    assert.ok(!/tabindex="-1"/.test(no));
  });
});

describe('step 3 — final confirmation', () => {
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
