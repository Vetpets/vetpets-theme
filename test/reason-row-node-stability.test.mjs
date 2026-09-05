/**
 * The reason list must not destroy and rebuild its rows on every pick.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * Live reproduction in the DEV browser (Claude in Chrome, theme
 * 181692858635) found that individual reason clicks always set the right
 * value — the earlier severed if/else-if chain (see cancel-flow.test.mjs,
 * "every branch of pick still assigns") stayed fixed. What was still broken:
 * `renderLists()` removed every one of the 8 reason rows and re-appended
 * fresh clones on every single `pick()`, even though only one row's checked
 * state had changed. Instrumenting the real removeChild/appendChild calls in
 * the browser showed `document.documentElement.scrollHeight` collapsing to
 * the viewport height mid-removal, which the browser answers by clamping
 * `window.scrollY` to 0 — a jump the customer never asked for. A customer
 * scrolled down to a lower reason who then reconsiders and clicks a
 * different row finds the page already snapped back to the top, so their
 * next click lands on whatever is now under an unmoved pointer: an earlier
 * row, the gap between cards, or nothing. That reads exactly like "6 of 8
 * reason rows don't reliably select."
 *
 * The earlier synthetic harness in cancel-flow.test.mjs ("a reason row can
 * actually be selected") could not have caught this: its `render()` is a
 * hand-written stand-in that mutates existing rows and never calls the real
 * `renderLists`, so it behaves as though already fixed. This file drives the
 * actual shipped `renderLists` and `fillNode` instead, through a DOM shim
 * that implements real node identity (removeChild/appendChild/cloneNode),
 * so a regression to the destroy-and-rebuild path fails these tests.
 *
 * Run with:  node --test test/reason-row-node-stability.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(resolve(here, '..', ...p), 'utf8');

const src = read('assets', 'subscription-portal.js');

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
  const m = new RegExp(
    `var ${name} = (\\{[\\s\\S]*?\\}|\\[[\\s\\S]*?\\]|\\d+);`,
  ).exec(src);
  assert.ok(m, `${name} must exist`);
  return new Function(`return ${m[1]}`)();
}

// The real functions implicated in the investigation — nothing reimplemented.
const listData = method('listData', ['REASONS', 'GAP_OPTIONS'], [constant('REASONS'), constant('GAP_OPTIONS')]);
const fillNode = method('fillNode');
const renderLists = method('renderLists');
const renderCancelJourney = method('renderCancelJourney');
const pick = method('pick');
const REASON_MODEL = constant('REASONS');
const idxOf = (code) => REASON_MODEL.findIndex((r) => r[0] === code);

/**
 * A minimal DOM shim with REAL node identity: removeChild/appendChild
 * actually mutate a live `children` array and cloneNode produces a genuinely
 * new object. This is the property the browser bug hinges on, so the shim
 * has to model it rather than paper over it the way a hand-mutated stand-in
 * would.
 */
function makeEl(tag, attrs = {}) {
  const node = {
    tag,
    attrs: { ...attrs },
    dataset: {},
    textContent: '',
    hidden: false,
    children: [],
    parent: null,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    hasAttribute(n) { return n in this.attrs; },
    removeAttribute(n) { delete this.attrs[n]; },
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      assert.ok(i > -1, 'removeChild: node is not a child of this element');
      this.children.splice(i, 1);
      child.parent = null;
      return child;
    },
    matches(sel) {
      // Supports a comma-separated list of simple attribute selectors, which
      // is all fillNode's `'[data-spp-pick], [data-spp-act]'` needs.
      return sel.split(',').some((part) => {
        const s = part.trim();
        const m = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(s);
        assert.ok(m, `unsupported selector in test shim: ${s}`);
        const [, name, want] = m;
        if (!(name in this.attrs)) return false;
        return want === undefined || this.attrs[name] === want;
      });
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
    cloneNode(deep) {
      const copy = makeEl(this.tag, this.attrs);
      copy.dataset = { ...this.dataset };
      copy.textContent = this.textContent;
      if (deep) for (const c of this.children) copy.appendChild(c.cloneNode(true));
      return copy;
    },
  };
  return node;
}

/** The real reason-row markup (button > radio span + labelled span). */
function reasonRowTemplate() {
  const row = makeEl('button', {
    type: 'button', class: 'spp__choice', role: 'radio',
    'aria-checked': 'false', 'data-spp-pick': 'reason',
  });
  row.appendChild(makeEl('span', { class: 'spp__radio' }));
  row.appendChild(makeEl('span', { 'data-spp-field': 'label' }));
  return row;
}

/** Mounts the reason list exactly as `render()` would on first paint. */
function mountReasonList(initialReason = null) {
  const root = makeEl('div', { 'data-spp-root': '' });
  const host = makeEl('div', { 'data-spp-list': 'reasons', role: 'radiogroup' });
  root.appendChild(host);

  const tpl = makeEl('template', { 'data-spp-tpl': 'reasons' });
  tpl.content = { firstElementChild: reasonRowTemplate() };
  host.appendChild(tpl);

  const note = root.appendChild(makeEl('div', { 'data-spp-reason-note': '' }));
  note.hidden = true;

  const portal = {
    root,
    state: { draft: { reason: initialReason, note: '' }, reasonError: null },
    listData,
    fillNode,
    reasonProblem: () => (portal.state.draft.reason ? null : 'Choose a reason so we can continue.'),
    render() { this.renderLists(); this.renderCancelJourney(); },
    renderLists,
    renderCancelJourney,
    pick,
  };

  portal.render();
  return { portal, root, host, tpl, note };
}

/** The reason rows currently mounted under the host, in list order. */
function rowsOf(host, tpl) {
  return host.children.filter((c) => c !== tpl);
}

describe('reason rows are updated in place, not destroyed and rebuilt', () => {
  test('first render mounts exactly the 8 reason rows', () => {
    const { host, tpl } = mountReasonList();
    assert.equal(rowsOf(host, tpl).length, REASON_MODEL.length);
  });

  test('picking a reason keeps the same 8 row node objects mounted', () => {
    const { portal, host, tpl } = mountReasonList();
    const before = rowsOf(host, tpl);

    let removedCount = 0;
    const originalRemoveChild = host.removeChild.bind(host);
    host.removeChild = (child) => { removedCount++; return originalRemoveChild(child); };

    portal.pick(before[idxOf('not_needed')]);

    const after = rowsOf(host, tpl);
    assert.equal(removedCount, 0, 'no row should ever be removed for an unchanged reason count');
    assert.equal(after.length, before.length);
    after.forEach((row, i) => assert.equal(row, before[i], `row ${i} must be the same node, not a rebuilt clone`));
  });

  test('the newly picked row is checked and every other row is not, after an in-place update', () => {
    const { portal, host, tpl } = mountReasonList();
    const rows = rowsOf(host, tpl);
    portal.pick(rows[idxOf('break')]);

    rows.forEach((row, i) => {
      const shouldBeChecked = i === idxOf('break');
      assert.equal(row.getAttribute('aria-checked'), shouldBeChecked ? 'true' : 'false', `row ${i}`);
      assert.equal(row.classList.contains('is-selected'), shouldBeChecked, `row ${i} is-selected`);
    });
  });

  test('every row keeps its stable data-spp-value and label after an in-place update', () => {
    const { portal, host, tpl } = mountReasonList();
    const rows = rowsOf(host, tpl);
    portal.pick(rows[idxOf('price')]);

    rows.forEach((row, i) => {
      assert.equal(row.dataset.sppValue, REASON_MODEL[i][0]);
      const label = row.querySelector('[data-spp-field="label"]');
      assert.equal(label.textContent, REASON_MODEL[i][1]);
    });
  });

  test('switching from one reason to another moves aria-checked without recreating any row', () => {
    const { portal, host, tpl } = mountReasonList();
    const before = rowsOf(host, tpl);

    portal.pick(before[idxOf('too_much')]);
    assert.equal(before[idxOf('too_much')].getAttribute('aria-checked'), 'true');

    portal.pick(before[idxOf('order_issue')]);
    const after = rowsOf(host, tpl);

    assert.equal(after.length, before.length);
    after.forEach((row, i) => assert.equal(row, before[i], `row ${i} must still be the original node`));
    assert.equal(before[idxOf('too_much')].getAttribute('aria-checked'), 'false', 'previous pick must clear');
    assert.equal(before[idxOf('order_issue')].getAttribute('aria-checked'), 'true', 'new pick must set');
  });

  test('all 8 reasons remain individually selectable via the real pick/render path', () => {
    const { portal, host, tpl } = mountReasonList();
    const rows = rowsOf(host, tpl);
    for (const [code] of REASON_MODEL) {
      portal.pick(rows[idxOf(code)]);
      assert.equal(portal.state.draft.reason, code);
      assert.equal(rows[idxOf(code)].getAttribute('aria-checked'), 'true', code);
    }
  });

  test('"Something else" reveals the free-text note; a preset reason keeps it hidden', () => {
    const { portal, host, tpl, note } = mountReasonList();
    const rows = rowsOf(host, tpl);

    portal.pick(rows[idxOf('other')]);
    assert.equal(note.hidden, false, 'the note field must appear for "other"');

    portal.pick(rows[idxOf('break')]);
    assert.equal(note.hidden, true, 'the note field must close again for a preset reason');
  });

  test('a mismatched row count safely falls back to the destroy-and-rebuild path', () => {
    // Defensive: if listData for 'reasons' ever stopped being a fixed 8, the
    // in-place path must not silently under- or over-populate the list.
    const { portal, host, tpl } = mountReasonList();
    const stray = rowsOf(host, tpl)[0];
    host.removeChild(stray); // simulate an out-of-band DOM change
    portal.render();
    assert.equal(rowsOf(host, tpl).length, REASON_MODEL.length, 'must recover the full row count');
  });
});
