/**
 * Pet Health Profile — entry-screen routing.
 *
 * Two behaviours the Pet Health Profile completion brief requires and that
 * regressed easily if `decideInitialScreen`/`bootLive` were ever touched:
 *
 *   - a customer with NO pet profile must see the questionnaire (welcome),
 *   - a customer WITH a completed profile must see it, not the questionnaire,
 *   - an in-progress draft resumes where it left off, whichever screen was
 *     open last time.
 *
 * `bootLive` is also entry-path-agnostic by design: a handoff code in the
 * URL (`vp_handoff`) is exchanged for a session the SAME way whether it was
 * minted by the PHX no-login entry or the CheckoutChamp no-login entry — the
 * frontend has no separate "CheckoutChamp mode". This file proves that by
 * exercising the SHIPPED function bodies, lifted out of
 * assets/pet-health-profile.js, against stand-ins — behavioural, not source
 * greps: a regression has to change what the code does.
 *
 * Run with:  node --test test/pet-health-profile-entry.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '..', 'assets', 'pet-health-profile.js'), 'utf8');

/** Lift one `App.prototype.<name>` out of the shipped file and compile it. */
function method(name) {
  const re = new RegExp(`App\\.prototype\\.${name} = function \\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\};`);
  const m = re.exec(source);
  assert.ok(m, `App.prototype.${name} must exist`);
  const factory = new Function('NS', `return function (${m[1]}) {${m[2]}\n};`);
  return factory;
}

const decideInitialScreen = method('decideInitialScreen')({});
const newestByStatus = method('newestByStatus')({});
const bootLive = method('bootLive')({
  takeHandoffFromUrl: () => null,
  createHttpAdapter: () => ({ hasSession: () => false }),
  createPetProfileAdapter: () => ({}),
});

function app(overrides = {}) {
  const calls = { welcome: 0, resumed: [], profiled: [] };
  return {
    calls,
    state: { pets: [] },
    goWelcome() {
      calls.welcome += 1;
    },
    resumeDraft(petId) {
      calls.resumed.push(petId);
      return Promise.resolve();
    },
    showProfileFor(petId) {
      calls.profiled.push(petId);
      return Promise.resolve();
    },
    newestByStatus,
    ...overrides,
  };
}

describe('decideInitialScreen: a customer WITHOUT a profile sees the questionnaire', () => {
  test('no pets at all -> welcome (the questionnaire entry screen)', () => {
    const a = app();
    a.state.pets = [];
    decideInitialScreen.call(a);
    assert.equal(a.calls.welcome, 1);
    assert.deepEqual(a.calls.resumed, []);
    assert.deepEqual(a.calls.profiled, []);
  });
});

describe('decideInitialScreen: a customer WITH a profile sees their saved information', () => {
  test('a completed pet -> the saved profile view, not the questionnaire', () => {
    const a = app();
    a.state.pets = [{ id: 'pet-1', status: 'completed', updatedAt: 100 }];
    decideInitialScreen.call(a);
    assert.equal(a.calls.welcome, 0, 'must not show the questionnaire when a profile already exists');
    assert.deepEqual(a.calls.profiled, ['pet-1']);
    assert.deepEqual(a.calls.resumed, []);
  });

  test('the NEWEST completed pet wins when several exist', () => {
    const a = app();
    a.state.pets = [
      { id: 'older', status: 'completed', updatedAt: 100 },
      { id: 'newer', status: 'completed', updatedAt: 200 },
    ];
    decideInitialScreen.call(a);
    assert.deepEqual(a.calls.profiled, ['newer']);
  });
});

describe('decideInitialScreen: an in-progress draft resumes, ahead of any completed profile', () => {
  test('an in_progress draft takes priority over a completed pet', () => {
    const a = app();
    a.state.pets = [
      { id: 'done', status: 'completed', updatedAt: 100 },
      { id: 'draft', status: 'in_progress', updatedAt: 50 },
    ];
    decideInitialScreen.call(a);
    assert.deepEqual(a.calls.resumed, ['draft']);
    assert.deepEqual(a.calls.profiled, []);
  });

  test('an untouched draft (status "draft") also resumes rather than re-showing welcome', () => {
    const a = app();
    a.state.pets = [{ id: 'untouched', status: 'draft', updatedAt: 10 }];
    decideInitialScreen.call(a);
    assert.deepEqual(a.calls.resumed, ['untouched']);
    assert.equal(a.calls.welcome, 0);
  });
});

describe('bootLive: entry-path-agnostic handoff exchange', () => {
  test('a vp_handoff in the URL is exchanged into a session and pets are loaded, regardless of which backend route minted it', async () => {
    let exchanged = null;
    let loaded = false;
    const ctxNS = {
      takeHandoffFromUrl: () => 'some-handoff-code',
      createHttpAdapter: () => ({
        hasSession: () => false,
        exchangeHandoff(code) {
          exchanged = code;
          return Promise.resolve();
        },
      }),
      createPetProfileAdapter: () => ({}),
    };
    const bootLiveWithNS = method('bootLive')(ctxNS);
    const a = {
      cfg: {},
      entry: null,
      loadPets() {
        loaded = true;
        return Promise.resolve();
      },
      fail() {},
    };
    await bootLiveWithNS.call(a);
    assert.equal(exchanged, 'some-handoff-code');
    assert.equal(a.entry, 'phx');
    assert.ok(loaded, 'pets must be loaded immediately after a successful handoff exchange');
  });

  test('an existing session with no handoff code loads pets directly (ordinary portal login)', async () => {
    let loaded = false;
    const ctxNS = {
      takeHandoffFromUrl: () => null,
      createHttpAdapter: () => ({ hasSession: () => true }),
      createPetProfileAdapter: () => ({}),
    };
    const bootLiveWithNS = method('bootLive')(ctxNS);
    const a = {
      cfg: {},
      entry: null,
      loadPets() {
        loaded = true;
        return Promise.resolve();
      },
    };
    await bootLiveWithNS.call(a);
    assert.equal(a.entry, 'portal');
    assert.ok(loaded);
  });

  test('no handoff code and no session shows sign-in, never a fabricated profile', async () => {
    let shown = null;
    const a = {
      cfg: {},
      show(screen) {
        shown = screen;
      },
    };
    await bootLive.call(a);
    assert.equal(shown, 'signin');
  });
});
