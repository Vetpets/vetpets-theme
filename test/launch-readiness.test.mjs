/**
 * Launch readiness.
 *
 * Two rules a customer-facing portal must not break, checked across the whole
 * of it rather than screen by screen:
 *
 *   1. No internal identifier from Phoenix ever reaches a customer.
 *   2. Nothing claims a fact the system cannot back — above all a VetPoints
 *      balance, for which no ledger, no catalogue and no redemption exist.
 *
 * Run with:  node --test test/launch-readiness.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(resolve(here, '..', ...p), 'utf8');

const src = read('assets', 'subscription-portal.js');
const adapter = read('assets', 'subscription-portal-adapter.js');

/**
 * Every portal snippet, with Liquid comments stripped — comments never ship.
 *
 * The dev switcher is excluded from CUSTOMER-facing checks: it ships hidden
 * and is revealed only when spp_dev=1 AND the adapter is in mock mode, so no
 * customer can reach it. A separate test holds that gate in place.
 */
const DEV_ONLY = 'spp-dev-switcher.liquid';

const PORTAL_SNIPPETS = readdirSync(resolve(here, '..', 'snippets'))
  .filter((f) => f.startsWith('spp-') && f.endsWith('.liquid') && f !== DEV_ONLY)
  .map((f) => ({
    name: f,
    markup: read('snippets', f).replace(
      /\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g,
      '',
    ),
  }));

const SECTION = read('sections', 'subscription-portal.liquid').replace(
  /\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g,
  '',
);

function constant(name) {
  const m = new RegExp(`var ${name} = ([^;]+);`).exec(src);
  assert.ok(m, `${name} must exist`);
  return new Function(`return ${m[1]}`)();
}

/* ================================================================== */

describe('no internal Phoenix identifier reaches a customer', () => {
  test('no portal snippet binds the subscription reference', () => {
    for (const { name, markup } of PORTAL_SNIPPETS) {
      assert.ok(
        !/data-spp-field="subscription\.reference"/.test(markup),
        `${name} still renders Phoenix's subscription id`,
      );
      assert.ok(
        !/data-spp-field="reference"/.test(markup),
        `${name} still renders a raw reference`,
      );
    }
  });

  test('no portal snippet emits a CustomerId', () => {
    for (const { name, markup } of PORTAL_SNIPPETS) {
      assert.ok(!/customerId/i.test(markup), `${name} must not mention a CustomerId`);
      assert.ok(!/phoenix/i.test(markup), `${name} must not name the billing vendor`);
    }
  });

  test('the section emits no vendor name, id or credential', () => {
    assert.ok(!/phoenix/i.test(SECTION));
    assert.ok(!/customerId/i.test(SECTION));
    assert.ok(!/partnerToken|apiToken|Bearer/i.test(SECTION));
  });

  test('the subscription id is still available to the SERVER path', () => {
    // Removed from the customer's view, not from the system: ownership checks
    // still compare it, and the adapter still forwards an opaque reference.
    assert.match(adapter, /subscriptionId/, 'the adapter still models it');
  });
});

describe('VetPoints is hidden, not half-built', () => {
  test('the switch is off', () => {
    assert.equal(constant('LOYALTY_ENABLED'), false);
  });

  test('every loyalty surface is marked and hidden by default', () => {
    const marked = PORTAL_SNIPPETS.filter((s) => /data-spp-loyalty/.test(s.markup));
    assert.ok(marked.length >= 4, 'the card, the account row, the nav and more');

    for (const { name, markup } of marked) {
      const tags = markup.match(/<[^>]*data-spp-loyalty[^>]*>/g) || [];
      for (const tag of tags) {
        assert.match(tag, /\bhidden\b/, `${name}: a loyalty element must ship hidden`);
      }
    }
  });

  test('the controller hides them on every render', () => {
    assert.match(src, /applyLoyaltyVisibility/);
    const m = /Portal\.prototype\.applyLoyaltyVisibility[\s\S]*?\n  \};/.exec(src);
    assert.ok(m);
    assert.match(m[0], /hidden = !LOYALTY_ENABLED/);
    // And it runs as part of render, not only at boot.
    const render = /Portal\.prototype\.render = function[\s\S]*?\n  \};/.exec(src);
    assert.ok(render);
    assert.match(render[0], /applyLoyaltyVisibility\(\)/);
  });

  test('the loyalty screen is unreachable, not merely unlinked', () => {
    const m = /Portal\.prototype\.show = function[\s\S]*?\n  \};/.exec(src);
    assert.ok(m);
    assert.match(m[0], /DISABLED_SCREENS\[screen\]/, 'a deep link must be redirected');
    const disabled = new Function(
      'LOYALTY_ENABLED',
      `return ${/var DISABLED_SCREENS = ([^;]+);/.exec(src)[1]}`,
    )(false);
    assert.deepEqual(disabled, { loyalty: 1 });
  });

  test('no points balance is claimed anywhere a customer can read', () => {
    /*
     * Remove every hidden loyalty element together with its whole subtree,
     * then look at what is left. A nested check is what this needs: the card's
     * "VetPoints" badge sits several elements inside the hidden wrapper and is
     * perfectly invisible, so a line-proximity test would either fail on it or
     * be loose enough to miss a real leak.
     */
    const stripLoyalty = (html) => {
      let out = html;
      for (;;) {
        const open = /<(\w+)([^>]*\bdata-spp-loyalty\b[^>]*)>/.exec(out);
        if (!open) return out;

        const tag = open[1];
        const selfClosing = /\/>$/.test(open[0]);
        if (selfClosing) {
          out = out.slice(0, open.index) + out.slice(open.index + open[0].length);
          continue;
        }

        // Walk forward counting nested tags of the same name.
        const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
        re.lastIndex = open.index + open[0].length;
        let depth = 1;
        let end = -1;
        for (let m = re.exec(out); m; m = re.exec(out)) {
          depth += m[0][1] === '/' ? -1 : 1;
          if (depth === 0) {
            end = m.index + m[0].length;
            break;
          }
        }
        assert.ok(end > -1, `unbalanced <${tag}> around a loyalty element`);
        out = out.slice(0, open.index) + out.slice(end);
      }
    };

    for (const { name, markup } of PORTAL_SNIPPETS) {
      // The loyalty screen itself is unreachable — show() redirects it.
      if (name === 'spp-screen-loyalty.liquid') continue;

      const visible = stripLoyalty(markup);
      assert.ok(
        !/VetPoints/.test(visible),
        `${name} shows VetPoints outside a hidden element:\n` +
          (visible.split('\n').filter((l) => /VetPoints/.test(l)).join('\n')),
      );
    }
  });

  test('the cancellation consequences make no points promise', () => {
    const m = /case 'cancelFacts':[\s\S]*?\n      \}/.exec(src);
    assert.ok(m);
    assert.ok(!/VetPoints/.test(m[0]), 'no balance may be asserted on cancellation');
  });

  test('the skip sheet asserts no earning rule', () => {
    const sheets = PORTAL_SNIPPETS.find((s) => s.name === 'spp-sheets.liquid').markup;
    const line = /A skipped delivery[^<]*/.exec(sheets);
    if (line) {
      // If the claim survives at all it must be inside the hidden span.
      assert.match(sheets, /<span data-spp-loyalty hidden>A skipped delivery/);
    }
  });
});

describe('live mode shows no prototype data', () => {
  test('the demo persona cannot reach live mode', () => {
    // The mock adapter owns the fictional customer; the live adapter must
    // never fall back to it.
    const liveSection = adapter.slice(adapter.indexOf('createLiveAdapter'));
    assert.ok(
      !/margaret\.ellis/.test(liveSection),
      'the live adapter must not carry the demo persona',
    );
  });

  test('live mode counts from the real calendar, not the frozen prototype date', () => {
    assert.match(src, /mode === 'live' \? NS\.dates\.toISO\(new Date\(\)\)/);
  });

  test('no invented balance can be rendered: loyalty is off', () => {
    assert.equal(constant('LOYALTY_ENABLED'), false);
  });
});

describe('the mutation surface is complete and guarded', () => {
  const OPERATIONS = ['skip', 'delay', 'reschedule', 'cancel', 'reactivate'];

  test('all five operations exist in the adapter', () => {
    for (const op of ['skipNextDelivery', 'delayNextDelivery', 'rescheduleNextDelivery', 'cancel', 'reactivate']) {
      assert.match(adapter, new RegExp(`${op}: function`), `${op} must exist`);
    }
  });

  test('every confirmed action is covered by the one-shot guard', () => {
    const guard = constant('CONFIRMED_ACTIONS');
    for (const op of OPERATIONS) {
      assert.equal(guard[op], 1, `${op} must be guarded against a second submission`);
    }
  });

  test('no unsupported operation is offered anywhere', () => {
    for (const { name, markup } of PORTAL_SNIPPETS) {
      for (const forbidden of ['data-spp-act="pause"', 'data-spp-act="resume"', 'data-spp-act="frequency"', 'data-spp-act="swap"', 'data-spp-act="quantity"']) {
        assert.ok(!markup.includes(forbidden), `${name} offers ${forbidden}, which Phoenix cannot do`);
      }
    }
  });
});

describe('the dev switcher can never reach a customer', () => {
  const dev = readFileSync(resolve(here, '..', 'snippets', 'spp-dev-switcher.liquid'), 'utf8');

  test('it ships hidden', () => {
    assert.match(dev, /data-spp-dev\b[^>]*hidden|hidden[^>]*data-spp-dev\b/);
  });

  test('it is revealed only in MOCK mode, never live', () => {
    const m = /spp_dev.*?\n?.*?mode === 'mock'/.exec(src);
    assert.ok(m, 'the reveal must require mock mode as well as the flag');
  });
});

describe('responsive rendering', () => {
  const css = read('assets', 'subscription-portal.css');

  test('the layout adapts rather than assuming a desktop', () => {
    const queries = css.match(/@media[^{]+\{/g) || [];
    assert.ok(queries.length >= 2, 'there must be real breakpoints');
    assert.ok(
      /max-width|min-width/.test(queries.join(' ')),
      'breakpoints must be width-based',
    );
  });

  test('nothing forces a horizontal scroll', () => {
    // A max-width caps a wide screen and is fine. A bare `width` in the
    // thousands is what pushes a phone sideways.
    const bare = css.match(/(^|[^-])\bwidth:\s*\d{4,}px/g) || [];
    assert.deepEqual(bare, [], `fixed widths force a horizontal scroll: ${bare}`);
  });

  test('tap targets stay finger-sized', () => {
    const m = /\.spp__btn\s*\{[^}]*\}/.exec(css);
    assert.ok(m, '.spp__btn must exist');
    assert.match(m[0], /min-height:\s*(4[4-9]|[5-9]\d)px/, 'at least 44px');
  });
});
