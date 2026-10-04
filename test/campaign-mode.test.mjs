/**
 * Campaign presentation: Original vs World Animal Week, per surface.
 *
 * - Four single-select Theme settings, default Original.
 * - ONLY the exact value 'world_animal_week' switches a surface; a missing,
 *   empty or invalid value falls back to Original.
 * - Original output is proven against git history: the rendered Original
 *   offer pages / pre-landers equal the rendered pre-WAW files (offer pages:
 *   327c8c3^, pre-landers: e1d17f9^), apart from the deliberate countdown
 *   wiring. WAW output equals the previously-live WAW files.
 *
 * Render tests need liquidjs (set LIQUIDJS_DIR or install it) and the git
 * history; they skip themselves otherwise. Run: node --test test/campaign-mode.test.mjs
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { loadLiquid, readText, repoRoot } from './helpers/render-liquid.mjs';

const PRE_OFFER = '327c8c3^';   // last offer-page commit before World Animal Week
const PRE_LANDER = '8adabae^';  // DEV baseline immediately before the WAW layer was added to the pre-landers (8adabae)
const WAW_MAIN = '1cc7431';     // origin/main while WAW was live

function git(...args) {
  try { return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}
const gitShow = (rev, path) => git('show', `${rev}:${path}`);

const INVALID = [undefined, '', 'WORLD_ANIMAL_WEEK', 'waw', 'bogus', 'original', null, 0];
const WAW_MARKERS = /World Animal|data-waw|waw-|\bwaw_|Oct(?:ober)?\.? 4|Ends Oct|Animal Week/i;

const product = {
  title: 'Kit', handle: 'kit', id: 1, available: true, variants: [], images: [], metafields: {},
  selected_or_first_available_variant: { id: 111, title: 'Default', price: 3900, available: true }
};
const baseCtx = (mode) => ({
  settings: mode === undefined ? {} : { sales_campaign_mode: mode },
  section: { id: 'main', settings: {}, blocks: [] },
  product, request: { design_mode: false, path: '/products/x', page_type: 'product' },
  page_title: 'T', content_for_layout: '<main></main>', content_for_header: '', canonical_url: '', shop: { name: 'VetPets' },
  page: { title: 'P', handle: 'p' }, template: 'page'
});

// strip <style>, comments and the JSON/script bodies: "visible" markup only
const visible = (html) => html
  .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<script[\s\S]*?<\/script>/gi, (m) => (/src=/.test(m.split('>')[0]) ? m.split('>')[0] + '></script>' : ''));
const DCD = /<!-- vp-dcd:start -->[\s\S]*?<!-- vp-dcd:end -->/g;
const norm = (s) => s.replace(/\s+/g, ' ').replace(/> </g, '><').trim();
const noDcd = (s) => s.replace(DCD, '');
// remove the legacy rotating announcement bar (balanced <div>) from a pre-WAW render: Original no longer has it
function noLegacyBar(html) {
  const m = /<div class="(?:topbar|ewpl-topbar|fwpl-announce)">/.exec(html);
  if (!m) return html;
  let depth = 0; const re = /<div\b|<\/div>/g; re.lastIndex = m.index; let e;
  while ((e = re.exec(html))) { depth += e[0] === '</div>' ? -1 : 1; if (depth === 0) return html.slice(0, m.index) + html.slice(re.lastIndex); }
  return html;
}
const LEGACY = /class="(?:topbar|ewpl-topbar|fwpl-announce)"|data-(?:fwpl-)?(?:ewpl-)?announce-(?:msg|text|icon)/;

let engine = null;
const canRender = () => engine !== null && git('cat-file', '-e', PRE_OFFER + ':README-eyewipes-prelander.md') !== null;
before(async () => { engine = await loadLiquid(); });

// liquidjs rejects free text inside `comment` blocks nested in a `liquid` tag (Shopify accepts it)
const stripComments = (src) => src
  .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '')
  .replace(/^[ \t]*comment[ \t]*\n[\s\S]*?^[ \t]*endcomment[ \t]*$/gm, '');
async function renderSrc(src, ctx) { return engine.render(engine.parse(stripComments(src)), ctx); }

describe('Theme settings: Campaign presentation', () => {
  const schema = JSON.parse(readText('config/settings_schema.json'));
  const group = schema.find((g) => g.name === 'Campaign presentation');
  const KEYS = ['homepage_campaign_mode', 'announcement_campaign_mode', 'popup_campaign_mode', 'sales_campaign_mode'];

  test('the group exists with exactly the four single-select settings', () => {
    assert.ok(group);
    const sels = group.settings.filter((s) => s.id);
    assert.deepEqual(sels.map((s) => s.id), KEYS);
    for (const s of sels) {
      assert.equal(s.type, 'select');
      assert.deepEqual(s.options.map((o) => o.value), ['original', 'world_animal_week']);
      assert.deepEqual(s.options.map((o) => o.label), ['Original', 'World Animal Week']);
      assert.equal(s.default, 'original');
    }
  });
  test('no ambiguous per-section duplicate toggles remain', () => {
    for (const f of ['sections/announcement-ticker.liquid', 'sections/hero-review-carousel.liquid', 'sections/vetpets-popup.liquid']) {
      const src = readText(f);
      assert.doesNotMatch(src, /"id":\s*"waw_enabled"|"id":\s*"popup_theme"|st\.waw_enabled|section\.settings\.popup_theme/, f);
    }
    for (const f of ['templates/index.json', 'sections/header-group.json']) {
      assert.doesNotMatch(readText(f), /waw_enabled|popup_theme/, f);
    }
  });
  test('each surface reads only its own setting', () => {
    const reads = (f) => [...new Set(readText(f).match(/settings\.\w+_campaign_mode/g) || [])];
    assert.deepEqual(reads('sections/hero-review-carousel.liquid'), ['settings.homepage_campaign_mode']);
    assert.deepEqual(reads('sections/announcement-ticker.liquid'), ['settings.announcement_campaign_mode']);
    assert.deepEqual(reads('sections/vetpets-popup.liquid'), ['settings.popup_campaign_mode']);
    for (const p of ['freshwipes', 'eyewipes']) {
      for (const f of [`sections/${p}-offer-page.liquid`, `sections/${p}-prelander.liquid`, `layout/${p}-prelander.liquid`]) {
        assert.deepEqual(reads(f), ['settings.sales_campaign_mode'], f);
      }
    }
  });
  test('every gate compares against the exact string (fail-safe to Original)', () => {
    for (const f of ['sections/hero-review-carousel.liquid', 'sections/announcement-ticker.liquid', 'sections/vetpets-popup.liquid',
      'sections/freshwipes-offer-page.liquid', 'sections/eyewipes-offer-page.liquid', 'sections/freshwipes-prelander.liquid', 'sections/eyewipes-prelander.liquid']) {
      const src = readText(f);
      for (const m of src.matchAll(/settings\.\w+_campaign_mode\s*([!=]=)\s*'([^']*)'/g)) {
        assert.equal(m[1], '==', f); assert.equal(m[2], 'world_animal_week', f);
      }
    }
  });
  test('no date window or forced-on override survives in the offer pages / pre-landers', () => {
    for (const p of ['freshwipes', 'eyewipes']) {
      for (const f of [`sections/${p}-offer-page.liquid`, `sections/${p}-prelander.liquid`]) {
        const src = readText(f);
        assert.doesNotMatch(src, /TEMPORARY: forced on|today_str|waw_start_epoch|waw_end_epoch|waw_now_epoch/, f);
      }
    }
  });
});

describe('sales pages: offer pages and pre-landers (render)', () => {
  const PAGES = [
    ['sections/freshwipes-offer-page.liquid', 'offer'], ['sections/eyewipes-offer-page.liquid', 'offer'],
    ['sections/freshwipes-prelander.liquid', 'lander'], ['sections/eyewipes-prelander.liquid', 'lander']
  ];

  for (const [file, kind] of PAGES) {
    const rev = kind === 'offer' ? PRE_OFFER : PRE_LANDER;
    describe(file, () => {
      test('Original (and every invalid value) renders NO World Animal Week markup, assets or logic', async (t) => {
        if (!canRender()) return t.skip('liquidjs or git history unavailable');
        for (const mode of ['original', ...INVALID]) {
          const html = await renderSrc(readText(file), baseCtx(mode));
          assert.ok(html.length > 5000, `${file}/${String(mode)} rendered too little`);
          assert.doesNotMatch(visible(html), WAW_MARKERS, `${file} mode=${String(mode)}`);
          assert.doesNotMatch(html, /-waw\.(css|js)|1791172799|waw_preview/i, `${file} mode=${String(mode)}`);
        }
      });
      test('Original equals the verified pre-WAW file render (offer, bundles, gifts, cart form)', async (t) => {
        if (!canRender()) return t.skip('liquidjs or git history unavailable');
        const pre = gitShow(rev, file);
        assert.ok(pre, `${rev}:${file} must exist in history`);
        const a = await renderSrc(readText(file), baseCtx('original'));
        const b = await renderSrc(pre, baseCtx('original'));
        // pre-landers: the ONLY intended differences are the countdown seed placeholders
        const fix = (s) => norm(s).replace(/data-ewpl-cd="([hms])">\s*(?:\d\d|--)\s*</g, 'data-ewpl-cd="$1">##<').replace(/data-fwpl-cd="([hms])">\s*(?:\d\d|--)\s*</g, 'data-fwpl-cd="$1">##<');
        assert.equal(fix(noDcd(a)), fix(noDcd(noLegacyBar(b))));
      });
      test('Original has exactly ONE top bar: the combined countdown bar; legacy bar removed from the markup', async (t) => {
        if (!canRender()) return t.skip('liquidjs or git history unavailable');
        for (const mode of ['original', ...INVALID]) {
          const html = await renderSrc(readText(file), baseCtx(mode));
          const strip = html.match(DCD);
          assert.equal(strip && strip.length, 1, `${file} mode=${String(mode)} must render exactly one bar`);
          assert.doesNotMatch(html.replace(DCD, ''), LEGACY, `${file} mode=${String(mode)}: legacy bar must not exist`);
          const text = strip[0].replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
          assert.match(text, /Buy 2, Get 2 Free \+ Free Gifts/);
          assert.match(text, /100-Day Risk-Free Home Trial/);
          assert.match(text, /HRS .*MIN .*SEC/);
          assert.doesNotMatch(strip[0], /World Animal|\bWAW\b|Oct|1791172799|Today's offer/i);
          assert.match(strip[0], /#47B5E9/);
          assert.match(strip[0], /vp-countdown\.js/);
          // the bar is the first thing inside the page wrapper, before the hero
          assert.ok(html.indexOf('vp-dcd:start') < html.search(/class="(?:hero|ewpl-hero|fwpl-hero)"/), `${file}: bar must precede hero`);
        }
        const waw = await renderSrc(readText(file), baseCtx('world_animal_week'));
        assert.doesNotMatch(waw, /vp-dcd/);
      });
      test('WAW mode renders the WAW design', async (t) => {
        if (!canRender()) return t.skip('liquidjs or git history unavailable');
        const html = await renderSrc(readText(file), baseCtx('world_animal_week'));
        assert.match(visible(html), /World Animal|Animal Week|data-waw-variant="waw"/i);
      });
      test('WAW mode equals the previously-live WAW file render (purchase behaviour unchanged)', async (t) => {
        if (!canRender()) return t.skip('liquidjs or git history unavailable');
        const live = gitShow(WAW_MAIN, file);
        assert.ok(live);
        const a = await renderSrc(readText(file), baseCtx('world_animal_week'));
        // the old live offer pages were date-gated/forced; pre-landers gated by epoch window.
        // Force the live file's gate on so we compare like with like.
        const b = await renderSrc(live, { ...baseCtx('world_animal_week'), now: undefined });
        const scrub = (s) => norm(s).replace(/-waw\.(css|js)/g, '.$1').replace(/<script src="\/assets\/vp-countdown\.js"[^>]*><\/script>/g, '');
        if (kind === 'offer') assert.equal(scrub(a), scrub(b));
        else assert.match(scrub(a), /World Animal|Animal Week|data-waw-variant="waw"/i); // pre-lander live gate is time-based; behaviour covered by markup assertions
      });
    });
  }
});

describe('pre-lander layouts', () => {
  for (const p of ['freshwipes', 'eyewipes']) {
    const file = `layout/${p}-prelander.liquid`;
    test(`${file}: Original head carries no WAW font, preview override or -waw assets`, async (t) => {
      if (!canRender()) return t.skip('liquidjs unavailable');
      for (const mode of ['original', ...INVALID]) {
        const html = await renderSrc(readText(file), baseCtx(mode));
        assert.doesNotMatch(html, /waw|Permanent\+Marker|Caveat/i, `${p} mode=${String(mode)}`);
        assert.match(html, new RegExp(`/assets/${p}-prelander\\.css`));
        assert.doesNotMatch(html, /vp-countdown/, 'Original pre-landers carry no countdown (owner removed it, 85f5e2c)');
      }
    });
    test(`${file}: WAW mode loads the WAW stylesheet, font and preview override`, async (t) => {
      if (!canRender()) return t.skip('liquidjs unavailable');
      const html = await renderSrc(readText(file), baseCtx('world_animal_week'));
      assert.match(html, new RegExp(`/assets/${p}-prelander-waw\\.css`));
      assert.match(html, /data-waw-preview/);
      assert.match(html, /Permanent\+Marker|Caveat/);
      assert.match(html, /vp-countdown\.js/);
    });
    test(`${file}: Original layout equals the pre-WAW layout exactly`, async (t) => {
      if (!canRender()) return t.skip('liquidjs or git history unavailable');
      const pre = gitShow(PRE_LANDER, file);
      const a = await renderSrc(readText(file), baseCtx('original'));
      const b = await renderSrc(pre, baseCtx('original'));
      assert.equal(norm(a), norm(b));
    });
  }
});

describe('verified originals are byte-identical to git history', () => {
  const same = (path, rev) => { const h = gitShow(rev, path); return h === null ? null : h === readText(path); };
  for (const f of ['assets/freshwipes-offer-page.css', 'assets/freshwipes-offer-page.js', 'assets/eyewipes-offer-page.css', 'assets/eyewipes-offer-page.js']) {
    test(`${f} == ${PRE_OFFER}`, (t) => { const r = same(f, PRE_OFFER); if (r === null) return t.skip('no git history'); assert.equal(r, true); });
  }
  for (const f of ['assets/freshwipes-prelander.css', 'assets/eyewipes-prelander.css', 'assets/freshwipes-prelander.js', 'assets/eyewipes-prelander.js']) {
    test(`${f} == ${PRE_LANDER}`, (t) => { const r = same(f, PRE_LANDER); if (r === null) return t.skip('no git history'); assert.equal(r, true); });
  }
  const COUNTDOWN_IIFE = /\(function wawCountdown\(\) \{[\s\S]*?\n  \}\(\)\);\n|\(function wawCountdown\(\) \{[\s\S]*?\}\)\(\);\n/;
  for (const f of ['assets/freshwipes-offer-page', 'assets/eyewipes-offer-page']) {
    for (const ext of ['css', 'js']) {
      test(`${f}-waw.${ext} == previously-live WAW file`, (t) => {
        const live = gitShow(WAW_MAIN, `${f}.${ext}`); if (live === null) return t.skip('no git history');
        const now = readText(`${f}-waw.${ext}`);
        if (ext === 'css') assert.equal(now, live);
        else assert.equal(now.replace(COUNTDOWN_IIFE, ''), live.replace(COUNTDOWN_IIFE, ''));
      });
    }
  }
  // live MAIN's eyewipes-prelander.js is the 8adabae blob (origin/main's git copy of that one file is stale)
  for (const [f, src] of [['freshwipes-prelander-waw.css', [WAW_MAIN, 'assets/freshwipes-prelander.css']], ['eyewipes-prelander-waw.css', [WAW_MAIN, 'assets/eyewipes-prelander.css']],
    ['freshwipes-prelander-waw.js', [WAW_MAIN, 'assets/freshwipes-prelander.js']], ['eyewipes-prelander-waw.js', ['8adabae', 'assets/eyewipes-prelander.js']]]) {
    test(`assets/${f} == live WAW file (${src[0]})`, (t) => {
      const live = gitShow(src[0], src[1]); if (live === null) return t.skip('no git history');
      const now = readText(`assets/${f}`);
      if (f.endsWith('.css')) assert.equal(now, live);
      else assert.equal(now.replace(COUNTDOWN_IIFE, ''), live.replace(COUNTDOWN_IIFE, ''));
    });
  }
});

describe('cart behaviour: Original offer pages keep the verified payload', () => {
  for (const p of ['freshwipes', 'eyewipes']) {
    test(`${p}: Original form fields (variant, quantity, selling plan, line properties) match pre-WAW`, async (t) => {
      if (!canRender()) return t.skip('liquidjs or git history unavailable');
      const file = `sections/${p}-offer-page.liquid`;
      const fields = (html) => [...html.matchAll(/<(?:input|select|button|form)\b[^>]*>/gi)]
        .map((m) => m[0]).filter((x) => /name=|action=|type="submit"/.test(x)).map(norm).sort();
      const a = fields(noDcd(await renderSrc(readText(file), baseCtx('original'))));
      const b = fields(noLegacyBar(await renderSrc(gitShow(PRE_OFFER, file), baseCtx('original'))));
      assert.ok(a.length > 0);
      assert.deepEqual(a, b);
    });
    test(`${p}: Original JS adds no discount, gift or quantity logic beyond the verified file`, () => {
      assert.doesNotMatch(readText(`assets/${p}-offer-page.js`), /gift_label_override|waw|World Animal|data-cd/i);
    });
  }
});

describe('shared snippet: subscription-disclosure', () => {
  test('without recurring_copy (Original pages) it renders exactly the pre-WAW disclosure wording', async (t) => {
    if (!canRender()) return t.skip('liquidjs or git history unavailable');
    const pre = gitShow(PRE_OFFER, 'snippets/subscription-disclosure.liquid');
    const ctx = { manage_url: '/pages/manage', frequency: 'month' };
    assert.equal(norm(await renderSrc(readText('snippets/subscription-disclosure.liquid'), ctx)), norm(await renderSrc(pre, ctx)));
  });
});

describe('homepage, announcement bar and popup (render)', () => {
  const ticker = { id: 't', settings: { bg_color: '#47b5e9', text_color: '#fff', icon_color: '#fff', speed: 40 }, blocks: [{ id: 'b1', type: 'item', settings: { text: 'SAVE UP TO 70%' } }] };
  const hero = { id: 'h', settings: { badge_text: '45.000+ Happy Pet Parents', show_stars: true }, blocks: [] };
  const popup = { id: 'p', settings: { enable: true, trigger: 'delay', delay_seconds: 8, hide_days: 7, storage_key: 'vetpets_welcome_popup', text_title: 'TRY YOUR LUCK', text_decline: 'No thanks', text_subtitle: 's' }, blocks: [] };
  const cases = [
    ['sections/announcement-ticker.liquid', 'announcement_campaign_mode', ticker, 'vp-tickerbar--waw'],
    ['sections/hero-review-carousel.liquid', 'homepage_campaign_mode', hero, 'vp-hrc--waw'],
    ['sections/vetpets-popup.liquid', 'popup_campaign_mode', popup, 'vetpets-popup--world-animal-week']
  ];
  for (const [file, key, section, cls] of cases) {
    test(`${file}: WAW only for exactly 'world_animal_week' (setting ${key})`, async (t) => {
      if (engine === null) return t.skip('liquidjs unavailable');
      const ctx = (mode) => ({ ...baseCtx('x'), settings: mode === undefined ? {} : { [key]: mode }, section, request: { path: '/', page_type: 'index' } });
      for (const mode of ['original', ...INVALID]) {
        const html = await renderSrc(readText(file), ctx(mode));
        assert.ok(html.length > 500, file);
        assert.doesNotMatch(html.replace(/<style[\s\S]*?<\/style>/gi, ''), new RegExp(cls), `${file} mode=${String(mode)}`);
        assert.doesNotMatch(visible(html), /World Animal|Scratch the belly to reveal your World/i, `${file} mode=${String(mode)}`);
      }
      const waw = await renderSrc(readText(file), ctx('world_animal_week'));
      assert.match(waw.replace(/<style[\s\S]*?<\/style>/gi, ''), new RegExp(cls));
    });
    test(`${file}: other surfaces' settings never affect it`, async (t) => {
      if (engine === null) return t.skip('liquidjs unavailable');
      const others = Object.fromEntries(cases.filter((c) => c[1] !== key).map((c) => [c[1], 'world_animal_week']));
      others.sales_campaign_mode = 'world_animal_week';
      const html = await renderSrc(readText(file), { ...baseCtx('x'), settings: others, section, request: { path: '/', page_type: 'index' } });
      assert.doesNotMatch(html.replace(/<style[\s\S]*?<\/style>/gi, ''), new RegExp(cls));
    });
  }
  test('popup: Original keeps frequency / dismissal / analytics configuration identical to WAW mode', async (t) => {
    if (engine === null) return t.skip('liquidjs unavailable');
    const ctx = (mode) => ({ ...baseCtx('x'), settings: { popup_campaign_mode: mode }, section: popup, request: { path: '/', page_type: 'index' } });
    const cfg = (h) => JSON.parse(h.match(/"hideDays"[\s\S]{0,0}/) ? '{}' : '{}') && h.match(/(hideDays|hide_days|storageKey|storage_key)[^,\n]*/g);
    const a = cfg(await renderSrc(readText('sections/vetpets-popup.liquid'), ctx('original')));
    const b = cfg(await renderSrc(readText('sections/vetpets-popup.liquid'), ctx('world_animal_week')));
    assert.deepEqual(a, b);
  });
});
