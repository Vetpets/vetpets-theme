/**
 * Choosing a specific delivery date.
 *
 * The portal's subscription screen has always said "Delay or reschedule", but
 * only delay existed: the sheet offered 7/15/30 days forward and nothing could
 * move a delivery to a named day, or earlier. /portal/reschedule was built and
 * routed months before anything could reach it.
 *
 * These tests cover the control that closes that gap, and hold it to exactly
 * the same duplicate-safety bar Skip had to meet.
 *
 * Run with:  node --test test/reschedule.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '..', 'assets', 'subscription-portal.js'), 'utf8');
const sheet = readFileSync(resolve(here, '..', 'snippets', 'spp-sheets.liquid'), 'utf8');

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

/** The date helpers the controller closes over. */
const NS = {
  dates: {
    parseISO(iso) {
      const p = String(iso).split('-');
      return new Date(+p[0], +p[1] - 1, +p[2]);
    },
    toISO(date) {
      const m = String(date.getMonth() + 1);
      const d = String(date.getDate());
      return `${date.getFullYear()}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    },
    addDays(iso, n) {
      const dt = NS.dates.parseISO(iso);
      dt.setDate(dt.getDate() + n);
      return NS.dates.toISO(dt);
    },
  },
};

const MAX_RESCHEDULE_DAYS = constant('MAX_RESCHEDULE_DAYS');
const CONFIRMED_ACTIONS = constant('CONFIRMED_ACTIONS');
const INDETERMINATE = constant('INDETERMINATE');
const AUTH_FAILURE_CODES = constant('AUTH_FAILURE_CODES');

const rescheduleBounds = method('rescheduleBounds', ['NS', 'MAX_RESCHEDULE_DAYS'], [NS, MAX_RESCHEDULE_DAYS]);
const isCustomDate = method('isCustomDate');
const delayTargetIso = method('delayTargetIso', ['NS'], [NS]);
const rescheduleError = method('rescheduleError');
const attemptKey = method('attemptKey');
const releaseAttempt = method('releaseAttempt');
const run = method('run', ['INDETERMINATE', 'AUTH_FAILURE_CODES'], [INDETERMINATE, AUTH_FAILURE_CODES]);
const act = method('act', ['CONFIRMED_ACTIONS'], [CONFIRMED_ACTIONS]);

const utcToday = () => new Date().toISOString().slice(0, 10);

function button(action) {
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

/** A portal with the real delay/reschedule logic wired in. */
function portal(draft = {}, opts = {}) {
  const calls = { delay: [], reschedule: [], shown: [], toasts: [], renders: 0 };
  const btn = button('delay');

  return {
    calls,
    btn,
    cfg: { mode: 'live', locale: 'en' },
    state: {
      pending: null,
      sheet: 'delay',
      confirmSpent: false,
      attempts: {},
      error: null,
      success: null,
      draft: Object.assign({ delay: 7, reason: 'price', restart: 0, date: null }, draft),
      data: { id: 'sub_1', nextOrderDate: '2026-10-24', intervalDays: 30 },
    },
    root: { querySelectorAll: () => [btn], querySelector: () => null },

    adapter: {
      delayNextDelivery(id, days, o) {
        calls.delay.push({ id, days, opts: o });
        return opts.reject ? Promise.reject(opts.reject) : Promise.resolve({ id: 'sub_1', nextOrderDate: '2026-10-31' });
      },
      rescheduleNextDelivery(id, date, o) {
        calls.reschedule.push({ id, date, opts: o });
        return opts.reject ? Promise.reject(opts.reject) : Promise.resolve({ id: 'sub_1', nextOrderDate: date });
      },
      hasSession: () => true,
      clearSession() {},
    },

    isCustomDate() { return isCustomDate.call(this); },
    delayTargetIso() { return delayTargetIso.call(this); },
    rescheduleError() { return rescheduleError.call(this); },
    rescheduleBounds() { return rescheduleBounds.call(this); },
    attemptKey(op) { return attemptKey.call(this, op); },
    releaseAttempt(op) { return releaseAttempt.call(this, op); },
    releaseAllAttempts() { this.state.attempts = {}; },
    run(k, w, o) { return run.call(this, k, w, o); },
    act(n, el) { return act.call(this, n, el); },

    applyPending(on) { btn.disabled = !!on; },
    render() { calls.renders += 1; },
    closeSheet() {},
    show(v) { calls.shown.push(v); },
    toast(m) { calls.toasts.push(m); },
    fail() {},
    actionFailed(err) { calls.toasts.push('failed:' + (err && err.code)); },
    refreshRequired() {},
    refreshAuthenticatedData: () => Promise.resolve(),
    fmtDate: (iso) => iso,
    hasSession: () => true,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/* ================================================================== */

describe('the preset delays still work', () => {
  for (const days of [7, 15, 30]) {
    test(`${days} days goes to /portal/delay, not reschedule`, async () => {
      const p = portal({ delay: days });
      p.act('delay', p.btn);
      await tick();

      assert.equal(p.calls.reschedule.length, 0, 'a preset must not use the reschedule route');
      assert.equal(p.calls.delay.length, 1);
      assert.equal(p.calls.delay[0].days, days);
      assert.equal(p.calls.delay[0].opts.expectedNextBillingDate, '2026-10-24');
      assert.ok(p.calls.delay[0].opts.idempotencyKey);
    });
  }

  test('a preset target is the current date plus the offset', () => {
    const p = portal({ delay: 7 });
    assert.equal(p.delayTargetIso(), '2026-10-31');
  });
});

describe('a chosen date reaches /portal/reschedule exactly once', () => {
  test('sends the target date, the observed pre-state and one key', async () => {
    const p = portal({ delay: 'custom', date: '2026-10-24' });
    // Move it somewhere legal and different from the current date.
    p.state.data.nextOrderDate = '2026-10-31';
    p.state.draft.date = '2026-10-24';

    p.act('delay', p.btn);
    await tick();

    assert.equal(p.calls.delay.length, 0, 'a chosen date must not use the delay route');
    assert.equal(p.calls.reschedule.length, 1);

    const sent = p.calls.reschedule[0];
    assert.equal(sent.date, '2026-10-24', 'the selected target date');
    assert.equal(sent.opts.expectedNextBillingDate, '2026-10-31', 'the observed current date');
    assert.ok(sent.opts.idempotencyKey && sent.opts.idempotencyKey.length >= 8);
  });

  test('the target is the chosen date, not an offset', () => {
    const p = portal({ delay: 'custom', date: '2027-01-15' });
    assert.equal(p.delayTargetIso(), '2027-01-15');
  });

  test('no date chosen yet means no target and no submission', async () => {
    const p = portal({ delay: 'custom', date: null });
    assert.equal(p.delayTargetIso(), null);

    p.act('delay', p.btn);
    await tick();
    assert.equal(p.calls.reschedule.length, 0);
    assert.equal(p.calls.delay.length, 0);
  });
});

describe('the picker refuses what the server would refuse', () => {
  test('the bounds mirror the backend exactly', () => {
    const p = portal({ delay: 'custom' });
    const b = p.rescheduleBounds();
    assert.equal(b.min, utcToday(), 'the backend refuses anything before today (UTC)');
    assert.equal(b.max, NS.dates.addDays(utcToday(), 365));
    assert.equal(MAX_RESCHEDULE_DAYS, 365, 'must match MAX_RESCHEDULE_DAYS on the route');
  });

  test('yesterday is refused', () => {
    const p = portal({ delay: 'custom', date: NS.dates.addDays(utcToday(), -1) });
    assert.match(p.rescheduleError(), /from today onwards/i);
  });

  test('beyond a year is refused', () => {
    const p = portal({ delay: 'custom', date: NS.dates.addDays(utcToday(), 366) });
    assert.match(p.rescheduleError(), /within the next year/i);
  });

  test('a malformed date is refused', () => {
    const p = portal({ delay: 'custom', date: '24/10/2026' });
    assert.match(p.rescheduleError(), /could not be read/i);
  });

  test('the date it already has is refused, rather than writing a no-op', () => {
    const p = portal({ delay: 'custom', date: '2026-10-24' });
    assert.match(p.rescheduleError(), /already your delivery date/i);
  });

  test('the boundaries themselves are accepted', () => {
    const min = portal({ delay: 'custom', date: utcToday() });
    assert.equal(min.rescheduleError(), null);

    const max = portal({ delay: 'custom', date: NS.dates.addDays(utcToday(), 365) });
    assert.equal(max.rescheduleError(), null);
  });

  test('an invalid date never leaves the browser, and the sheet stays usable', async () => {
    const p = portal({ delay: 'custom', date: NS.dates.addDays(utcToday(), -5) });

    p.act('delay', p.btn);
    await tick();

    assert.equal(p.calls.reschedule.length, 0, 'nothing may be sent');
    assert.equal(p.state.confirmSpent, false, 'the customer must be able to correct it');
    assert.ok(!p.calls.shown.includes('error'), 'a bad date is not a page failure');
  });

  test('a preset is never blocked by the custom-date rules', () => {
    const p = portal({ delay: 7, date: '1999-01-01' });
    assert.equal(p.rescheduleError(), null);
  });
});

describe('duplicate protection matches Skip', () => {
  test('a rapid double confirmation sends exactly one request', async () => {
    const p = portal({ delay: 'custom', date: '2026-12-01' });
    p.act('delay', p.btn);
    p.act('delay', p.btn);
    await tick();

    assert.equal(p.calls.reschedule.length, 1);
  });

  test('a delayed second confirmation is still refused', async () => {
    const p = portal({ delay: 'custom', date: '2026-12-01' });
    p.act('delay', p.btn);
    await tick();
    assert.equal(p.calls.reschedule.length, 1);

    p.act('delay', p.btn);
    await tick();
    assert.equal(p.calls.reschedule.length, 1, 'the sheet is spent until reopened');
  });

  test('the key is stable across renders within one attempt', () => {
    const p = portal({ delay: 'custom', date: '2026-12-01' });
    assert.equal(p.attemptKey('reschedule'), p.attemptKey('reschedule'));
  });

  test('an unknown outcome keeps the key so a retry cannot write twice', async () => {
    const err = new Error('timeout');
    err.code = 'timeout';
    const p = portal({ delay: 'custom', date: '2026-12-01' }, { reject: err });

    const before = p.attemptKey('reschedule');
    p.act('delay', p.btn);
    await tick();

    p.state.confirmSpent = false;
    assert.equal(p.attemptKey('reschedule'), before);
  });

  test('the pre-state sent is what defeats a stale duplicate', async () => {
    // Phoenix has since moved to 31 Oct; this request was composed against 24
    // Oct. The server compares the two and refuses — it can only do that
    // because the observed date travels with the request.
    const p = portal({ delay: 'custom', date: '2026-12-01' });
    p.act('delay', p.btn);
    await tick();

    assert.equal(p.calls.reschedule[0].opts.expectedNextBillingDate, '2026-10-24');
  });
});

describe('success and failure behave as they do for Skip', () => {
  test('success closes the sheet, stays on the dashboard and confirms the new date', async () => {
    const p = portal({ delay: 'custom', date: '2026-12-01' });
    p.act('delay', p.btn);
    await tick();

    assert.deepEqual(p.calls.shown, ['dashboard']);
    assert.ok(!p.calls.shown.includes('error'));
    assert.equal(p.calls.toasts.length, 1);
    assert.match(p.calls.toasts[0], /2026-12-01/);
    assert.ok(p.calls.renders > 0, 'the dashboard re-renders with the new state');
  });

  test('failure keeps the dashboard visible', async () => {
    const err = new Error('nope');
    err.code = 'upstream_error';
    const p = portal({ delay: 'custom', date: '2026-12-01' }, { reject: err });

    p.act('delay', p.btn);
    await tick();

    assert.ok(!p.calls.shown.includes('error'), 'a failed action must not destroy the page');
    assert.equal(p.state.error, null);
    assert.match(p.calls.toasts[0], /^failed:/);
  });
});

describe('the sheet markup', () => {
  test('uses a native date input, bounded and labelled', () => {
    assert.match(sheet, /type="date"/, 'a native input brings the platform picker and a11y for free');
    assert.match(sheet, /data-spp-date\b/);
    assert.match(sheet, /<label[^>]*for="spp-date"/, 'the input must have a real label');
    assert.match(sheet, /id="spp-date"/);
    assert.match(sheet, /aria-describedby="spp-date-error"/);
    assert.match(sheet, /data-spp-date-error/);
    assert.match(sheet, /role="alert"/);
  });

  test('the date field is hidden until it is asked for', () => {
    const m = /<div data-spp-custom-date[^>]*>/.exec(sheet);
    assert.ok(m, 'the custom-date block must exist');
    assert.match(m[0], /hidden/);
  });

  test('confirmation shows current date then selected date', () => {
    assert.match(sheet, /data-spp-field="sheet\.rescheduleFrom"/);
    assert.match(sheet, /data-spp-field="sheet\.rescheduleTo"/);
    assert.ok(
      sheet.indexOf('sheet.rescheduleFrom') < sheet.indexOf('sheet.rescheduleTo'),
      'current date must read before the selected one',
    );
  });

  test('the preset options survive', () => {
    assert.match(src, /\[7, 15, 30\]/, 'the 7/15/30 presets must remain');
    assert.match(src, /Choose another date/);
  });

  test('no unsupported frequency or pause control was introduced', () => {
    for (const forbidden of ['data-spp-act="pause"', 'data-spp-act="frequency"', 'data-spp-act="resume"']) {
      assert.ok(!sheet.includes(forbidden), `${forbidden} is not a supported operation`);
    }
  });

  test('the confirm control cannot submit a form', () => {
    const buttons = sheet.match(/<button[^>]*data-spp-act[^>]*>/g) || [];
    for (const b of buttons) assert.match(b, /type="button"/);
  });
});
