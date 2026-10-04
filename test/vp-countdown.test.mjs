/**
 * Shared evergreen countdown (assets/vp-countdown.js).
 *
 * Original mode = daily countdown to 23:59:59 America/New_York that restarts
 * every New York day. WAW mode = fixed deadline. One module drives every
 * pre-lander / offer page, so identical moments must give identical values.
 *
 * Run with:  node --test test/vp-countdown.test.mjs
 */
import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const VP = require(resolve(here, '..', 'assets', 'vp-countdown.js'));
const daily = { mode: 'daily-et' };
const at = (iso) => Date.parse(iso);
const hms = (left) => { const p = VP.split(left); return [p.h, p.m, p.s].map((n) => String(n).padStart(2, '0')).join(':'); };

describe('daily-et: before midnight', () => {
  test('09:00 New York (EDT) -> 14:59:59 left', () => {
    assert.equal(hms(VP.remainingSeconds(daily, at('2026-10-04T13:00:00Z'))), '14:59:59');
  });
  test('23:59:30 New York -> 29 seconds left', () => {
    assert.equal(VP.remainingSeconds(daily, at('2026-10-05T03:59:30Z')), 29);
  });
  test('winter (EST) uses UTC-5: 20:00 NY -> 03:59:59 left', () => {
    assert.equal(hms(VP.remainingSeconds(daily, at('2026-12-16T01:00:00Z'))), '03:59:59');
  });
});

describe('daily-et: midnight rollover', () => {
  test('23:59:59 shows zero, 00:00:00 restarts at 23:59:59', () => {
    assert.equal(VP.remainingSeconds(daily, at('2026-10-05T03:59:59Z')), 0);
    assert.equal(VP.remainingSeconds(daily, at('2026-10-05T04:00:00Z')), 86399);
  });
  test('never negative, including the last fraction of a second', () => {
    for (const ms of [0, 1, 500, 999]) {
      const v = VP.remainingSeconds(daily, at('2026-10-05T03:59:59Z') + ms);
      assert.ok(v >= 0 && v <= 86399, String(v));
    }
  });
  test('monotonically decreasing within one day', () => {
    let prev = Infinity;
    for (let t = at('2026-10-05T04:00:00Z'); t < at('2026-10-06T03:59:59Z'); t += 997 * 60) {
      const v = VP.remainingSeconds(daily, t);
      assert.ok(v <= prev, `${t}`); prev = v;
    }
  });
});

describe('daily-et: DST', () => {
  test('spring forward (2026-03-08) is a 23-hour day', () => {
    assert.equal(VP.remainingSeconds(daily, at('2026-03-08T05:00:00Z')), 23 * 3600 - 1);
    assert.equal(VP.remainingSeconds(daily, at('2026-03-09T03:59:59Z')), 0); // 23:59:59 EDT
  });
  test('fall back (2026-11-01) is a 25-hour day', () => {
    assert.equal(VP.remainingSeconds(daily, at('2026-11-01T04:00:00Z')), 25 * 3600 - 1);
    assert.equal(VP.remainingSeconds(daily, at('2026-11-02T04:59:59Z')), 0); // 23:59:59 EST
  });
  test('the repeated 01:30 hour on fall-back day is two distinct instants', () => {
    const first = VP.remainingSeconds(daily, at('2026-11-01T05:30:00Z'));  // 01:30 EDT
    const second = VP.remainingSeconds(daily, at('2026-11-01T06:30:00Z')); // 01:30 EST
    assert.equal(first - second, 3600);
  });
  test('rule-based fallback agrees with Intl across both transitions', () => {
    for (const iso of ['2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z', '2026-11-01T05:59:59Z', '2026-11-01T06:00:00Z', '2026-07-01T00:00:00Z', '2026-01-15T00:00:00Z']) {
      assert.equal(VP.ruleOffsetMs(at(iso)), VP.tzOffsetMs(at(iso)), iso);
    }
  });
});

describe('fixed mode (World Animal Week)', () => {
  const fixed = { mode: 'fixed', deadlineMs: 1791172799000 }; // 2026-10-04 23:59:59 EDT
  test('counts to the deadline and clamps at zero afterwards', () => {
    assert.equal(VP.remainingSeconds(fixed, 1791172799000 - 61000), 61);
    assert.equal(VP.remainingSeconds(fixed, 1791172799000 + 5000), 0);
  });
  test('a bad deadline yields zero, not NaN', () => {
    assert.equal(VP.remainingSeconds({ mode: 'fixed', deadlineMs: 'x' }, Date.now()), 0);
  });
});

function fakeNodes(keys) {
  return keys.map((k) => ({ textContent: '--', getAttribute: () => k }));
}

describe('mounting: identical values across page implementations', () => {
  beforeEach(() => { VP._reset(); mock.timers.reset(); });

  test('FreshWipes, EyeWipes and a data-cd page show the same time at the same moment', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: at('2026-10-06T15:20:41Z') });
    const fw = fakeNodes(['h', 'm', 's']);
    const ew = fakeNodes(['h', 'm', 's']);
    const wide = fakeNodes(['d', 'h', 'm', 's']);
    VP.mount(fw, { attr: 'data-fwpl-cd', mode: 'daily-et' });
    VP.mount(ew, { attr: 'data-ewpl-cd', mode: 'daily-et' });
    VP.mount(wide, { attr: 'data-cd', mode: 'daily-et' });
    const read = (n) => n.map((x) => x.textContent).join(':');
    assert.equal(read(fw), '12:39:18');      // 11:20:41 EDT -> 23:59:59
    assert.equal(read(ew), read(fw));
    assert.equal(read(wide), '00:' + read(fw));
    mock.timers.tick(5020);
    assert.equal(read(fw), '12:39:13');
    assert.equal(read(ew), read(fw));
    mock.timers.reset();
  });

  test('rolls over at New York midnight without any page reload', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: at('2026-10-05T03:59:57Z') });
    const n = fakeNodes(['h', 'm', 's']);
    VP.mount(n, { attr: 'data-fwpl-cd', mode: 'daily-et' });
    assert.equal(n.map((x) => x.textContent).join(':'), '00:00:02');
    mock.timers.tick(2020);
    assert.equal(n.map((x) => x.textContent).join(':'), '00:00:00');
    mock.timers.tick(1000);
    assert.equal(n.map((x) => x.textContent).join(':'), '23:59:59');
    mock.timers.reset();
  });

  test('mounting the same nodes twice never duplicates subscribers or timers', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: at('2026-10-06T15:20:41Z') });
    const n = fakeNodes(['h', 'm', 's']);
    VP.mount(n, { attr: 'a', mode: 'daily-et' });
    VP.mount(n, { attr: 'a', mode: 'daily-et' });
    assert.equal(VP._subscriberCount(), 3);
    assert.equal(VP._timerActive(), true);
    mock.timers.reset();
  });

  test('mounting nothing is a harmless no-op (hydration with absent markup)', () => {
    assert.equal(VP.mount([], { attr: 'x', mode: 'daily-et' }), 0);
    assert.equal(VP.mount(null, { attr: 'x' }), 0);
    assert.equal(VP._timerActive(), false);
  });
});

describe('pages wire the shared module and keep no private timer maths', () => {
  const read = (f) => readFileSync(resolve(here, '..', f), 'utf8');
  // Original pre-landers/offer pages have NO countdown (owner removed it 2026-09-08: 3258e0f, 85f5e2c),
  // so only the World Animal Week variants mount the shared clock (fixed deadline).
  const wawPages = ['assets/freshwipes-prelander-waw.js', 'assets/eyewipes-prelander-waw.js', 'assets/freshwipes-offer-page-waw.js', 'assets/eyewipes-offer-page-waw.js'];
  for (const f of wawPages) {
    test(`${f} -> VPCountdown.mount(fixed), no private maths`, () => {
      const s = read(f);
      assert.match(s, /VPCountdown\.mount\([^\n]*mode: 'fixed', deadlineMs: 1791172799000/);
      assert.doesNotMatch(s, /setHours\(24|new Date\(2026,\s*9,\s*4|WAW_DEADLINE_MS/);
    });
  }
  test('all four WAW pages share the identical deadline instant', () => {
    assert.equal(new Date('2026-10-04T23:59:59-04:00').getTime(), 1791172799000);
  });
  test('Original pages load no countdown module and carry no deadline', () => {
    for (const f of ['assets/freshwipes-prelander.js', 'assets/eyewipes-prelander.js', 'assets/freshwipes-offer-page.js', 'assets/eyewipes-offer-page.js']) {
      assert.doesNotMatch(read(f), /VPCountdown|1791172799|WAW|World Animal/i, f);
    }
  });
  test('the module is loaded before the WAW page scripts', () => {
    for (const p of ['freshwipes', 'eyewipes']) {
      const l = read(`layout/${p}-prelander.liquid`);
      assert.ok(l.indexOf("'vp-countdown.js'") > 0 && l.indexOf("'vp-countdown.js'") < l.indexOf(`'${p}-prelander' | append: pl_suffix | append: '.js'`));
      const s = read(`sections/${p}-offer-page.liquid`);
      assert.ok(s.indexOf("'vp-countdown.js'") > 0 && s.indexOf("'vp-countdown.js'") < s.indexOf(`'${p}-offer-page-waw.js'`));
    }
  });
});
