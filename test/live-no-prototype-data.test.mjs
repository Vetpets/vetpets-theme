/**
 * Live mode must contain no prototype identity.
 *
 * The defect these tests exist for: the sign-in input shipped with
 * `value="margaret.ellis@gmail.com"`. A real customer arriving from a real
 * magic link had to select and delete a fictional stranger's address before
 * typing their own.
 *
 * Two separate guarantees, tested separately because either alone is weak:
 *
 *   1. the MARKUP carries no prefilled value and no prototype identity outside
 *      a [data-spp-field] slot — checked against the Liquid sources, so a
 *      future edit that reintroduces one fails here;
 *   2. the CONTROLLER blanks every slot and every form field in live mode —
 *      checked by running clearPlaceholders() against a stand-in DOM.
 *
 * Run with:  node --test test/live-no-prototype-data.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const snippets = resolve(here, '..', 'snippets');

const authSource = readFileSync(resolve(snippets, 'spp-screen-auth.liquid'), 'utf8');
const controllerSource = readFileSync(
  resolve(here, '..', 'assets', 'subscription-portal.js'),
  'utf8',
);

/** Every portal snippet, which together are the whole rendered portal. */
function portalSnippets() {
  return readdirSync(snippets)
    .filter((f) => f.startsWith('spp-') && f.endsWith('.liquid'))
    .map((f) => ({ name: f, source: readFileSync(resolve(snippets, f), 'utf8') }));
}

/** The sign-in input's attributes, parsed out of the Liquid. */
function loginInput() {
  const match = /<input\b[^>]*id="spp-email"[^>]*>/s.exec(authSource);
  assert.ok(match, 'the sign-in input must exist');
  const tag = match[0];
  return {
    tag,
    attr(name) {
      const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
      return m ? m[1] : null;
    },
    has(name) {
      return new RegExp(`\\b${name}[\\s=>]`).test(tag);
    },
  };
}

describe('live login field', () => {
  test('has no value attribute at all, so it starts genuinely empty', () => {
    const input = loginInput();

    assert.equal(input.attr('value'), null);
    assert.equal(input.has('value'), false);
  });

  test('carries no prototype address anywhere in the sign-in markup outside a slot', () => {
    // The "we sent a link to X" line is a [data-spp-field] slot, which the
    // controller blanks in live mode. Anything NOT in a slot is permanent.
    const withoutSlots = authSource.replace(
      /<([a-z]+)\b[^>]*data-spp-field(-html)?="[^"]*"[^>]*>.*?<\/\1>/gs,
      '<slot></slot>',
    );

    assert.ok(!/margaret/i.test(withoutSlots));
    assert.ok(!/gmail\.com/i.test(withoutSlots));
  });

  test('uses a placeholder, not a value', () => {
    const input = loginInput();

    assert.equal(input.attr('placeholder'), 'you@example.com');
  });

  test('is typed and configured for entering an email on a phone', () => {
    const input = loginInput();

    assert.equal(input.attr('type'), 'email');
    assert.equal(input.attr('inputmode'), 'email');
    assert.equal(input.attr('autocomplete'), 'email');
    assert.equal(input.attr('autocapitalize'), 'none');
    assert.equal(input.attr('spellcheck'), 'false');
  });
});

describe('no prototype identity survives into live mode', () => {
  // Names, addresses, cards and references invented for the mock adapter.
  const PROTOTYPE = [
    /margaret/i,
    /ellis/i,
    /gmail\.com/i,
    /\bbella\b/i,
    /french bulldog/i,
    /labrador/i,
    /wren street/i,
    /portland/i,
    /4242/,
    /#VP-\d+/,
    /\$62\.73/,
  ];

  test('every prototype value in the markup sits inside a slot the controller blanks', () => {
    const offenders = [];

    for (const { name, source } of portalSnippets()) {
      // Remove the contents of every data-spp-field / data-spp-field-html
      // element: those are placeholders, and live mode empties them.
      const withoutSlots = source.replace(
        /<([a-z]+)\b[^>]*data-spp-field(-html)?="[^"]*"[^>]*>.*?<\/\1>/gs,
        '<slot></slot>',
      );

      for (const pattern of PROTOTYPE) {
        if (pattern.test(withoutSlots)) {
          offenders.push(`${name}: ${pattern}`);
        }
      }
    }

    assert.deepEqual(offenders, [], `prototype data outside a blankable slot:\n  ${offenders.join('\n  ')}`);
  });

  test('the controller writes no prototype identity into a slot', () => {
    // render() fills [data-spp-field] slots from the view model, so anything
    // the CONTROLLER names reaches live mode even though clearPlaceholders
    // blanked the markup first. Comments are stripped before checking.
    const code = controllerSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    for (const pattern of [/margaret/i, /ellis/i, /\bbella\b/i, /gmail\.com/i]) {
      assert.ok(!pattern.test(code), `controller must not emit ${pattern}`);
    }
  });

  test('clearPlaceholders empties slots AND form fields', () => {
    const slot = { textContent: 'Margaret' };
    const htmlSlot = { textContent: 'Margaret Ellis<br>214 Wren Street' };
    const input = {
      value: 'margaret.ellis@gmail.com',
      removed: [],
      removeAttribute(name) {
        this.removed.push(name);
      },
    };
    const removedChildren = [];
    const demoButton = { parentNode: { removeChild: (n) => removedChildren.push(n) } };

    // Minimal stand-in for the portal root.
    const root = {
      querySelectorAll(selector) {
        if (selector.indexOf('data-spp-mock-only') !== -1) return [demoButton];
        if (selector.indexOf('data-spp-field') !== -1) return [slot, htmlSlot];
        if (selector.indexOf('template') !== -1) return [];
        if (selector.indexOf('input') !== -1) return [input];
        return [];
      },
    };

    // Call the real implementation, extracted from the shipped controller.
    const body = /Portal\.prototype\.clearPlaceholders = function \(\) \{([\s\S]*?)\n  \};/.exec(
      controllerSource,
    );
    assert.ok(body, 'clearPlaceholders must exist in the controller');
    const clearPlaceholders = new Function('self', body[1].replace(/this\./g, 'self.'));

    clearPlaceholders({ root });

    assert.equal(slot.textContent, '');
    assert.equal(htmlSlot.textContent, '');
    assert.equal(input.value, '');
    assert.ok(input.removed.includes('value'));
    // Prototype-only controls are removed from the document, not just hidden.
    assert.deepEqual(removedChildren, [demoButton]);
  });

  test('the demo shortcut and mock resend are marked mock-only', () => {
    const auth = readFileSync(resolve(snippets, 'spp-screen-auth.liquid'), 'utf8');

    for (const act of ['openLink', 'resend']) {
      const tag = new RegExp(`<button\\b[^>]*data-spp-act="${act}"[^>]*>`).exec(auth);
      assert.ok(tag, `the ${act} button must exist`);
      assert.match(tag[0], /data-spp-mock-only/, `${act} must not survive into live mode`);
    }
  });

  test('the controller clears placeholders before anything renders in live mode', () => {
    assert.ok(
      /if \(this\.cfg\.mode === 'live'\) this\.clearPlaceholders\(\);/.test(controllerSource),
    );
  });
});

describe('live error reference', () => {
  test('stamps the real date in live mode, never the prototype date', () => {
    const match = /Portal\.prototype\.buildReference = function \(err\) \{([\s\S]*?)\n  \};/.exec(
      controllerSource,
    );
    assert.ok(match, 'buildReference must exist');
    const body = match[1];

    // Live takes the current date; only mock may use the frozen prototype date.
    assert.ok(/mode === 'live'/.test(body));
    assert.ok(/new Date\(\)/.test(body));

    // cfg.today must not be reachable without the live check in front of it.
    const todayUse = body.indexOf('this.cfg.today');
    const liveCheck = body.indexOf("mode === 'live'");
    assert.ok(liveCheck !== -1 && liveCheck < todayUse);
  });

  test('no prototype date is hardcoded into the error path', () => {
    assert.ok(!/2026-08-21/.test(/buildReference[\s\S]{0,600}/.exec(controllerSource)[0]));
  });
});
