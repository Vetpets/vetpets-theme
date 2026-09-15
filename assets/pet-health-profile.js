/*
 * VetPets Pet Health Profile — controller
 * ==================================================================
 * The approved 12-question Claude Design flow ("Pet Health Profile.dc.html",
 * VetPets Subscription Portal project), rebuilt against a real backend.
 * Copy, question order, options and the {N} name-interpolation mechanism
 * are ported field-for-field from that export — see QUESTIONS below and
 * fill(). Loading, error, sign-in and resume are NOT in that export (it is
 * a local-state-only mockup with no fetch anywhere); they are added here
 * because this build talks to a real API and cannot leave a stalled or
 * failed request unexplained.
 *
 * Data layer: assets/pet-health-profile-adapter.js (mock + live). Session
 * handling: shared with the subscription portal via
 * VetPetsPortal.sessionStore() / takeHandoffFromUrl() / createHttpAdapter()
 * in assets/subscription-portal-adapter.js.
 */
(function (window, document) {
  'use strict';

  var NS = window.VetPetsPortal || {};

  /* =================================================================
   * The 12 questions — copy ported verbatim from the approved design.
   * `{N}` is replaced at render time by fill() with the typed pet name,
   * falling back to "your pet" — the exact mechanism the design uses.
   * ================================================================= */

  var QUESTIONS = [
    {
      id: 'name', kind: 'text',
      title: 'What is your pet’s name?',
      sub: 'Everything after this is written for them by name.',
      fieldLabel: 'Pet’s name', placeholder: 'e.g. Bella',
      helper: 'We use the name to keep the rest of the questions personal.'
    },
    {
      id: 'species', kind: 'single', cols: 2,
      title: 'Is {N} a dog or cat?',
      sub: 'This sets the breed list and the care routine we suggest for {N}.',
      options: [
        { label: 'Dog', value: 'dog' },
        { label: 'Cat', value: 'cat' }
      ]
    },
    {
      id: 'breed', kind: 'text',
      title: 'What breed is {N}?',
      sub: 'Type it in however you describe {N}.',
      fieldLabel: 'Breed', placeholder: 'e.g. French Bulldog or mixed breed',
      helper: 'Not sure? Your best guess is fine.'
    },
    {
      id: 'age', kind: 'single', cols: 2,
      title: 'How old is {N}?',
      sub: 'An estimate is enough — pick the closest range for {N}.',
      options: [
        { label: 'Under 1 year', hint: 'Puppy or kitten', value: 'under_1' },
        { label: '1–2 years', value: '1_2' },
        { label: '3–6 years', value: '3_6' },
        { label: '7–9 years', value: '7_9' },
        { label: '10+ years', hint: 'Senior', value: '10_plus' },
        { label: 'Not sure', value: 'unsure' }
      ]
    },
    {
      id: 'weight', kind: 'single', cols: 2,
      title: 'What is {N}’s approximate weight?',
      sub: 'We use it to suggest how much product {N}’s routine needs.',
      options: [
        { label: 'Under 10 lb', hint: 'Up to 4.5 kg', value: 'under_10' },
        { label: '10–25 lb', hint: '4.5–11 kg', value: '10_25' },
        { label: '26–50 lb', hint: '12–23 kg', value: '26_50' },
        { label: '51–90 lb', hint: '23–41 kg', value: '51_90' },
        { label: 'Over 90 lb', hint: 'Above 41 kg', value: 'over_90' },
        { label: 'Not sure', value: 'unsure' }
      ]
    },
    {
      id: 'dental', kind: 'multi',
      title: 'Does {N} have any dental concerns?',
      sub: 'Select anything you have noticed with {N} recently.',
      options: [
        { label: 'Bad breath', value: 'bad_breath' },
        { label: 'Plaque or tartar buildup', value: 'plaque_tartar' },
        { label: 'Yellowing teeth', value: 'yellowing_teeth' },
        { label: 'Dislikes having their mouth touched', value: 'mouth_sensitive' },
        { label: 'None', value: 'none', exclusive: true },
        { label: 'Not sure', value: 'unsure', exclusive: true }
      ]
    },
    {
      id: 'eye', kind: 'multi',
      title: 'Does {N} have any eye or tear-stain concerns?',
      sub: 'Select anything you have noticed with {N} recently.',
      options: [
        { label: 'Tear stains under the eyes', value: 'tear_stains' },
        { label: 'Watery eyes', value: 'watery_eyes' },
        { label: 'Discharge or buildup in the corners', value: 'discharge' },
        { label: 'Rubbing or pawing at the eyes', value: 'eye_rubbing' },
        { label: 'None', value: 'none', exclusive: true },
        { label: 'Not sure', value: 'unsure', exclusive: true }
      ]
    },
    {
      id: 'ear', kind: 'multi',
      title: 'Does {N} have any ear concerns?',
      sub: 'Select anything you have noticed with {N} recently.',
      options: [
        { label: 'Odor from the ears', value: 'odor' },
        { label: 'Wax or dirt buildup', value: 'wax_buildup' },
        { label: 'Head shaking or scratching', value: 'head_shaking' },
        { label: 'Moisture after swimming or baths', value: 'moisture_after_bath' },
        { label: 'None', value: 'none', exclusive: true },
        { label: 'Not sure', value: 'unsure', exclusive: true }
      ]
    },
    {
      id: 'skin', kind: 'multi',
      title: 'Does {N} have any skin, coat or paw concerns?',
      sub: 'Select anything you have noticed with {N} recently.',
      options: [
        { label: 'Dry or flaky skin', value: 'dry_flaky_skin' },
        { label: 'Itching or scratching', value: 'itching' },
        { label: 'Odor between baths', value: 'odor_between_baths' },
        { label: 'Heavy shedding or matting', value: 'shedding_matting' },
        { label: 'Muddy or dirty paws', value: 'muddy_paws' },
        { label: 'Licking or chewing paws', value: 'licking_paws' },
        { label: 'None', value: 'none', exclusive: true },
        { label: 'Not sure', value: 'unsure', exclusive: true }
      ]
    },
    {
      id: 'routine', kind: 'single',
      title: 'What does {N}’s current care routine look like?',
      sub: 'However often it happens — there is no wrong answer.',
      options: [
        { label: 'Every day', hint: 'Wipes, brushing or a check most days', value: 'daily' },
        { label: 'A few times a week', value: 'few_times_week' },
        { label: 'About once a week', value: 'weekly' },
        { label: 'Only when I notice something', value: 'only_when_notice' },
        { label: 'No routine yet', hint: 'We are starting from scratch', value: 'no_routine' }
      ]
    },
    {
      id: 'products', kind: 'multi',
      title: 'Which VetPets products does {N} currently use?',
      sub: 'Including anything that arrived with {N}’s recent order.',
      options: [
        { label: 'FreshWipes', hint: 'Dental', value: 'freshwipes' },
        { label: 'EyeWipes', hint: 'Eye and tear-stain area', value: 'eyewipes' },
        { label: 'EarWipes', hint: 'Ear', value: 'earwipes' },
        { label: 'GloveWipes', hint: 'Body, coat and paws', value: 'glovewipes' },
        { label: 'PawFoam', hint: 'Paws', value: 'pawfoam' },
        { label: 'None yet', value: 'none', exclusive: true }
      ]
    },
    {
      id: 'improve', kind: 'single', hasOther: true,
      title: 'What would you most like to improve for {N}?',
      sub: 'Pick the one that matters most for {N} right now.',
      options: [
        { label: 'Fresher breath and cleaner teeth', value: 'fresher_breath' },
        { label: 'Clearer eyes and fewer tear stains', value: 'clearer_eyes' },
        { label: 'Cleaner, fresher ears', value: 'cleaner_ears' },
        { label: 'Healthier skin and coat', value: 'healthier_skin' },
        { label: 'Cleaner paws after walks', value: 'cleaner_paws' },
        { label: 'A simpler daily routine', value: 'simpler_routine' },
        { label: 'Other', hint: 'Tell us in a few words', value: 'other' }
      ]
    }
  ];

  function fill(t, name) {
    var n = name && String(name).trim().length ? String(name).trim() : 'your pet';
    return String(t).split('{N}').join(n);
  }

  function setText(root, selector, text) {
    var el = root.querySelector(selector);
    if (el) el.textContent = text;
  }

  function questionById(id) {
    for (var i = 0; i < QUESTIONS.length; i++) if (QUESTIONS[i].id === id) return QUESTIONS[i];
    return null;
  }

  function optionByValue(q, value) {
    if (!q || !q.options) return null;
    for (var i = 0; i < q.options.length; i++) if (q.options[i].value === value) return q.options[i];
    return null;
  }

  function readConfig(root) {
    return {
      mode: root.getAttribute('data-vphp-mode') || 'live',
      basePath: root.getAttribute('data-vphp-base-path') || '/apps/subscriptions-dev',
      latency: parseInt(root.getAttribute('data-vphp-latency'), 10) || 500,
      mockEntry: root.getAttribute('data-vphp-mock-entry') || 'phx',
      mockHasProfile: root.getAttribute('data-vphp-mock-has-profile') === 'true',
      devDefault: root.getAttribute('data-vphp-dev-default') === 'true'
    };
  }

  function initialState() {
    return {
      screen: 'loading',
      step: 0,
      name: '',
      selected: {},
      answers: {},
      signals: {},
      petId: null,
      pet: null,
      pets: [],
      activePetId: null,
      saving: false
    };
  }

  /* =================================================================
   * App
   * ================================================================= */

  function App(root) {
    this.root = root;
    this.cfg = readConfig(root);
    this.state = initialState();
    this.entry = 'phx';
  }

  App.prototype.init = function () {
    this.bindEvents();
    this.maybeRevealDevSwitcher();
    return this.boot();
  };

  App.prototype.maybeRevealDevSwitcher = function () {
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
    if ((params.get('vphp_dev') === '1' || this.cfg.devDefault) && this.cfg.mode === 'mock') {
      var dev = this.root.querySelector('[data-vphp-dev]');
      if (dev) dev.hidden = false;
    }
  };

  /* -----------------------------------------------------------------
   * Boot
   * --------------------------------------------------------------- */

  App.prototype.boot = function () {
    this.show('loading');
    if (this.cfg.mode === 'mock') return this.bootMock();
    return this.bootLive();
  };

  App.prototype.bootMock = function () {
    this.entry = this.cfg.mockEntry === 'portal' ? 'portal' : 'phx';
    this.petAdapter = NS.createPetProfileMockAdapter({
      latency: this.cfg.latency,
      hasProfile: this.cfg.mockHasProfile && this.entry === 'portal'
    });
    return this.loadPets();
  };

  App.prototype.bootLive = function () {
    var self = this;
    // Synchronous and first — see takeHandoffFromUrl's own comment on why.
    var handoff = NS.takeHandoffFromUrl ? NS.takeHandoffFromUrl() : null;
    var authAdapter = NS.createHttpAdapter({ basePath: this.cfg.basePath });
    this.petAdapter = NS.createPetProfileAdapter({ mode: 'live', basePath: this.cfg.basePath });

    if (handoff) {
      this.entry = 'phx';
      return authAdapter.exchangeHandoff(handoff)
        .then(function () { return self.loadPets(); })
        .catch(function (err) { self.fail(err); });
    }

    if (authAdapter.hasSession && authAdapter.hasSession()) {
      this.entry = 'portal';
      return this.loadPets();
    }

    this.show('signin');
    return Promise.resolve();
  };

  /** Every call chain below resolves, even on failure — errors route through fail(). */
  App.prototype.loadPets = function () {
    var self = this;
    return this.petAdapter.listPets()
      .then(function (res) {
        self.state.pets = (res && res.pets) || [];
        return self.decideInitialScreen();
      })
      .catch(function (err) { self.fail(err); });
  };

  App.prototype.decideInitialScreen = function () {
    var pets = this.state.pets;
    if (!pets.length) { this.goWelcome(); return null; }

    var draft = this.newestByStatus(pets, 'in_progress');
    if (draft) return this.resumeDraft(draft.id);

    var completed = this.newestByStatus(pets, 'completed');
    if (completed) return this.showProfileFor(completed.id);

    var untouched = this.newestByStatus(pets, 'draft');
    if (untouched) return this.resumeDraft(untouched.id);

    this.goWelcome();
    return null;
  };

  App.prototype.newestByStatus = function (pets, status) {
    var match = null;
    for (var i = 0; i < pets.length; i++) {
      if (pets[i].status === status && (!match || pets[i].updatedAt > match.updatedAt)) match = pets[i];
    }
    return match;
  };

  App.prototype.findPetSummary = function (petId) {
    for (var i = 0; i < this.state.pets.length; i++) if (this.state.pets[i].id === petId) return this.state.pets[i];
    return null;
  };

  App.prototype.fail = function (err) {
    if (err && (err.code === 'unauthenticated' || err.code === 'expired_link')) {
      if (NS.sessionStore) { try { NS.sessionStore().clear(); } catch (e) {} }
      this.show('signin');
      return;
    }
    var msg = (err && err.message) || 'We couldn’t reach your pet’s profile. Please try again.';
    setText(this.root, '[data-vphp-field="error.message"]', msg);
    this.show('error');
  };

  /* -----------------------------------------------------------------
   * Loading a specific pet (resume, or view a saved profile)
   * --------------------------------------------------------------- */

  App.prototype.applyPetData = function (petId, res) {
    var pet = res && res.pet;
    var a = res && res.latestAssessment;
    this.state.petId = petId;
    this.state.pet = pet || null;
    this.state.answers = (a && a.answers) || {};
    this.state.signals = (a && a.signals) || {};
    this.state.selected = this.selectionFromSignals(this.state.answers);
    this.state.name = (pet && pet.name) || this.state.answers.name || '';
    this.state.selected.improveOther = this.state.answers.improveOther || '';
  };

  /** Rebuild the value-token selection map from a resumed assessment's raw answers. */
  App.prototype.selectionFromSignals = function (answers) {
    var selected = {};
    for (var i = 0; i < QUESTIONS.length; i++) {
      var q = QUESTIONS[i];
      var raw = answers[q.id];
      if (raw === undefined || raw === null) continue;
      if (q.kind === 'text') { selected[q.id] = raw; continue; }
      if (q.kind === 'multi') {
        var labels = Array.isArray(raw) ? raw : [];
        selected[q.id] = labels.map(function (label) {
          var opt = this.optionByLabel(q, label);
          return opt ? opt.value : null;
        }, this).filter(function (v) { return v !== null; });
        continue;
      }
      var single = this.optionByLabel(q, raw);
      if (single) selected[q.id] = single.value;
    }
    return selected;
  };

  App.prototype.optionByLabel = function (q, label) {
    if (!q.options) return null;
    for (var i = 0; i < q.options.length; i++) if (q.options[i].label === label) return q.options[i];
    return null;
  };

  App.prototype.computeResumeStep = function () {
    var savedStepId = this.state.savedStepId;
    if (savedStepId) {
      for (var i = 0; i < QUESTIONS.length; i++) if (QUESTIONS[i].id === savedStepId) return i;
    }
    for (var j = 0; j < QUESTIONS.length; j++) {
      if (!(QUESTIONS[j].id in this.state.answers)) return j;
    }
    return QUESTIONS.length - 1;
  };

  App.prototype.resumeDraft = function (petId) {
    var self = this;
    return this.petAdapter.getPet({ petId: petId })
      .then(function (res) {
        self.applyPetData(petId, res);
        self.state.savedStepId = res && res.latestAssessment ? res.latestAssessment.step : null;
        self.state.step = self.computeResumeStep();
        self.goQuestion();
      })
      .catch(function (err) { self.fail(err); });
  };

  App.prototype.showProfileFor = function (petId) {
    var self = this;
    return this.petAdapter.getPet({ petId: petId })
      .then(function (res) {
        self.applyPetData(petId, res);
        self.state.activePetId = petId;
        self.goProfile();
      })
      .catch(function (err) { self.fail(err); });
  };

  App.prototype.switchPet = function (petId) {
    var pet = this.findPetSummary(petId);
    if (pet && pet.status === 'completed') return this.showProfileFor(petId);
    return this.resumeDraft(petId);
  };

  /* -----------------------------------------------------------------
   * Screen transitions
   * --------------------------------------------------------------- */

  App.prototype.show = function (screen) {
    this.state.screen = screen;
    var sections = this.root.querySelectorAll('[data-vphp-screen]');
    for (var i = 0; i < sections.length; i++) {
      sections[i].hidden = sections[i].getAttribute('data-vphp-screen') !== screen;
    }
    var main = this.root.querySelector('#vphp-main');
    if (main && main.focus) { try { main.focus({ preventScroll: true }); } catch (e) {} }
  };

  App.prototype.goWelcome = function () { this.renderWelcome(); this.show('welcome'); };
  App.prototype.goQuestion = function () { this.renderQuestion(); this.show('question'); };
  App.prototype.goProfile = function () { this.renderProfile(); this.show('profile'); };

  /* -----------------------------------------------------------------
   * Welcome
   * --------------------------------------------------------------- */

  App.prototype.renderWelcome = function () {
    var title = this.entry === 'portal'
      ? 'Create Your Pet’s Health Profile'
      : 'Create Your Pet’s Free Health Profile';
    setText(this.root, '[data-vphp-field="welcome.title"]', title);
  };

  App.prototype.startPet = function () {
    var self = this;
    if (this.state.petId) {
      this.state.step = 0;
      this.goQuestion();
      return null;
    }
    return this.petAdapter.createPet({ name: null })
      .then(function (res) {
        self.state.petId = res.pet.id;
        self.state.pet = res.pet;
        self.state.pets.push(res.pet);
        self.state.step = 0;
        self.state.answers = {};
        self.state.signals = {};
        self.state.selected = {};
        self.state.name = '';
        self.goQuestion();
      })
      .catch(function (err) { self.fail(err); });
  };

  App.prototype.skipWelcome = function () {
    window.location.href = '/pages/manage-subscription';
  };

  /* -----------------------------------------------------------------
   * Selection / answer state
   * --------------------------------------------------------------- */

  App.prototype.pickSingle = function (qid, value) {
    this.state.selected[qid] = value;
    this.syncFromSelection(qid);
    this.renderQuestion();
  };

  App.prototype.pickMulti = function (qid, value) {
    var q = questionById(qid);
    var opt = optionByValue(q, value);
    var cur = Array.isArray(this.state.selected[qid]) ? this.state.selected[qid].slice() : [];

    if (opt && opt.exclusive) {
      cur = cur.indexOf(value) !== -1 ? [] : [value];
    } else {
      cur = cur.filter(function (v) {
        var o = optionByValue(q, v);
        return o && !o.exclusive;
      });
      var idx = cur.indexOf(value);
      if (idx !== -1) cur.splice(idx, 1); else cur.push(value);
    }

    this.state.selected[qid] = cur;
    this.syncFromSelection(qid);
    this.renderQuestion();
  };

  App.prototype.setText = function (qid, value) {
    this.state.selected[qid] = value;
    this.syncFromSelection(qid);
    this.updateContinueState();
  };

  App.prototype.setOtherText = function (value) {
    this.state.selected.improveOther = value;
    this.state.answers.improveOther = value;
    this.updateContinueState();
  };

  App.prototype.syncFromSelection = function (qid) {
    var q = questionById(qid);
    var sel = this.state.selected[qid];

    if (q.kind === 'text') {
      this.state.answers[qid] = sel || '';
      if (qid === 'name') this.state.name = (sel || '').trim();
      if (qid === 'breed') this.state.signals.breed = (sel || '').trim() || null;
      return;
    }

    if (q.kind === 'single') {
      var opt = optionByValue(q, sel);
      this.state.answers[qid] = opt ? opt.label : null;
      this.applySignalSingle(qid, sel);
      return;
    }

    var opts = [];
    var values = sel || [];
    for (var i = 0; i < values.length; i++) {
      var o = optionByValue(q, values[i]);
      if (o) opts.push(o);
    }
    this.state.answers[qid] = opts.map(function (o) { return o.label; });
    this.applySignalMulti(qid, values);
  };

  App.prototype.applySignalSingle = function (qid, value) {
    var s = this.state.signals;
    if (qid === 'species') s.species = value;
    else if (qid === 'age') s.ageBand = value;
    else if (qid === 'weight') s.weightBand = value;
    else if (qid === 'routine') s.currentRoutine = value ? [value] : null;
    else if (qid === 'improve') {
      s.primaryPriority = value;
      if (value !== 'other') {
        this.state.selected.improveOther = '';
        delete this.state.answers.improveOther;
      }
    }
  };

  App.prototype.applySignalMulti = function (qid, values) {
    var s = this.state.signals;
    if (qid === 'dental') s.dentalConcerns = values;
    else if (qid === 'eye') s.eyeConcerns = values;
    else if (qid === 'ear') s.earConcerns = values;
    else if (qid === 'skin') s.skinPawConcerns = values;
    else if (qid === 'products') s.productsUsed = values;
  };

  App.prototype.answered = function (q) {
    var sel = this.state.selected[q.id];
    if (q.kind === 'text') return !!(sel && String(sel).trim().length);
    if (q.kind === 'single') {
      if (!sel) return false;
      if (q.id === 'improve' && sel === 'other') {
        var other = this.state.selected.improveOther;
        return !!(other && String(other).trim().length);
      }
      return true;
    }
    return Array.isArray(sel) && sel.length > 0;
  };

  /* -----------------------------------------------------------------
   * Question screen — render
   * --------------------------------------------------------------- */

  App.prototype.renderQuestion = function () {
    var q = QUESTIONS[this.state.step];
    var name = this.state.name;

    setText(this.root, '[data-vphp-field="q.title"]', fill(q.title, name));
    setText(this.root, '[data-vphp-field="q.sub"]', fill(q.sub, name));

    var stepLabel = 'Question ' + (this.state.step + 1) + ' of ' + QUESTIONS.length;
    var pct = Math.round(((this.state.step + 1) / QUESTIONS.length) * 100);
    setText(this.root, '[data-vphp-field="q.stepLabel"]', stepLabel);
    setText(this.root, '[data-vphp-field="q.stepPct"]', pct + '%');
    var bar = this.root.querySelector('[data-vphp-bar]');
    if (bar) bar.style.width = pct + '%';

    var content = this.root.querySelector('[data-vphp-qcontent]');
    content.innerHTML = '';
    if (q.kind === 'text') {
      content.appendChild(this.buildTextField(q, this.state.selected[q.id] || ''));
    } else {
      content.appendChild(this.buildOptionsGrid(q));
      if (q.hasOther && this.state.selected[q.id] === 'other') {
        content.appendChild(this.buildOtherField());
      }
    }

    var hint = this.root.querySelector('[data-vphp-multi-hint]');
    if (hint) hint.hidden = q.kind !== 'multi';

    this.clearSaveError();
    this.updateContinueState();

    var col = this.root.querySelector('[data-vphp-col]');
    if (col) col.scrollTop = 0;
    window.scrollTo(0, 0);

    this.updateContinueLabel();
  };

  App.prototype.updateContinueLabel = function () {
    var isLast = this.state.step === QUESTIONS.length - 1;
    var label = isLast ? 'Finish profile' : 'Continue';
    var nextBtns = this.root.querySelectorAll('[data-vphp-act="next"]');
    for (var i = 0; i < nextBtns.length; i++) nextBtns[i].textContent = label;
  };

  App.prototype.updateContinueState = function () {
    var q = QUESTIONS[this.state.step];
    var ok = this.answered(q);
    var disabled = !ok || this.state.saving;
    var nextBtns = this.root.querySelectorAll('[data-vphp-act="next"]');
    for (var i = 0; i < nextBtns.length; i++) {
      nextBtns[i].disabled = disabled;
      nextBtns[i].setAttribute('aria-disabled', disabled ? 'true' : 'false');
    }
  };

  App.prototype.buildTextField = function (q, value) {
    var wrap = document.createElement('div');
    wrap.className = 'vphp__field-card';

    var label = document.createElement('label');
    label.className = 'vphp__field-label';
    label.setAttribute('for', 'vphp-text-input');
    label.textContent = q.fieldLabel;

    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'vphp-text-input';
    input.className = 'vphp__field-input';
    input.placeholder = q.placeholder || '';
    input.value = value;
    input.autocomplete = 'off';
    input.setAttribute('data-vphp-text-input', q.id);

    var helper = document.createElement('p');
    helper.className = 'vphp__field-helper';
    helper.textContent = q.helper || '';

    wrap.appendChild(label);
    wrap.appendChild(input);
    wrap.appendChild(helper);
    return wrap;
  };

  App.prototype.buildOtherField = function () {
    var wrap = document.createElement('div');
    wrap.className = 'vphp__other-field vphp__field-card';

    var label = document.createElement('label');
    label.className = 'vphp__field-label';
    label.setAttribute('for', 'vphp-other-input');
    label.textContent = 'What would you like to improve?';

    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'vphp-other-input';
    input.className = 'vphp__field-input';
    input.placeholder = 'Type it here';
    input.value = this.state.selected.improveOther || '';
    input.setAttribute('data-vphp-other-input', '1');

    wrap.appendChild(label);
    wrap.appendChild(input);
    return wrap;
  };

  App.prototype.buildOptionsGrid = function (q) {
    var grid = document.createElement('div');
    grid.className = 'vphp__opts' + (q.cols === 2 ? ' vphp__opts--2col' : '');

    var sel = this.state.selected[q.id];
    var selectedValues = q.kind === 'multi' ? (Array.isArray(sel) ? sel : []) : (sel ? [sel] : []);

    for (var i = 0; i < q.options.length; i++) {
      var opt = q.options[i];
      var isSel = selectedValues.indexOf(opt.value) !== -1;

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vphp__choice' + (isSel ? ' is-selected' : '');
      btn.setAttribute('role', q.kind === 'multi' ? 'checkbox' : 'radio');
      btn.setAttribute('aria-checked', isSel ? 'true' : 'false');
      btn.setAttribute('data-vphp-pick', q.id);
      btn.setAttribute('data-vphp-value', opt.value);
      btn.setAttribute('data-vphp-kind', q.kind);

      var indicator = document.createElement('span');
      indicator.className = 'vphp__choice-indicator' + (q.kind === 'multi' ? ' vphp__choice-indicator--square' : '');
      indicator.innerHTML = q.kind === 'multi'
        ? '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2.6 7.2l3 3 5.8-6.4" stroke="#47B5E9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="5" fill="#47B5E9"/></svg>';

      var text = document.createElement('span');
      text.className = 'vphp__choice-text';
      var lbl = document.createElement('span');
      lbl.className = 'vphp__choice-label';
      lbl.textContent = opt.label;
      text.appendChild(lbl);
      if (opt.hint) {
        var hint = document.createElement('span');
        hint.className = 'vphp__choice-hint';
        hint.textContent = opt.hint;
        text.appendChild(hint);
      }

      btn.appendChild(indicator);
      btn.appendChild(text);
      grid.appendChild(btn);
    }

    return grid;
  };

  /* -----------------------------------------------------------------
   * Continue / Back / autosave
   * --------------------------------------------------------------- */

  App.prototype.setSaving = function (v) {
    this.state.saving = v;
    var el = this.root.querySelector('[data-vphp-saving]');
    if (el) el.hidden = !v;
    this.updateContinueState();
  };

  App.prototype.showSaveError = function () {
    var el = this.root.querySelector('[data-vphp-save-error]');
    if (el) el.hidden = false;
    this.updateContinueState();
  };

  App.prototype.clearSaveError = function () {
    var el = this.root.querySelector('[data-vphp-save-error]');
    if (el) el.hidden = true;
  };

  App.prototype.back = function () {
    if (this.state.step === 0) { this.goWelcome(); return; }
    this.state.step -= 1;
    this.goQuestion();
  };

  App.prototype.next = function () {
    var self = this;
    var q = QUESTIONS[this.state.step];
    if (!this.answered(q)) return null;

    var isLast = this.state.step === QUESTIONS.length - 1;
    var answersSnapshot = this.state.answers;
    var signalsSnapshot = this.state.signals;
    var nextStepId = isLast ? null : QUESTIONS[this.state.step + 1].id;

    this.setSaving(true);

    var save = isLast
      ? this.petAdapter.submit({ petId: this.state.petId, answers: answersSnapshot, signals: signalsSnapshot })
      : this.petAdapter.saveProgress({ petId: this.state.petId, step: nextStepId, answers: answersSnapshot, signals: signalsSnapshot });

    var nameSync = q.id === 'name'
      ? this.petAdapter.updatePet({ petId: this.state.petId, name: this.state.name || 'Your pet' })
      : Promise.resolve();

    return Promise.all([save, nameSync])
      .then(function () {
        self.setSaving(false);
        self.clearSaveError();
        if (isLast) {
          self.finishAssessment();
        } else {
          self.state.step += 1;
          self.goQuestion();
        }
      })
      .catch(function (err) {
        self.setSaving(false);
        if (err && (err.code === 'unauthenticated' || err.code === 'expired_link')) { self.fail(err); return; }
        self.showSaveError();
      });
  };

  App.prototype.finishAssessment = function () {
    var pet = this.findPetSummary(this.state.petId);
    if (pet) {
      pet.status = 'completed';
      pet.name = this.state.name;
    } else {
      this.state.pets.push({ id: this.state.petId, name: this.state.name, status: 'completed', updatedAt: Date.now() });
    }
    this.renderDone();
    this.show('done');
  };

  /* -----------------------------------------------------------------
   * Done
   * --------------------------------------------------------------- */

  App.prototype.priorityDisplay = function () {
    if (this.state.answers.improve === 'Other') return this.state.answers.improveOther || 'Other';
    return this.state.answers.improve || null;
  };

  App.prototype.renderDone = function () {
    var name = this.state.name || 'Your pet';
    setText(this.root, '[data-vphp-field="done.title"]', name + '’s Health Profile Is Ready');
    setText(this.root, '[data-vphp-field="done.body"]',
      'Your answers have been saved to your VetPets account. We’ll use them to provide more relevant care recommendations for ' + name + '.');
    setText(this.root, '[data-vphp-field="done.viewLabel"]', 'View ' + name + '’s Profile');

    var a = this.state.answers;
    var rows = [
      ['Name', a.name || name],
      ['Type and breed', [a.species, a.breed].filter(Boolean).join(' · ')],
      ['Age', a.age],
      ['Weight', a.weight],
      ['Routine today', a.routine],
      ['Priority', this.priorityDisplay()]
    ];

    var list = this.root.querySelector('[data-vphp-summary]');
    list.innerHTML = '';
    rows.forEach(function (r) {
      if (!r[1]) return;
      var row = document.createElement('div');
      var dt = document.createElement('dt'); dt.textContent = r[0];
      var dd = document.createElement('dd'); dd.textContent = r[1];
      row.appendChild(dt); row.appendChild(dd);
      list.appendChild(row);
    });
  };

  App.prototype.viewProfile = function () {
    this.state.activePetId = this.state.petId;
    this.goProfile();
  };

  /* -----------------------------------------------------------------
   * Profile
   * --------------------------------------------------------------- */

  App.prototype.renderProfile = function () {
    var a = this.state.answers;
    var name = this.state.name || 'Your pet';

    setText(this.root, '[data-vphp-field="profile.initial"]', (name.charAt(0) || '?').toUpperCase());
    setText(this.root, '[data-vphp-field="profile.name"]', name);
    setText(this.root, '[data-vphp-field="profile.line"]', [a.species, a.breed, a.age].filter(Boolean).join(' · '));
    setText(this.root, '[data-vphp-field="profile.routine"]', a.routine || '—');
    setText(this.root, '[data-vphp-field="profile.priority"]', this.priorityDisplay() || '—');
    setText(this.root, '[data-vphp-field="profile.focusSub"]', 'Suggested routine order based on ' + name + '’s answers.');

    var grid = this.root.querySelector('[data-vphp-details]');
    grid.innerHTML = '';
    [['Type', a.species], ['Breed', a.breed], ['Age', a.age], ['Weight', a.weight]].forEach(function (pair) {
      var dt = document.createElement('dt'); dt.textContent = pair[0];
      var dd = document.createElement('dd'); dd.textContent = pair[1] || '—';
      grid.appendChild(dt); grid.appendChild(dd);
    });

    var concerns = this.root.querySelector('[data-vphp-concerns]');
    concerns.innerHTML = '';
    this.renderConcernGroup(concerns, 'Dental', a.dental);
    this.renderConcernGroup(concerns, 'Eye and tear-stain area', a.eye);
    this.renderConcernGroup(concerns, 'Ear', a.ear);
    this.renderConcernGroup(concerns, 'Skin, coat and paws', a.skin);

    var productsWrap = this.root.querySelector('[data-vphp-products]');
    productsWrap.innerHTML = '';
    var products = Array.isArray(a.products) ? a.products.filter(function (p) { return p !== 'None yet'; }) : [];
    if (!products.length) {
      var empty = document.createElement('p');
      empty.className = 'vphp__empty-note';
      empty.textContent = 'No VetPets products in the routine yet.';
      productsWrap.appendChild(empty);
    } else {
      products.forEach(function (p) {
        var row = document.createElement('div'); row.className = 'vphp__product-row';
        var icon = document.createElement('span'); icon.className = 'vphp__product-icon';
        icon.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.6 8.2L12 3.6l8.4 4.6v8L12 20.8l-8.4-4.6v-8z" stroke="#47B5E9" stroke-width="1.6" stroke-linejoin="round"/></svg>';
        var pname = document.createElement('div'); pname.className = 'vphp__product-name'; pname.textContent = p;
        row.appendChild(icon); row.appendChild(pname);
        productsWrap.appendChild(row);
      });
    }

    var focus = this.root.querySelector('[data-vphp-focus]');
    focus.innerHTML = '';
    this.careFocusSuggestions(name).forEach(function (s) {
      var li = document.createElement('li'); li.textContent = s; focus.appendChild(li);
    });

    this.renderOtherPets();
  };

  App.prototype.renderConcernGroup = function (container, title, rawArray) {
    var items = Array.isArray(rawArray) ? rawArray : [];
    if (!items.length) return;
    var cleared = items.every(function (v) { return v === 'None' || v === 'Not sure'; });

    var group = document.createElement('div');
    group.className = 'vphp__concern-group';
    var b = document.createElement('b'); b.textContent = title; group.appendChild(b);

    var row = document.createElement('div');
    row.className = 'vphp__tag-row';
    items.forEach(function (label) {
      var tag = document.createElement('span');
      tag.className = 'vphp__tag ' + (cleared ? 'vphp__tag--neutral' : 'vphp__tag--active');
      tag.textContent = label;
      row.appendChild(tag);
    });
    group.appendChild(row);
    container.appendChild(group);
  };

  App.prototype.careFocusSuggestions = function (name) {
    var a = this.state.answers;
    var out = [];
    function flagged(arr) {
      return Array.isArray(arr) && arr.length > 0 && !arr.every(function (v) { return v === 'None' || v === 'Not sure'; });
    }
    if (flagged(a.dental)) out.push('Add a dental wipe to ' + name + '’s routine to help with the concerns you flagged.');
    if (flagged(a.eye)) out.push('A gentle eye wipe can help with the tear-stain and eye concerns you noted for ' + name + '.');
    if (flagged(a.ear)) out.push('Regular ear cleaning may help with what you’re seeing in ' + name + '’s ears.');
    if (flagged(a.skin)) out.push('A paw and coat routine can help with the skin or paw concerns you flagged for ' + name + '.');
    if (!out.length) out.push('Keep up ' + name + '’s current routine — nothing urgent flagged yet.');
    return out.slice(0, 3);
  };

  App.prototype.renderOtherPets = function () {
    var self = this;
    var others = this.state.pets.filter(function (p) { return p.id !== self.state.activePetId; });
    var wrap = this.root.querySelector('[data-vphp-other-pets]');
    var chips = this.root.querySelector('[data-vphp-pet-chips]');
    chips.innerHTML = '';
    if (!others.length) { wrap.hidden = true; return; }
    wrap.hidden = false;

    others.forEach(function (p) {
      var pname = p.name || 'Unnamed pet';
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'vphp__pet-chip';
      chip.setAttribute('data-vphp-pet-chip', p.id);

      var avatar = document.createElement('span');
      avatar.className = 'vphp__pet-chip-avatar';
      avatar.textContent = pname.charAt(0).toUpperCase();

      var textWrap = document.createElement('span');
      textWrap.style.display = 'flex';
      textWrap.style.flexDirection = 'column';
      var nameEl = document.createElement('span'); nameEl.className = 'vphp__pet-chip-name'; nameEl.textContent = pname;
      var statusEl = document.createElement('span'); statusEl.className = 'vphp__pet-chip-status';
      statusEl.textContent = p.status === 'completed' ? 'Profile complete' : (p.status === 'in_progress' ? 'In progress' : 'Profile not started');
      textWrap.appendChild(nameEl);
      textWrap.appendChild(statusEl);

      chip.appendChild(avatar);
      chip.appendChild(textWrap);
      chips.appendChild(chip);
    });
  };

  App.prototype.editProfile = function () {
    this.state.step = 0;
    this.goQuestion();
  };

  App.prototype.addAnotherPet = function () {
    this.state.petId = null;
    this.state.pet = null;
    this.state.answers = {};
    this.state.signals = {};
    this.state.selected = {};
    this.state.name = '';
    this.state.step = 0;
    this.entry = 'portal';
    this.goWelcome();
  };

  /* -----------------------------------------------------------------
   * Events
   * --------------------------------------------------------------- */

  App.prototype.handleAction = function (act) {
    switch (act) {
      case 'start-pet': return this.startPet();
      case 'skip-welcome': return this.skipWelcome();
      case 'back': return this.back();
      case 'next': return this.next();
      case 'view-profile': return this.viewProfile();
      case 'add-another-pet': return this.addAnotherPet();
      case 'edit-profile': return this.editProfile();
      case 'retry': return this.boot();
      default: return null;
    }
  };

  App.prototype.bindEvents = function () {
    var self = this;

    this.root.addEventListener('click', function (e) {
      var el;

      if ((el = e.target.closest('[data-vphp-pick]'))) {
        var qid = el.getAttribute('data-vphp-pick');
        var value = el.getAttribute('data-vphp-value');
        var kind = el.getAttribute('data-vphp-kind');
        if (kind === 'multi') self.pickMulti(qid, value); else self.pickSingle(qid, value);
        return;
      }

      if ((el = e.target.closest('[data-vphp-pet-chip]'))) {
        self.switchPet(el.getAttribute('data-vphp-pet-chip'));
        return;
      }

      if ((el = e.target.closest('[data-vphp-act]'))) {
        self.handleAction(el.getAttribute('data-vphp-act'));
        return;
      }

      if ((el = e.target.closest('[data-vphp-dev-toggle]'))) {
        var dev = self.root.querySelector('[data-vphp-dev]');
        if (dev) dev.classList.toggle('is-open');
        return;
      }

      if ((el = e.target.closest('[data-vphp-dev-entry]'))) {
        self.cfg.mockEntry = el.getAttribute('data-vphp-dev-entry');
        self.bootMock();
        return;
      }

      if ((el = e.target.closest('[data-vphp-go]'))) {
        var stepAttr = el.getAttribute('data-vphp-dev-step');
        if (stepAttr !== null) {
          self.state.step = parseInt(stepAttr, 10) || 0;
          if (!self.state.petId) self.state.petId = 'dev-preview';
          self.renderQuestion();
        }
        self.show(el.getAttribute('data-vphp-go'));
        return;
      }
    });

    this.root.addEventListener('input', function (e) {
      var target = e.target;
      if (target.hasAttribute && target.hasAttribute('data-vphp-text-input')) {
        self.setText(target.getAttribute('data-vphp-text-input'), target.value);
      } else if (target.hasAttribute && target.hasAttribute('data-vphp-other-input')) {
        self.setOtherText(target.value);
      }
    });
  };

  /* =================================================================
   * Boot
   * ================================================================= */

  function init() {
    var root = document.getElementById('vphp-root');
    if (!root || root.getAttribute('data-vphp-inited') === '1') return;
    root.setAttribute('data-vphp-inited', '1');
    var app = new App(root);
    app.init();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  document.addEventListener('shopify:section:load', init);
})(window, document);
