/**
 * The approved Portal V2 "RoutineCare benefits" welcome screen.
 *
 * Shown once, immediately after a fresh authentication (see the "welcome
 * screen appears once" describe block in auth-state-machine.test.mjs for
 * the behavioural half of this). This file checks the markup itself: every
 * element the founder asked for is present, and nothing on it fabricates
 * data Phoenix does not supply.
 *
 * Run with:  node --test test/welcome-screen.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '..', 'snippets', 'spp-screen-welcome.liquid'), 'utf8');
const markup = raw.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, '');
const sectionSource = readFileSync(resolve(here, '..', 'sections', 'subscription-portal.liquid'), 'utf8');

describe('the welcome screen has every approved element', () => {
  test('is its own screen, not folded into the dashboard', () => {
    assert.match(markup, /data-spp-screen="welcome"/);
  });

  test('a welcome-back heading', () => {
    assert.match(markup, /data-spp-field="customer\.welcomeBack"/);
  });

  test('"Everything included with your RoutineCare membership"', () => {
    assert.match(markup, /Everything included with your RoutineCare membership/);
  });

  test('a hero image area', () => {
    assert.match(markup, /spp__media-16x9/);
    assert.match(markup, /alt="[^"]+"/, 'the image must be described');
  });

  test('an upcoming-delivery card, using the real subscription fields', () => {
    assert.match(markup, /Upcoming delivery/);
    assert.match(markup, /data-spp-field="subscription\.nextOrderMedium"/);
    assert.match(markup, /data-spp-field="pricing\.total"/);
    assert.match(markup, /data-spp-field="subscription\.intervalDays"/);
  });

  test('the four approved RoutineCare benefit tiles', () => {
    for (const claim of [
      'Save 20% on every refill',
      'Free shipping',
      'Skip or adjust anytime',
      'Member gifts and surprise treats',
    ]) {
      assert.ok(markup.includes(claim), `missing tile: ${claim}`);
    }
  });

  test('Phoenix has no pause operation, so this promises only what it can do', () => {
    assert.ok(!/\bpause\b/i.test(markup), 'must not promise a pause capability that does not exist');
  });

  test('a clear CTA that continues into the dashboard', () => {
    const m = /<button[^>]*data-spp-go="dashboard"[^>]*>([\s\S]*?)<\/button>/.exec(markup);
    assert.ok(m, 'the CTA button must exist and target the dashboard');
    assert.match(m[1], /View my subscriptions/);
  });

  test('names no pet — Phoenix has no pet record', () => {
    // Same rule as the dashboard's own identity-free greeting subheading:
    // a real customer must never read a fabricated dog's name.
    assert.ok(!/\bBella\b|\bMax\b/.test(markup), 'must not name the prototype pets');
  });

  test('the section renders this screen', () => {
    assert.match(sectionSource, /\{%\s*render\s*'spp-screen-welcome'\s*%\}/);
  });
});
