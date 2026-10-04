/**
 * Automatic World Animal Week -> Original switch on the EXISTING theme.
 *
 * Mechanism: server-side Liquid (snippets/campaign-mode.liquid) compares the render
 * time with the ISO-8601 instant in Theme setting "World Animal Week ends at"
 * (default 2026-10-04T23:59:59-04:00 = 05:59:59 Stockholm = 03:59:59 UTC on 5 Oct).
 * WAW is shown strictly BEFORE that instant, Original at and after. No theme is
 * replaced or published. A tiny head guard (snippets/campaign-guard.liquid) covers
 * stale cached HTML and mixed-surface pages.
 *
 * Run with:  node --test test/campaign-schedule.test.mjs   (needs liquidjs, git history)
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { loadLiquid, readText, repoRoot, campaignDefaults } from './helpers/render-liquid.mjs';

const CUTOFF = Date.parse('2026-10-05T03:59:59Z'); // 2026-10-04 23:59:59 America/New_York
const CUTOFF_S = CUTOFF / 1000;
const LIVE = '1cc7431'; // origin/main while WAW was live (previous behaviour)

const git = (...a) => { try { return execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
const live = (p) => git('show', `${LIVE}:${p}`);
let e = null;
before(async () => { e = await loadLiquid(); });
const norm = (s) => s.replace(/\s+/g, ' ').replace(/> </g, '><').trim();
const strip = (src) => src.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '').replace(/^[ \t]*comment[ \t]*\n[\s\S]*?^[ \t]*endcomment[ \t]*$/gm, '');
async function render(src, ctx, at) {
  e.setClock(at);
  return e.render(e.parse(strip(src)), ctx, { globals: { settings: ctx.settings || {} } });
}
const resolver = readText('snippets/campaign-mode.liquid');
const KEYS = ['homepage', 'announcement', 'popup', 'sales'];
const mode = async (key, settings, at) => (await render("{%- render 'campaign-mode', key: '" + key + "' -%}", { settings }, at)).trim();
const defaults = campaignDefaults();

describe('the cutoff instant is the same instant in all three zones', () => {
  test('23:59:59 America/New_York = 05:59:59 Europe/Stockholm = 03:59:59 UTC (2026-10-05)', () => {
    const f = (tz) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz, dateStyle: 'short', timeStyle: 'medium' }).format(CUTOFF);
    assert.equal(f('America/New_York'), '2026-10-04 23:59:59');
    assert.equal(f('Europe/Stockholm'), '2026-10-05 05:59:59');
    assert.equal(f('UTC'), '2026-10-05 03:59:59');
    assert.equal(CUTOFF_S, 1791172799);
  });
  test('the shipped default is exactly that instant', async () => {
    assert.equal(defaults.campaign_waw_ends_at, '2026-10-04T23:59:59-04:00');
    e.setClock(0);
    assert.equal((await e.render(e.parse("{{ '2026-10-04T23:59:59-04:00' | date: '%s' }}"), {})).trim(), String(CUTOFF_S));
  });
  test('all four default selectors are "scheduled" (so deploying before the cutoff changes nothing)', () => {
    for (const k of KEYS) assert.equal(defaults[`${k}_campaign_mode`], 'scheduled');
  });
});

describe('resolver: before / exactly at / after the cutoff, every surface', () => {
  const cases = [
    ['1 hour before', CUTOFF - 3600e3, 'world_animal_week'],
    ['1 second before (23:59:58)', CUTOFF - 1000, 'world_animal_week'],
    ['1 millisecond before', CUTOFF - 1, 'world_animal_week'],
    ['exactly at the cutoff (23:59:59)', CUTOFF, 'original'],
    ['1 millisecond after', CUTOFF + 1, 'original'],
    ['1 second after', CUTOFF + 1000, 'original'],
    ['06:00 Stockholm the next morning', Date.parse('2026-10-05T04:00:00Z'), 'original'],
    ['a week later', CUTOFF + 7 * 86400e3, 'original']
  ];
  for (const [label, at, want] of cases) {
    test(`${label} -> ${want}`, async (t) => {
      if (!e) return t.skip('liquidjs unavailable');
      for (const k of KEYS) assert.equal(await mode(k, { ...defaults }, at), want, k);
    });
  }
  test('manual selectors ignore the clock (preserved for future campaigns)', async (t) => {
    if (!e) return t.skip('liquidjs unavailable');
    for (const at of [CUTOFF - 1000, CUTOFF, CUTOFF + 9e9]) {
      for (const k of KEYS) {
        assert.equal(await mode(k, { ...defaults, [`${k}_campaign_mode`]: 'original' }, at), 'original');
        assert.equal(await mode(k, { ...defaults, [`${k}_campaign_mode`]: 'world_animal_week' }, at), 'world_animal_week');
      }
    }
  });
  test('each surface switches independently of the others', async (t) => {
    if (!e) return t.skip('liquidjs unavailable');
    const s = { ...defaults, popup_campaign_mode: 'original', sales_campaign_mode: 'world_animal_week' };
    const at = CUTOFF + 1000;
    assert.equal(await mode('popup', s, at), 'original');
    assert.equal(await mode('sales', s, at), 'world_animal_week');
    assert.equal(await mode('homepage', s, at), 'original');
  });
  test('missing / invalid selector values fail safe to Original', async (t) => {
    if (!e) return t.skip('liquidjs unavailable');
    for (const bad of [undefined, null, '', 'WAW', 'scheduled ', 'bogus', 0]) {
      for (const k of KEYS) assert.equal(await mode(k, { ...defaults, [`${k}_campaign_mode`]: bad }, CUTOFF - 1000), 'original', `${k}=${String(bad)}`);
    }
  });
  test('scheduled with a blank / garbage / missing end instant fails safe to Original', async (t) => {
    if (!e) return t.skip('liquidjs unavailable');
    for (const bad of ['', '   ', 'garbage', 'tomorrow', undefined, '0', '-1']) {
      assert.equal(await mode('sales', { ...defaults, campaign_waw_ends_at: bad }, CUTOFF - 3600e3), 'original', String(bad));
    }
  });
});

describe('DST / timezone behaviour', () => {
  test('the same instant written with Stockholm, UTC or New York offsets switches identically', async (t) => {
    if (!e) return t.skip('liquidjs unavailable');
    for (const iso of ['2026-10-04T23:59:59-04:00', '2026-10-05T05:59:59+02:00', '2026-10-05T03:59:59Z']) {
      const s = { ...defaults, campaign_waw_ends_at: iso };
      assert.equal(await mode('sales', s, CUTOFF - 1000), 'world_animal_week', iso);
      assert.equal(await mode('sales', s, CUTOFF), 'original', iso);
    }
  });
  test('the offset is honoured: mis-stating New York as EST (-05:00) would switch an hour LATE', async (t) => {
    if (!e) return t.skip('liquidjs unavailable');
    const s = { ...defaults, campaign_waw_ends_at: '2026-10-04T23:59:59-05:00' };
    assert.equal(await mode('sales', s, CUTOFF), 'world_animal_week'); // wrong offset => 04:59Z
    assert.equal(await mode('sales', s, CUTOFF + 3600e3), 'original');
    // 2026-10-04 is still daylight time in New York (DST ends 2026-11-01), so -04:00 is the correct offset
    assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' }).format(CUTOFF).split(' ').pop(), 'EDT');
  });
  test('the decision uses absolute epoch seconds, so Stockholm/New York DST changes never move it', async (t) => {
    if (!e) return t.skip('liquidjs unavailable');
    // Stockholm leaves DST on 2026-10-25 and New York on 2026-11-01; the cutoff precedes both.
    assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Stockholm', timeZoneName: 'short' }).format(CUTOFF).split(' ').pop(), 'GMT+2');
    for (const tz of ['America/New_York', 'Europe/Stockholm', 'UTC', 'Pacific/Auckland']) {
      const prev = process.env.TZ; process.env.TZ = tz;
      try { assert.equal(await mode('sales', { ...defaults }, CUTOFF - 1000), 'world_animal_week', tz); assert.equal(await mode('sales', { ...defaults }, CUTOFF), 'original', tz); }
      finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
    }
  });
});

describe('whole-page consistency: every surface flips together', () => {
  const ctxOf = (settings) => ({
    settings, product: { title: 'K', handle: 'k', id: 1, selected_or_first_available_variant: { id: 1, price: 100, available: true }, variants: [], images: [], metafields: {} },
    section: { id: 'x', settings: { enable: true, trigger: 'delay', delay_seconds: 8, hide_days: 7, storage_key: 'k', text_title: 'T', text_decline: 'N', text_subtitle: 's', bg_color: '#47b5e9', text_color: '#fff', icon_color: '#fff', speed: 40 }, blocks: [{ id: 'b', type: 'item', settings: { text: 'SAVE' } }] }, request: { path: '/', page_type: 'index' },
    page_title: 'T', content_for_layout: '', content_for_header: '', page: { title: 'P' }
  });
  const SURFACES = [
    ['sections/hero-review-carousel.liquid', 'homepage', /vp-hrc--waw/],
    ['sections/announcement-ticker.liquid', 'announcement', /vp-tickerbar--waw/],
    ['sections/vetpets-popup.liquid', 'popup', /vetpets-popup--world-animal-week/],
    ['sections/eyewipes-offer-page.liquid', 'sales', /data-waw="on"|waw-hero-lab|wtop/],
    ['sections/freshwipes-offer-page.liquid', 'sales', /data-waw="on"|waw-hero-lab|wtop/],
    ['sections/eyewipes-prelander.liquid', 'sales', /ewpl-waw-bar/],
    ['sections/freshwipes-prelander.liquid', 'sales', /fwpl-waw-bar/]
  ];
  const visible = (h) => h.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '');
  for (const [label, at, wantWaw] of [['1 second before', CUTOFF - 1000, true], ['exactly at', CUTOFF, false], ['1 second after', CUTOFF + 1000, false]]) {
    test(`${label}: all seven sections render ${wantWaw ? 'WAW' : 'Original'}; layouts and countdown follow`, async (t) => {
      if (!e) return t.skip('liquid unavailable');
      for (const [file, , re] of SURFACES) {
        const html = await render(readText(file), ctxOf({ ...defaults }), at);
        assert.equal(re.test(visible(html)), wantWaw, `${file} at ${label}`);
        if (!wantWaw) assert.doesNotMatch(visible(html), /World Animal|waw-/i, `${file} Original must carry no WAW markup`);
      }
      for (const p of ['freshwipes', 'eyewipes']) {
        const lay = await render(readText(`layout/${p}-prelander.liquid`), ctxOf({ ...defaults }), at);
        assert.equal(/-waw\.css/.test(lay), wantWaw, `${p} layout stylesheet`);
        assert.equal(/-waw\.js|data-waw-preview/.test(lay), wantWaw);
      }
      // Original starts the evergreen countdown; WAW keeps its fixed one
      for (const f of ['eyewipes-offer-page', 'freshwipes-offer-page', 'eyewipes-prelander', 'freshwipes-prelander']) {
        const html = await render(readText(`sections/${f}.liquid`), ctxOf({ ...defaults }), at);
        assert.equal(/data-vp-dcd=/.test(html), !wantWaw, `${f} evergreen countdown`);
      }
    });
  }
  test('markers: every surface on a page reports the same mode on either side of the cutoff', async (t) => {
    if (!e) return t.skip('liquidjs unavailable');
    for (const at of [CUTOFF - 1000, CUTOFF + 1000]) {
      const modes = new Set();
      for (const [file] of SURFACES) {
        const html = await render(readText(file), ctxOf({ ...defaults }), at);
        for (const m of html.matchAll(/data-vp-campaign-mode="(\w+)"/g)) modes.add(m[1]);
      }
      assert.equal(modes.size, 1, `mixed modes at ${at}: ${[...modes]}`);
    }
  });
});

describe('deploying BEFORE the cutoff changes nothing visible (new code == previously-live WAW)', () => {
  const T0 = Date.parse('2026-10-04T14:00:00Z'); // morning in New York, same day
  const ctx = (extra = {}) => ({
    settings: { ...defaults }, product: { title: 'K', handle: 'k', id: 1, selected_or_first_available_variant: { id: 1, price: 100, available: true }, variants: [], images: [], metafields: {} },
    section: { id: 'x', settings: { waw_enabled: true, popup_theme: 'world_animal_week', enable: true, trigger: 'delay', delay_seconds: 8, hide_days: 7, storage_key: 'k', text_title: 'T', text_decline: 'N', text_subtitle: 's', bg_color: '#47b5e9', text_color: '#fff', icon_color: '#fff', speed: 40 }, blocks: [{ id: 'b', type: 'item', settings: { text: 'SAVE' } }] },
    request: { path: '/', page_type: 'index' }, page_title: 'T', content_for_layout: '', content_for_header: '', page: { title: 'P' }, ...extra
  });
  const scrub = (s) => norm(s)
    .replace(/-waw\.(css|js)/g, '.$1')
    .replace(/<script src="\/assets\/vp-countdown\.js"[^>]*><\/script>/g, '')
    .replace(/<script>\s*\(function \(\) \{\s*var ENDS[\s\S]*?<\/script>/g, '')
    .replace(/<script>window\.VPCampaignEnds = \d+;<\/script>/g, '')
    .replace(/var WAW_DEADLINE_MS = [^;]*;[^\n]*/g, 'var WAW_DEADLINE_MS = X;')
    .replace(/<span hidden data-vp-campaign=[^>]*><\/span>/g, '');
  const pairs = [
    'sections/hero-review-carousel.liquid', 'sections/announcement-ticker.liquid', 'sections/vetpets-popup.liquid',
    'sections/eyewipes-offer-page.liquid', 'sections/freshwipes-offer-page.liquid', 'sections/eyewipes-prelander.liquid', 'sections/freshwipes-prelander.liquid',
    'layout/eyewipes-prelander.liquid', 'layout/freshwipes-prelander.liquid'
  ];
  for (const file of pairs) {
    test(`${file}: rendered output at T0 equals the previously-live output`, async (t) => {
      const old = live(file);
      if (!e || !old) return t.skip('liquidjs or git history unavailable');
      const a = scrub(await render(readText(file), ctx(), T0));
      // the live homepage/popup/offer/pre-lander gates all used date/epoch logic or the toggles that were ON in production
      const b = scrub(await render(old, ctx(), T0));
      assert.equal(a, b);
    });
  }
  test('the same deploy AFTER the cutoff renders Original, i.e. NOT the live output', async (t) => {
    const old = live('sections/hero-review-carousel.liquid');
    if (!e || !old) return t.skip('liquidjs or git history unavailable');
    const a = scrub(await render(readText('sections/hero-review-carousel.liquid'), ctx(), CUTOFF));
    const b = scrub(await render(old, ctx(), CUTOFF));
    assert.notEqual(a, b);
  });
});

describe('the WAW countdowns and the switch share ONE instant', () => {
  test('the head exposes window.VPCampaignEnds = the cutoff epoch (even with manual selectors)', async (t) => {
    if (!e) return t.skip('liquidjs unavailable');
    for (const s of [{ ...defaults }, { ...defaults, sales_campaign_mode: 'world_animal_week', homepage_campaign_mode: 'original', announcement_campaign_mode: 'original', popup_campaign_mode: 'original' }]) {
      const out = await render("{%- render 'campaign-guard' -%}", { settings: s }, CUTOFF - 1000);
      assert.match(out, new RegExp(`window\\.VPCampaignEnds = ${CUTOFF_S};`));
    }
    const none = await render("{%- render 'campaign-guard' -%}", { settings: { ...defaults, campaign_waw_ends_at: 'garbage' } }, CUTOFF - 1000);
    assert.doesNotMatch(none, /VPCampaignEnds/);
  });
  test('every WAW countdown reads window.VPCampaignEnds, with the same instant as the fallback', () => {
    for (const f of ['assets/eyewipes-offer-page-waw.js', 'assets/freshwipes-offer-page-waw.js', 'assets/eyewipes-prelander-waw.js', 'assets/freshwipes-prelander-waw.js']) {
      assert.match(readText(f), new RegExp(`window\\.VPCampaignEnds \\? window\\.VPCampaignEnds \\* 1000 : ${CUTOFF_S}000`), f);
    }
    assert.match(readText('sections/vetpets-popup.liquid'), new RegExp(`window\\.VPCampaignEnds \\? window\\.VPCampaignEnds \\* 1000 : ${CUTOFF_S}000`));
    assert.equal(CUTOFF_S * 1000, 1791172799000);
  });
});

describe('head guard: stale HTML and mixed surfaces', () => {
  async function guardCode(settings, at) {
    const out = await render("{%- render 'campaign-guard' -%}", { settings }, at);
    const m = out.match(/<script>(\s*\(function[\s\S]*?)<\/script>/);
    return m ? m[1] : null;
  }
  function run(code, { clientNow: initial, now: nowFn, markers = [], search = '' }) {
    const cur = () => (nowFn ? nowFn() : initial);
    const calls = { replace: [], timers: [], handlers: {} };
    class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [cur()])); } static now() { return cur(); } }
    const document = {
      hidden: false, addEventListener: (n, f) => { (calls.handlers[n] ||= []).push(f); },
      querySelectorAll: () => markers.map((v) => ({ getAttribute: () => v }))
    };
    const location = { href: 'https://shopvetpets.com/pages/x?utm_source=a#h', search, replace: (u) => calls.replace.push(u) };
    const window = { addEventListener: (n, f) => { (calls.handlers['w:' + n] ||= []).push(f); } };
    new Function('window', 'document', 'location', 'Date', 'setTimeout', 'URL', code)(window, document, location, FakeDate, (f, ms) => { calls.timers.push({ f, ms }); return 1; }, URL);
    return { calls, document, window, fire: (n) => (calls.handlers[n] || []).forEach((f) => f()) };
  }
  test('no script at all unless a surface is scheduled with a valid end instant', async (t) => {
    if (!e) return t.skip('liquidjs unavailable');
    const manual = { ...defaults, homepage_campaign_mode: 'original', announcement_campaign_mode: 'world_animal_week', popup_campaign_mode: 'original', sales_campaign_mode: 'original' };
    assert.equal(await guardCode(manual, CUTOFF - 1000), null); // (only the VPCampaignEnds one-liner is emitted)
    assert.equal(await guardCode({ ...defaults, campaign_waw_ends_at: 'garbage' }, CUTOFF - 1000), null);
    assert.ok(await guardCode({ ...defaults }, CUTOFF - 1000));
  });
  test('rendered before the cutoff, viewed before it: no refresh, one timer set for cutoff+250ms', async (t) => {
    if (!e) return t.skip('liquidjs unavailable');
    const code = await guardCode({ ...defaults }, CUTOFF - 5000);
    const r = run(code, { clientNow: CUTOFF - 5000 });
    assert.equal(r.calls.replace.length, 0);
    assert.equal(r.calls.timers[0].ms, 5250);
    r.calls.timers[0].f(); // (clock still before) -> still nothing
  });
  test('stale HTML (rendered before) viewed exactly at / after the cutoff -> exactly one cache-busting refresh', async (t) => {
    if (!e) return t.skip('liquidjs unavailable');
    const code = await guardCode({ ...defaults }, CUTOFF - 5000);
    for (const now of [CUTOFF, CUTOFF + 1, CUTOFF + 3600e3]) {
      const r = run(code, { clientNow: now });
      assert.equal(r.calls.replace.length, 1, String(now));
      const u = new URL(r.calls.replace[0]);
      assert.equal(u.searchParams.get('vp_cb'), String(CUTOFF_S));
      assert.equal(u.searchParams.get('utm_source'), 'a');
      assert.equal(u.hash, '#h');
      r.fire('visibilitychange'); r.fire('w:pageshow'); r.fire('w:load'); // never a second refresh
      assert.equal(r.calls.replace.length, 1);
    }
  });
  test('an open tab is refreshed by the timer when the cutoff passes', async (t) => {
    if (!e) return t.skip('liquidjs unavailable');
    const code = await guardCode({ ...defaults }, CUTOFF - 5000);
    let now = CUTOFF - 5000;
    const r = run(code, { now: () => now });
    now = CUTOFF + 300; r.calls.timers[0].f();
    assert.equal(r.calls.replace.length, 1);
  });
  test('HTML rendered at/after the cutoff is already Original: never refreshed', async (t) => {
    if (!e) return t.skip('liquidjs unavailable');
    for (const at of [CUTOFF, CUTOFF + 1000]) {
      const code = await guardCode({ ...defaults }, at);
      const r = run(code, { clientNow: at + 60e3 });
      r.fire('w:load');
      assert.equal(r.calls.replace.length, 0);
    }
  });
  test('an already-refreshed URL (vp_cb present) is never refreshed again: no loops, even with a fast client clock', async (t) => {
    if (!e) return t.skip('liquidjs unavailable');
    const code = await guardCode({ ...defaults }, CUTOFF - 5000);
    const r = run(code, { clientNow: CUTOFF + 10, search: `?vp_cb=${CUTOFF_S}` });
    assert.equal(r.calls.replace.length, 0);
  });
  test('mixed WAW/Original surfaces on one page trigger one refresh; consistent pages do not', async (t) => {
    if (!e) return t.skip('liquidjs unavailable');
    const code = await guardCode({ ...defaults }, CUTOFF - 1000);
    let r = run(code, { clientNow: CUTOFF - 1000, markers: ['world_animal_week', 'original', 'world_animal_week'] });
    r.fire('DOMContentLoaded');
    assert.equal(r.calls.replace.length, 1);
    r = run(code, { clientNow: CUTOFF - 1000, markers: ['world_animal_week', 'world_animal_week'] });
    r.fire('DOMContentLoaded'); r.fire('w:load');
    assert.equal(r.calls.replace.length, 0);
    r = run(await guardCode({ ...defaults }, CUTOFF + 1000), { clientNow: CUTOFF + 1000, markers: ['original', 'original'] });
    r.fire('DOMContentLoaded');
    assert.equal(r.calls.replace.length, 0);
  });
  test('the guard is rendered in every layout that shows these surfaces', () => {
    for (const f of ['layout/theme.liquid', 'layout/freshwipes-prelander.liquid', 'layout/eyewipes-prelander.liquid']) {
      assert.match(readText(f), /render 'campaign-guard'/, f);
    }
  });
});
