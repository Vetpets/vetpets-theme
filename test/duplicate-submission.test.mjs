/**
 * One confirmation must produce at most one mutation.
 *
 * THE INCIDENT THIS EXISTS FOR
 * ---------------------------
 * One customer confirmation produced TWO independently keyed skip attempts,
 * 10.7 seconds apart. Both were rejected by Phoenix for an unrelated reason,
 * so nothing was applied — but nothing in the client would have stopped them
 * both applying, and the delivery would have moved two cycles instead of one.
 *
 * The defence is layered, and each layer is tested here:
 *
 *   1. act()   refuses a second confirmed action until the sheet is reopened,
 *              so it holds however act() was reached — click, keyboard, form
 *              submit, or a listener nobody meant to attach.
 *   2. run()   refuses re-entry while a request is in flight, and disables the
 *              controls synchronously before any await.
 *   3. the key one logical attempt carries ONE idempotency key, so even when a
 *              request does go out twice the server can see they are the same
 *              intention.
 *
 * Run with:  node --test test/duplicate-submission.test.mjs
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

/** Values the extracted methods close over in the real file. */
const CONFIRMED_ACTIONS = (() => {
  const m = /var CONFIRMED_ACTIONS = (\{[\s\S]*?\});/.exec(src);
  assert.ok(m, 'CONFIRMED_ACTIONS must exist');
  return new Function(`return ${m[1]}`)();
})();

const AUTH_FAILURE_CODES = (() => {
  const m = /var AUTH_FAILURE_CODES = (\{[\s\S]*?\});/.exec(src);
  assert.ok(m, 'AUTH_FAILURE_CODES must exist');
  return new Function(`return ${m[1]}`)();
})();

const INDETERMINATE = (() => {
  const m = /var INDETERMINATE = (\{[\s\S]*?\});/.exec(src);
  assert.ok(m, 'INDETERMINATE must exist');
  return new Function(`return ${m[1]}`)();
})();

const attemptKey = method('attemptKey');
const releaseAttempt = method('releaseAttempt');
const run = method(
  'run',
  ['INDETERMINATE', 'AUTH_FAILURE_CODES'],
  [INDETERMINATE, AUTH_FAILURE_CODES],
);
const act = method('act', ['CONFIRMED_ACTIONS'], [CONFIRMED_ACTIONS]);
const openSheet = method('openSheet');

/* ------------------------------------------------------------------ */

/** A button that records whether it was disabled, as the real one would be. */
function button(action) {
  const attrs = { 'data-spp-act': action };
  return {
    tagName: 'BUTTON',
    disabled: false,
    classList: { toggle() {}, add() {}, remove() {} },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
    removeAttribute: (k) => {
      delete attrs[k];
    },
    querySelector: () => null,
    closest(sel) {
      return sel === '[data-spp-act]' ? this : null;
    },
  };
}

/**
 * A portal with the real act/run/attemptKey wired in and everything else stubbed.
 * `calls.posts` counts requests that actually reached the adapter.
 */
function portal(opts = {}) {
  const calls = { posts: [], shown: [], toasts: [] };
  const confirmBtn = button('skip');

  const p = {
    calls,
    confirmBtn,
    cfg: { mode: 'live' },
    state: {
      pending: null,
      sheet: 'skip',
      sheetSpent: false,
      attempts: {},
      draft: {},
      error: null,
      success: null,
      data: { id: 'sub_1', nextOrderDate: '2026-09-24' },
    },
    root: { querySelectorAll: () => [confirmBtn], querySelector: () => null },

    adapter: {
      skipNextDelivery(id, o) {
        calls.posts.push({ id, opts: o });
        return opts.reject ? Promise.reject(opts.reject) : Promise.resolve({ id: 'sub_1', nextOrderDate: '2026-10-24' });
      },
      hasSession: () => true,
      clearSession() {},
    },

    attemptKey(op) {
      return attemptKey.call(this, op);
    },
    releaseAttempt(op) {
      return releaseAttempt.call(this, op);
    },
    releaseAllAttempts() {
      this.state.attempts = {};
    },
    run(key, work, o) {
      return run.call(this, key, work, o);
    },
    act(name, el) {
      return act.call(this, name, el);
    },

    // Everything below is scenery.
    applyPending(on) {
      confirmBtn.disabled = !!on;
      if (on) confirmBtn.setAttribute('aria-disabled', 'true');
      else confirmBtn.removeAttribute('aria-disabled');
    },
    render() {},
    closeSheet() {},
    show(s) {
      calls.shown.push(s);
    },
    toast(m) {
      calls.toasts.push(m);
    },
    fail() {},
    actionFailed() {},
    refreshRequired() {},
    refreshAuthenticatedData: () => Promise.resolve(),
    fmtDate: () => '24 October 2026',
    hasSession: () => true,
  };
  return p;
}

/* ================================================================== */

describe('one confirmation, one mutation', () => {
  test('a single confirmation sends exactly one request', async () => {
    const p = portal();
    p.act('skip', p.confirmBtn);
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(p.calls.posts.length, 1);
  });

  test('a rapid double-click sends exactly one request', async () => {
    const p = portal();
    // Both dispatched before any promise resolves, as a real double-tap is.
    p.act('skip', p.confirmBtn);
    p.act('skip', p.confirmBtn);
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(p.calls.posts.length, 1, 'the second click must not reach the adapter');
  });

  test('duplicated event listeners send exactly one request', async () => {
    const p = portal();
    // Two listeners on the same element both handling ONE click. This is what
    // a re-bind would produce, and each would call act() independently.
    const one = () => p.act('skip', p.confirmBtn);
    const two = () => p.act('skip', p.confirmBtn);
    one();
    two();
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(p.calls.posts.length, 1);
  });

  test('a form submit arriving alongside a click sends exactly one request', async () => {
    const p = portal();
    // A submit handler and a click handler both routing to the same action.
    p.act('skip', p.confirmBtn); // click
    p.act('skip', p.confirmBtn); // submit
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(p.calls.posts.length, 1);
  });

  test('a delayed second confirmation, after the first finished, is still refused', async () => {
    const p = portal();
    p.act('skip', p.confirmBtn);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(p.calls.posts.length, 1);

    // THE PRODUCTION CASE: 10.7 seconds later, nothing in flight, guard clear.
    p.act('skip', p.confirmBtn);
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(p.calls.posts.length, 1, 'the sheet is spent until it is reopened');
  });

  test('reopening the sheet re-arms it, because the customer asked again', async () => {
    const p = portal();
    p.act('skip', p.confirmBtn);
    await new Promise((r) => setTimeout(r, 0));

    // openSheet() is the only thing that re-arms.
    p.state.sheetSpent = true;
    const panel = {
      hidden: true,
      getAttribute: () => 'skip',
    };
    const host = {
      querySelectorAll: () => [panel],
      setAttribute() {},
      focus() {},
    };
    const overlay = { hidden: true };
    // openSheet records document.activeElement to restore focus on close.
    globalThis.document = { activeElement: null };
    openSheet.call({
      root: { querySelector: (sel) => (sel === '[data-spp-overlay]' ? overlay : host) },
      state: p.state,
      render() {},
      focusablesIn: () => [],
    }, 'skip');

    delete globalThis.document;
    assert.equal(p.state.sheetSpent, false, 'opening the sheet must re-arm it');
  });
});

describe('the confirm control is disabled before any async work', () => {
  test('disabled synchronously, before the request is even issued', () => {
    const p = portal();
    let disabledWhenCalled = null;
    p.adapter.skipNextDelivery = (id, o) => {
      disabledWhenCalled = p.confirmBtn.disabled;
      p.calls.posts.push({ id, opts: o });
      return Promise.resolve({ id: 'sub_1' });
    };

    p.act('skip', p.confirmBtn);

    assert.equal(disabledWhenCalled, true, 'the control must already be disabled');
    assert.equal(p.confirmBtn.getAttribute('aria-disabled'), 'true');
  });
});

describe('one attempt carries one key', () => {
  test('the key is stable for the whole logical attempt', () => {
    const p = portal();
    const first = p.attemptKey('skip');
    const second = p.attemptKey('skip');
    assert.equal(first, second, 'a rerender must not mint a new key');
  });

  test('the request carries the key and the observed pre-state', async () => {
    const p = portal();
    p.act('skip', p.confirmBtn);
    await new Promise((r) => setTimeout(r, 0));

    const sent = p.calls.posts[0].opts;
    assert.ok(sent.idempotencyKey && sent.idempotencyKey.length >= 8);
    // The date on screen when the customer confirmed — what lets the server
    // refuse a duplicate composed against a subscription that has since moved.
    assert.equal(sent.expectedNextBillingDate, '2026-09-24');
  });

  test('a definitive answer releases the key: the next attempt is new', async () => {
    const p = portal();
    const before = p.attemptKey('skip');
    p.act('skip', p.confirmBtn);
    await new Promise((r) => setTimeout(r, 0));

    p.state.sheetSpent = false; // as reopening the sheet would
    const after = p.attemptKey('skip');
    assert.notEqual(after, before, 'a new intention deserves a new key');
  });

  test('an UNKNOWN outcome keeps the key, so a retry cannot write twice', async () => {
    const err = new Error('timeout');
    err.code = 'timeout';
    const p = portal({ reject: err });

    const before = p.attemptKey('skip');
    p.act('skip', p.confirmBtn);
    await new Promise((r) => setTimeout(r, 0));

    p.state.sheetSpent = false;
    assert.equal(
      p.attemptKey('skip'),
      before,
      'after a timeout the outcome is unknown; the retry must reuse the key',
    );
  });

  test('a definitive failure releases the key, because nothing was applied', async () => {
    const err = new Error('nope');
    err.code = 'upstream_error';
    const p = portal({ reject: err });

    const before = p.attemptKey('skip');
    p.act('skip', p.confirmBtn);
    await new Promise((r) => setTimeout(r, 0));

    p.state.sheetSpent = false;
    assert.notEqual(p.attemptKey('skip'), before);
  });
});

describe('the shipped markup cannot submit a form', () => {
  test('every confirm control is type="button"', () => {
    const sheets = readFileSync(resolve(here, '..', 'snippets', 'spp-sheets.liquid'), 'utf8');
    const buttons = sheets.match(/<button[^>]*data-spp-act[^>]*>/g) || [];
    assert.ok(buttons.length > 0, 'there must be confirm buttons to check');
    for (const b of buttons) {
      assert.match(b, /type="button"/, `must be type="button": ${b}`);
    }
  });

  test('listeners are attached exactly once, from the constructor', () => {
    // bind() is the only place listeners are added, and it is called once.
    const bindCalls = src.match(/this\.bind\(\)/g) || [];
    assert.equal(bindCalls.length, 1, 'bind() must be called exactly once');

    // And a root cannot be booted twice.
    assert.match(src, /__sppBooted/, 'init() must guard against re-booting a root');
  });
});

describe('every mutating action is wired for safety, not just skip', () => {
  /**
   * THE OMISSION THIS EXISTS FOR
   * ----------------------------
   * The stable attempt key and the pre-state precondition were wired into
   * skip and nowhere else. delay, reschedule, cancel and reactivate still
   * minted a fresh key per call, and the two date-moving ones sent no
   * pre-state at all — so the server would have refused them outright with
   * `expected_state_required`, and any that got through had exactly the
   * duplicate exposure skip had just been fixed for.
   *
   * Read off the shipped source, so a new action cannot quietly ship without
   * the same protection.
   */
  const ACTIONS = ['skip', 'delay', 'undo', 'cancel', 'reactivate'];
  /** Those whose effect a duplicate could compound by moving a date again. */
  const MOVES_A_DATE = ['skip', 'delay', 'undo'];

  /** The body of one `case '<name>':` block in act(). */
  function actionBlock(name) {
    const start = src.indexOf(`case '${name}':`);
    assert.ok(start > -1, `act() must handle '${name}'`);
    const next = src.indexOf('      case ', start + 10);
    return src.slice(start, next === -1 ? start + 1400 : next);
  }

  for (const name of ACTIONS) {
    test(`${name} carries one stable key for the whole attempt`, () => {
      const block = actionBlock(name);
      assert.match(
        block,
        /attempt:\s*'[a-z]+'/,
        `${name} must declare an attempt, or run() mints nothing and the adapter invents a fresh key per call`,
      );
      assert.match(block, /idempotencyKey:\s*attemptKey/, `${name} must forward the attempt key`);
    });
  }

  for (const name of MOVES_A_DATE) {
    test(`${name} states the date it was composed against`, () => {
      assert.match(
        actionBlock(name),
        /expectedNextBillingDate:/,
        `${name} moves a delivery date, so the server needs the observed pre-state to refuse a stale duplicate`,
      );
    });
  }

  test('cancel and reactivate send no pre-state, because they have no date to move', () => {
    for (const name of ['cancel', 'reactivate']) {
      assert.ok(
        !/expectedNextBillingDate:/.test(actionBlock(name)),
        `${name} is idempotent in effect and must not demand a precondition`,
      );
    }
  });
});
