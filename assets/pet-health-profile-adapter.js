/*
 * VetPets Pet Health Profile — data adapter
 * ==================================================================
 * Talks to the DEV backend's Pet Health Profile routes (Milestone 1):
 *
 *   POST /portal/pets/create          create an empty pet profile
 *   POST /portal/pets/list            the customer's own profiles
 *   POST /portal/pets/get             one profile + its latest assessment
 *   POST /portal/pets/update          rename a pet
 *   POST /portal/pets/save-progress   autosave/resume the open draft
 *   POST /portal/pets/submit          finalize the open draft
 *
 * See src/routes/petProfile.ts in vetpets-subscription-backend for the
 * authoritative contract this file matches field-for-field.
 *
 * SESSION SHARING
 * ------------------------------------------------------------------
 * Deliberately reuses VetPetsPortal.sessionStore() and
 * VetPetsPortal.takeHandoffFromUrl() from subscription-portal-adapter.js
 * (loaded first — see layout/pet-health-profile.liquid) rather than
 * duplicating that security-sensitive code. Both pages read and write the
 * SAME sessionStorage key, so a session either page mints is honoured by
 * the other with no extra wiring: an already-authenticated portal
 * customer who navigates here in the same tab is recognised immediately,
 * and this page's own handoff exchange (from /pet-entry) leaves a session
 * the subscription portal would equally accept.
 *
 * SECURITY BOUNDARY
 * ------------------------------------------------------------------
 * No credential, token or vendor hostname belongs in this file. The live
 * adapter calls a first-party, same-origin App Proxy path only, and the
 * session travels in the POST body — never a URL, never localStorage.
 */
(function (window) {
  'use strict';

  var VetPetsPortal = (window.VetPetsPortal = window.VetPetsPortal || {});

  function need(name) {
    if (!VetPetsPortal[name]) {
      throw new Error('pet-health-profile-adapter.js requires VetPetsPortal.' + name + ' — load subscription-portal-adapter.js first.');
    }
    return VetPetsPortal[name];
  }

  /* ---------------------------------------------------------------
   * Mock adapter — in-browser prototype, for visual QA only
   * --------------------------------------------------------------- */

  function uid() {
    return 'pet-' + Math.random().toString(36).slice(2, 10);
  }

  function clone(v) {
    return v === null || v === undefined ? v : JSON.parse(JSON.stringify(v));
  }

  /** Shallow merge, field by field — kept ES5 to match the rest of this codebase. */
  function merge(base, patch) {
    var out = {};
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) out[k] = patch[k];
    return out;
  }

  function createMockAdapter(config) {
    var cfg = config || {};
    var latency = typeof cfg.latency === 'number' ? cfg.latency : 500;
    var now = Date.now();

    /** @type {Array<Object>} */
    var pets = [];
    /** @type {Array<Object>} */
    var assessments = [];

    if (cfg.hasProfile) {
      var demoId = uid();
      pets.push({ id: demoId, name: 'Bella', status: 'completed', createdAt: now, updatedAt: now, completedAt: now });
      assessments.push({
        id: uid(), petId: demoId, version: 1, status: 'completed', step: null,
        answers: {
          name: 'Bella', species: 'Dog', breed: 'French Bulldog', age: '3–6 years', weight: '26–50 lb',
          dental: ['Bad breath'], eye: ['None'], ear: ['None'], skin: ['None'],
          routine: 'A few times a week', products: ['FreshWipes'], improve: 'Fresher breath and cleaner teeth'
        },
        signals: {
          species: 'dog', breed: 'French Bulldog', ageBand: '3_6', weightBand: '26_50',
          dentalConcerns: ['bad_breath'], eyeConcerns: ['none'], earConcerns: ['none'], skinPawConcerns: ['none'],
          currentRoutine: ['few_times_week'], productsUsed: ['freshwipes'], primaryPriority: 'fresher_breath'
        },
        createdAt: now, updatedAt: now, completedAt: now
      });
    }

    function delay(value) {
      return new Promise(function (resolve) { setTimeout(function () { resolve(value); }, latency); });
    }

    function findPet(petId) {
      for (var i = 0; i < pets.length; i++) if (pets[i].id === petId) return pets[i];
      return null;
    }

    function latestAssessmentFor(petId) {
      var best = null;
      for (var i = 0; i < assessments.length; i++) {
        var a = assessments[i];
        if (a.petId === petId && (!best || a.version > best.version)) best = a;
      }
      return best;
    }

    return {
      isMock: true,

      listPets: function () {
        return delay(null).then(function () {
          return {
            pets: pets.map(function (p) {
              var a = latestAssessmentFor(p.id);
              return {
                id: p.id, name: p.name, status: p.status,
                createdAt: p.createdAt, updatedAt: p.updatedAt, completedAt: p.completedAt,
                latestSignals: a ? clone(a.signals) : null
              };
            })
          };
        });
      },

      createPet: function (input) {
        var pet = { id: uid(), name: (input && input.name) || null, status: 'draft', createdAt: Date.now(), updatedAt: Date.now(), completedAt: null };
        pets.push(pet);
        return delay(null).then(function () { return { pet: clone(pet) }; });
      },

      updatePet: function (input) {
        var pet = findPet(input.petId);
        if (!pet) return delay(null).then(function () { throw VetPetsPortal.PortalError('not_found', 'Pet not found.'); });
        pet.name = input.name;
        pet.updatedAt = Date.now();
        return delay(null).then(function () { return { ok: true }; });
      },

      getPet: function (input) {
        var pet = findPet(input.petId);
        if (!pet) return delay(null).then(function () { throw VetPetsPortal.PortalError('not_found', 'Pet not found.'); });
        var history = assessments.filter(function (a) { return a.petId === pet.id; }).sort(function (a, b) { return b.version - a.version; });
        return delay(null).then(function () {
          return { pet: clone(pet), latestAssessment: history[0] ? clone(history[0]) : null, history: clone(history) };
        });
      },

      saveProgress: function (input) {
        var pet = findPet(input.petId);
        if (!pet) return delay(null).then(function () { throw VetPetsPortal.PortalError('not_found', 'Pet not found.'); });
        var draft = null;
        for (var i = 0; i < assessments.length; i++) {
          if (assessments[i].petId === pet.id && assessments[i].status === 'in_progress') { draft = assessments[i]; break; }
        }
        if (!draft) {
          var latest = latestAssessmentFor(pet.id);
          draft = { id: uid(), petId: pet.id, version: latest ? latest.version + 1 : 1, status: 'in_progress', step: null, answers: {}, signals: {}, createdAt: Date.now(), updatedAt: Date.now(), completedAt: null };
          assessments.push(draft);
        }
        draft.step = input.step || null;
        draft.answers = clone(input.answers) || {};
        draft.signals = merge(draft.signals, clone(input.signals) || {});
        draft.updatedAt = Date.now();
        pet.status = 'in_progress';
        pet.updatedAt = Date.now();
        return delay(null).then(function () { return { assessment: clone(draft) }; });
      },

      submit: function (input) {
        var pet = findPet(input.petId);
        if (!pet) return delay(null).then(function () { throw VetPetsPortal.PortalError('not_found', 'Pet not found.'); });
        var draft = null;
        for (var i = 0; i < assessments.length; i++) {
          if (assessments[i].petId === pet.id && assessments[i].status === 'in_progress') { draft = assessments[i]; break; }
        }
        if (!draft) {
          var latest = latestAssessmentFor(pet.id);
          draft = { id: uid(), petId: pet.id, version: latest ? latest.version + 1 : 1, answers: {}, signals: {}, createdAt: Date.now() };
          assessments.push(draft);
        }
        draft.status = 'completed';
        draft.step = null;
        draft.answers = clone(input.answers) || {};
        draft.signals = merge(draft.signals, clone(input.signals) || {});
        draft.updatedAt = Date.now();
        draft.completedAt = Date.now();
        pet.status = 'completed';
        pet.updatedAt = Date.now();
        pet.completedAt = Date.now();
        return delay(null).then(function () { return { assessment: clone(draft) }; });
      }
    };
  }

  VetPetsPortal.createPetProfileMockAdapter = createMockAdapter;

  /* ---------------------------------------------------------------
   * Live adapter — same-origin App Proxy, session-in-body
   * --------------------------------------------------------------- */

  VetPetsPortal.createPetProfileHttpAdapter = function (options) {
    var opts = options || {};
    var base = opts.basePath || '/apps/subscriptions-dev';
    var store = opts.sessionStore || need('sessionStore')();
    var PortalError = need('PortalError');
    var fetchImpl = opts.fetchImpl || function () { return window.fetch.apply(window, arguments); };

    function post(path, body) {
      return fetchImpl(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body || {})
      }).then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
          return { status: res.status, ok: res.ok, data: data };
        });
      }, function () {
        throw PortalError('network', 'The pet health profile could not be reached.');
      });
    }

    function requireSession() {
      var token = store.get();
      if (!token) throw PortalError('unauthenticated', 'Sign in to manage your pet’s health profile.');
      return token;
    }

    function call(path, fields) {
      var body;
      try {
        body = merge({ session: requireSession() }, fields || {});
      } catch (e) {
        return Promise.reject(e);
      }
      return post(path, body).then(function (r) {
        if (r.status === 401) {
          store.clear();
          throw PortalError('unauthenticated', 'Your session has expired.');
        }
        if (r.status === 403 && r.data && r.data.error === 'not_enabled') {
          throw PortalError('not_enabled', 'The pet health profile is not available yet.');
        }
        if (r.status === 503) throw PortalError('not_enabled', 'The pet health profile is not available yet.');
        if (r.status === 404) throw PortalError('not_found', 'That pet could not be found.');
        if (r.status >= 400) {
          var code = (r.data && r.data.error) || 'server';
          throw PortalError(code, 'That could not be saved. Please try again.');
        }
        return r.data || {};
      });
    }

    return {
      isMock: false,
      listPets: function () { return call('/portal/pets/list'); },
      createPet: function (input) { return call('/portal/pets/create', { name: input && input.name }); },
      updatePet: function (input) { return call('/portal/pets/update', { petId: input.petId, name: input.name }); },
      getPet: function (input) { return call('/portal/pets/get', { petId: input.petId }); },
      saveProgress: function (input) {
        return call('/portal/pets/save-progress', {
          petId: input.petId, step: input.step, answers: input.answers, signals: input.signals
        });
      },
      submit: function (input) {
        return call('/portal/pets/submit', { petId: input.petId, answers: input.answers, signals: input.signals });
      }
    };
  };

  VetPetsPortal.createPetProfileAdapter = function (config) {
    config = config || {};
    if (config.mode === 'live') return VetPetsPortal.createPetProfileHttpAdapter(config);
    return createMockAdapter(config);
  };
})(window);
