/**
 * What the real dashboard renders: greeting, relative dates, product images.
 *
 * Each of these shipped wrong to a real customer:
 *   - "Hi" with no name, because the greeting was split across two nodes and
 *     live mode blanks slots before rendering;
 *   - "34 days away" for a delivery 25 days out, because the live adapter was
 *     handed the prototype's frozen date;
 *   - an empty image box, because the backend has no catalogue and the theme
 *     was never asked for one.
 *
 * Run with:  node --test test/dashboard-data.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const controllerSource = readFileSync(
  resolve(here, '..', 'assets', 'subscription-portal.js'),
  'utf8',
);
const adapterSource = readFileSync(
  resolve(here, '..', 'assets', 'subscription-portal-adapter.js'),
  'utf8',
);
const sectionSource = readFileSync(
  resolve(here, '..', 'sections', 'subscription-portal.liquid'),
  'utf8',
);
const dashboardSource = readFileSync(
  resolve(here, '..', 'snippets', 'spp-screen-dashboard.liquid'),
  'utf8',
);

/** Load the adapter in a sandbox and hand back its namespace. */
function loadNS() {
  const win = {
    document: { querySelector: () => null },
    location: { search: '', pathname: '/', hash: '' },
    history: { state: null, replaceState() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    URLSearchParams,
    fetch: () => Promise.reject(new Error('no network in tests')),
  };
  const ctx = vm.createContext({ window: win, URLSearchParams, JSON, Promise, Math, Date, console });
  vm.runInContext(adapterSource, ctx);
  return win.VetPetsPortal;
}

const NS = loadNS();

/** Lift one `Portal.prototype.<name>` out of the shipped controller. */
function method(name) {
  const re = new RegExp(
    `Portal\\.prototype\\.${name} = function \\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\};`,
  );
  const m = re.exec(controllerSource);
  assert.ok(m, `Portal.prototype.${name} must exist`);
  // The view-model closes over module-scope constants from the cancellation
  // journey; supply them so the extracted function runs as it does in the file.
  const constant = (cname) => {
    const cm = new RegExp(`var ${cname} = ([\\s\\S]*?);\\n`).exec(controllerSource);
    return cm ? new Function(`return ${cm[1]}`)() : undefined;
  };
  return new Function(
    'NS',
    'REASONS',
    'OFFER_PERCENT',
    'STANDARD_PERCENT',
    `return function (${m[1]}) {${m[2]}\n};`,
  )(NS, constant('REASONS'), constant('OFFER_PERCENT'), constant('STANDARD_PERCENT'));
}

const viewModel = method('viewModel');
const imageMap = method('imageMap');
const imageForLine = method('imageForLine');
const lineImage = method('lineImage');

/* ------------------------------------------------------------------ */

describe('greeting', () => {
  /** Just enough of the controller for viewModel() to run. */
  function portalWith(customer) {
    return {
      state: {
        customer,
        data: null,
        loyalty: null,
        draft: { delay: 7, reason: 'price', restart: 0 },
        inactive: [],
        error: null,
        success: null,
        pending: null,
      },
      cfg: { mode: 'live', locale: 'en', today: '2026-08-21' },
      fmtDate: () => '',
      fmtMoney: () => '',
      escape: (s) => s,
    };
  }

  test('renders "Hi, {firstName}" when Phoenix supplies one', () => {
    const vm = viewModel.call(portalWith({ firstName: 'Emily' }));
    assert.equal(vm['customer.greeting'], 'Hi, Emily');
  });

  test('renders "Hi there" — never a bare "Hi" — when there is no name', () => {
    for (const customer of [
      { firstName: null },
      { firstName: '' },
      { firstName: undefined },
      {},
      null,
    ]) {
      const vm = viewModel.call(portalWith(customer));
      assert.equal(vm['customer.greeting'], 'Hi there', `for ${JSON.stringify(customer)}`);
      assert.ok(!/^Hi$/.test(vm['customer.greeting']));
      assert.ok(!/Hi,\s*$/.test(vm['customer.greeting']), 'no dangling comma');
    }
  });

  test('the markup carries the whole greeting in one slot', () => {
    // Split across two nodes, live mode blanks the name and leaves "Hi".
    assert.match(dashboardSource, /data-spp-field="customer\.greeting"/);
    assert.ok(!/Hi <span data-spp-field="customer\.firstName"/.test(dashboardSource));
  });

  test('the greeting never contains an email address', () => {
    const vm = viewModel.call(portalWith({ firstName: 'Emily', email: 'a@b.com' }));
    assert.ok(!vm['customer.greeting'].includes('@'));
  });
});

describe('relative delivery dates', () => {
  test('Aug 30 to Sep 24 is 25 days, across the month boundary', () => {
    assert.equal(NS.dates.daysBetween('2026-08-30', '2026-09-24'), 25);
  });

  test('counts calendar days across month and year boundaries', () => {
    const cases = [
      ['2026-08-30', '2026-09-24', 25],
      ['2026-08-31', '2026-09-01', 1],
      ['2026-01-31', '2026-03-01', 29], // 2026 is not a leap year
      ['2024-02-28', '2024-03-01', 2], // 2024 is
      ['2026-12-31', '2027-01-01', 1],
      ['2026-09-24', '2026-09-24', 0],
    ];
    for (const [from, to, expected] of cases) {
      assert.equal(NS.dates.daysBetween(from, to), expected, `${from} -> ${to}`);
    }
  });

  test('is negative for a date already past, so the UI can clamp it', () => {
    assert.equal(NS.dates.daysBetween('2026-09-24', '2026-08-30'), -25);
  });

  test('survives a daylight-saving transition, where a day is 23 or 25 hours', () => {
    // Europe/Stockholm springs forward 2026-03-29 and falls back 2026-10-25.
    assert.equal(NS.dates.daysBetween('2026-03-28', '2026-03-30'), 2);
    assert.equal(NS.dates.daysBetween('2026-10-24', '2026-10-26'), 2);
    // A whole month spanning the change still counts calendar days.
    assert.equal(NS.dates.daysBetween('2026-03-01', '2026-04-01'), 31);
  });

  test('toISO returns the LOCAL calendar day, not a UTC-shifted one', () => {
    // 23:30 local on the 30th is still the 30th, whatever UTC says.
    const late = new Date(2026, 7, 30, 23, 30, 0);
    assert.equal(NS.dates.toISO(late), '2026-08-30');
    const early = new Date(2026, 7, 30, 0, 15, 0);
    assert.equal(NS.dates.toISO(early), '2026-08-30');
  });

  test('the live adapter is given the real date, never the prototype date', () => {
    // Controller side: live passes today from the clock.
    assert.match(
      controllerSource,
      /today: this\.cfg\.mode === 'live' \? NS\.dates\.toISO\(new Date\(\)\) : this\.cfg\.today/,
    );
    // Adapter side: even with nothing passed, it does not fall back to null
    // and silently return 0 days.
    assert.match(adapterSource, /var today = opts\.today \|\| VetPetsPortal\.dates\.toISO\(new Date\(\)\)/);
  });

  test('mock mode keeps its configured prototype date', () => {
    assert.match(controllerSource, /: this\.cfg\.today/);
    assert.match(controllerSource, /today: d\.sppToday \|\| '2026-08-21'/);
  });
});

describe('product images', () => {
  const MAP = {
    '10549270642955': { src: 'https://cdn.shopify.com/x/fresh.jpg', alt: 'FreshWipes Plaque Relief Kit' },
    '53248860389643': { src: 'https://cdn.shopify.com/x/variant.jpg', alt: 'FreshWipes variant' },
  };

  function portalWithMap(json) {
    return {
      root: {
        querySelector: (sel) =>
          sel === '[data-spp-image-map]' ? { textContent: json } : null,
      },
      imageMap() {
        return imageMap.call(this);
      },
      imageForLine(line) {
        return imageForLine.call(this, line);
      },
    };
  }

  test('resolves a line by its Shopify product id', () => {
    const p = portalWithMap(JSON.stringify(MAP));
    const hit = p.imageForLine({ productId: '10549270642955', variantId: null, id: null });
    assert.equal(hit.src, 'https://cdn.shopify.com/x/fresh.jpg');
  });

  test('prefers the variant image when the map has one', () => {
    const p = portalWithMap(JSON.stringify(MAP));
    const hit = p.imageForLine({ productId: '10549270642955', variantId: '53248860389643' });
    assert.equal(hit.src, 'https://cdn.shopify.com/x/variant.jpg');
  });

  test('accepts a numeric id, because Phoenix sends numbers', () => {
    const p = portalWithMap(JSON.stringify(MAP));
    const hit = p.imageForLine({ productId: 10549270642955, variantId: null });
    assert.equal(hit.src, 'https://cdn.shopify.com/x/fresh.jpg');
  });

  test('never guesses: an unknown id resolves to nothing', () => {
    const p = portalWithMap(JSON.stringify(MAP));
    assert.equal(p.imageForLine({ productId: '999', variantId: '888' }), null);
    assert.equal(p.imageForLine({}), null);
    assert.equal(p.imageForLine(null), null);
  });

  test('a missing or malformed map is survivable, not fatal', () => {
    assert.deepEqual(portalWithMap('not json at all').imageMap(), {});
    assert.deepEqual(
      portalWithMap(JSON.stringify({ '1': { alt: 'no src' } })).imageMap(),
      {},
      'an entry with no src is not a usable image',
    );
    const none = {
      root: { querySelector: () => null },
      imageMap() {
        return imageMap.call(this);
      },
    };
    assert.deepEqual(none.imageMap(), {});
  });

  test('an unresolved line falls back to the branded pending tile, with a label', () => {
    const p = portalWithMap(JSON.stringify(MAP));
    p.lineImage = function (line) {
      return lineImage.call(this, line);
    };

    const missing = p.lineImage({ productId: '999', title: 'FreshWipes Plaque Relief Kit' });
    assert.equal(missing._pending, true, 'renders the branded packshot tile, not a broken image');
    assert.equal(missing._image, '');
    assert.equal(missing._alt2, 'FreshWipes Plaque Relief Kit', 'the tile is still labelled');

    const found = p.lineImage({ productId: '10549270642955', title: 'FreshWipes Plaque Relief Kit' });
    assert.equal(found._pending, false);
    assert.equal(found._image, 'https://cdn.shopify.com/x/fresh.jpg');
    assert.ok(found._alt2.length > 0, 'a rendered image must carry alt text');
  });

  test('mock mode keeps using the image already on the line', () => {
    const p = portalWithMap(JSON.stringify(MAP));
    p.lineImage = function (line) {
      return lineImage.call(this, line);
    };
    const mock = p.lineImage({ image: '//cdn/mock.jpg', title: 'FreshWipes jar' });
    assert.equal(mock._image, '//cdn/mock.jpg');
    assert.equal(mock._pending, false);
  });

  test('the section emits the map, and the adapter carries the ids to reach it', () => {
    assert.match(sectionSource, /data-spp-image-map/);
    assert.match(sectionSource, /"\{\{ p_fresh\.id \}\}"/);
    // The adapter must pass productId/variantId through, or the map is unusable.
    assert.match(adapterSource, /productId: l\.productId \|\| null/);
    assert.match(adapterSource, /variantId: l\.variantId \|\| null/);
  });

  test('a rendered image reserves its box and carries alt text', () => {
    const fill = /Portal\.prototype\.fillNode[\s\S]*?\n  \};/.exec(controllerSource)[0];
    assert.match(fill, /img\.alt = item\._alt2/);
    assert.match(fill, /setAttribute\('width', '64'\)/);
    assert.match(fill, /setAttribute\('height', '64'\)/);
  });
});
