/*
 * VetPets Subscription Portal — data adapter
 * ------------------------------------------------------------------
 * This file is the ONLY place the portal talks to a data source.
 *
 * The UI layer (subscription-portal.js) never fetches, never knows a
 * vendor name, and never formats a currency by itself. It calls the
 * methods on the object returned by `VetPetsPortal.adapter` and renders
 * whatever comes back. Swapping the mock for the real Phoenix/Solvpath
 * backend therefore means replacing `createMockAdapter` with
 * `createHttpAdapter` and changing nothing else in the UI.
 *
 * SECURITY BOUNDARY
 * -----------------
 * No credential, API key, signing secret or vendor hostname belongs in
 * this file, in Liquid, in theme settings or in any committed asset.
 * The real adapter must call a first-party, same-origin path (Shopify
 * App Proxy, e.g. /apps/subscriptions/*) that is backed by our own
 * server. That server holds the secrets, verifies the customer session
 * and talks to Phoenix/Solvpath. Payment-method updates never collect a
 * card here: the backend mints a short-lived hosted-page URL and the
 * portal redirects to it.
 *
 * CURRENCY
 * --------
 * Money is always { amount: Number, currencyCode: String }. USD is only
 * what the prototype mock happens to contain; USD is never assumed by
 * the model, the formatter or the UI. USD, GBP, EUR and SEK are all
 * supported and exercised by `setCurrency()`.
 */
(function (window) {
  'use strict';

  var VetPetsPortal = (window.VetPetsPortal = window.VetPetsPortal || {});

  /* ---------------------------------------------------------------
   * Errors
   * --------------------------------------------------------------- */

  function PortalError(code, message, reference) {
    var err = new Error(message || code);
    err.name = 'PortalError';
    err.code = code;                 // 'expired_link' | 'network' | 'server' | 'conflict' | ...
    err.reference = reference || null; // support-facing reference, shown in the API error state
    return err;
  }
  VetPetsPortal.PortalError = PortalError;

  /* ---------------------------------------------------------------
   * Money — locale aware, never USD-by-default
   * --------------------------------------------------------------- */

  var LOCALE_BY_CURRENCY = {
    USD: 'en-US',
    GBP: 'en-GB',
    EUR: 'de-DE',
    SEK: 'sv-SE'
  };

  VetPetsPortal.SUPPORTED_CURRENCIES = ['USD', 'GBP', 'EUR', 'SEK'];

  function money(amount, currencyCode) {
    return { amount: Number(amount), currencyCode: currencyCode };
  }
  VetPetsPortal.money = money;

  /**
   * Format a { amount, currencyCode } pair for display.
   * `localeHint` normally comes from Shopify (request.locale.iso_code);
   * when absent we fall back to a sensible locale for the currency and
   * then to the browser locale — never to a hardcoded "$".
   */
  function formatMoney(value, localeHint) {
    if (!value || typeof value.amount !== 'number' || isNaN(value.amount)) return '';
    var currency = value.currencyCode || 'USD';
    var locale = localeHint || LOCALE_BY_CURRENCY[currency] || undefined;
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(value.amount);
    } catch (e) {
      // Intl missing or currency unknown — degrade to code + amount, never to "$".
      return currency + ' ' + value.amount.toFixed(2);
    }
  }
  VetPetsPortal.formatMoney = formatMoney;

  function addMoney(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a.currencyCode !== b.currencyCode) {
      throw PortalError('currency_mismatch', 'Cannot add ' + a.currencyCode + ' to ' + b.currencyCode);
    }
    return money(a.amount + b.amount, a.currencyCode);
  }
  VetPetsPortal.addMoney = addMoney;

  function multiplyMoney(a, n) {
    return money(a.amount * n, a.currencyCode);
  }
  VetPetsPortal.multiplyMoney = multiplyMoney;

  /* ---------------------------------------------------------------
   * Dates — ISO in the model, formatted only at the edge
   * --------------------------------------------------------------- */

  function parseISO(iso) {
    var p = String(iso).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function toISO(date) {
    var m = String(date.getMonth() + 1);
    var d = String(date.getDate());
    return date.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (d.length < 2 ? '0' + d : d);
  }

  function addDays(iso, n) {
    var dt = parseISO(iso);
    dt.setDate(dt.getDate() + n);
    return toISO(dt);
  }

  function addMonths(iso, n) {
    var dt = parseISO(iso);
    dt.setMonth(dt.getMonth() + n);
    return toISO(dt);
  }

  function daysBetween(fromISO, toISODate) {
    return Math.round((parseISO(toISODate) - parseISO(fromISO)) / 86400000);
  }

  VetPetsPortal.dates = {
    parseISO: parseISO,
    toISO: toISO,
    addDays: addDays,
    addMonths: addMonths,
    daysBetween: daysBetween
  };

  /* ---------------------------------------------------------------
   * Mock adapter
   * --------------------------------------------------------------- */

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * createMockAdapter(config)
   *
   * config.today            ISO date treated as "now" (prototype fixes this
   *                         so screenshots are stable).
   * config.currencyCode     Starting currency. Prototype example data is USD.
   * config.latency          Simulated round-trip in ms.
   * config.pointsPerRenewal Placeholder VetPoints economics — configurable,
   * config.nextRewardAt     not a committed reward scheme.
   * config.images           Product imagery resolved by Liquid.
   */
  function createMockAdapter(config) {
    config = config || {};

    var TODAY = config.today || '2026-08-21';
    var LATENCY = typeof config.latency === 'number' ? config.latency : 900;
    var IMAGES = config.images || {};

    var pointsPerRenewal = config.pointsPerRenewal || 100;
    var nextRewardAt = config.nextRewardAt || 800;
    var nextRewardName = config.nextRewardName || 'a free plush toy';

    var currency = config.currencyCode || 'USD';

    // Prototype catalogue prices, expressed per currency so that switching
    // market never reinterprets a USD number as another currency.
    var CATALOGUE = {
      freshwipes: { USD: 24.90, GBP: 19.90, EUR: 23.90, SEK: 269.00 },
      eyewipes:   { USD: 19.90, GBP: 15.90, EUR: 18.90, SEK: 215.00 },
      glovewipes: { USD: 18.90, GBP: 14.90, EUR: 17.90, SEK: 205.00 },
      earwipes:   { USD: 21.90, GBP: 17.50, EUR: 20.90, SEK: 235.00 },
      freshwipes_alt: { USD: 16.90, GBP: 13.50, EUR: 15.90, SEK: 179.00 }
    };

    function priceOf(key) {
      var table = CATALOGUE[key];
      var amount = table[currency];
      if (typeof amount !== 'number') {
        throw PortalError('missing_price', 'No ' + currency + ' price for ' + key);
      }
      return money(amount, currency);
    }

    // ---- mock state (stands in for the system of record) -------------
    var state = {
      customer: {
        id: 'cus_mock_1',
        firstName: 'Margaret',
        lastName: 'Ellis',
        email: config.email || 'margaret.ellis@gmail.com',
        initials: 'ME',
        pets: [
          { name: 'Bella', breed: 'French Bulldog', initial: 'B' },
          { name: 'Max', breed: 'Labrador', initial: 'M' }
        ]
      },
      session: null,
      subscription: {
        id: 'sub_48210',
        reference: '#VP-48210',
        status: 'active',           // active | paused | cancelled
        name: 'Daily routine subscription',
        startedOn: '2025-03-12',
        deliveriesSoFar: 9,
        intervalDays: 60,
        nextOrderDate: '2026-09-08',
        pausedUntil: null,
        cancelledOn: null,
        discountRate: 0.10,
        shippingFree: true,
        lines: [
          {
            id: 'line_fresh',
            productKey: 'freshwipes',
            productId: 'gid://shopify/Product/10549270642955',
            title: 'FreshWipes jar',
            subtitle: "for Bella & Max",
            quantity: 2,
            image: IMAGES.freshwipes || '',
            imagePending: false
          },
          {
            id: 'line_eye',
            productKey: 'eyewipes',
            productId: 'gid://shopify/Product/10222481572107',
            title: 'EyeWipes jar',
            subtitle: "Bella's tear lines",
            quantity: 1,
            image: IMAGES.eyewipes || '',
            imagePending: false
          }
        ],
        oneTimeItems: [],
        address: {
          name: 'Margaret Ellis',
          line1: '214 Wren Street',
          line2: 'Apt 3B',
          city: 'Portland',
          province: 'OR',
          zip: '97209',
          country: 'United States',
          phone: '(503) 555-0142'
        },
        payment: { brand: 'Visa', last4: '4242', expiry: '04/28' }
      },
      inactiveSubscriptions: [
        {
          id: 'sub_39104',
          reference: '#VP-39104',
          status: 'cancelled',
          name: 'GloveWipes pack',
          meta: 'Was every 30 days · cancelled 4 June 2026',
          image: IMAGES.glovewipes || '',
          points: 640
        },
        {
          id: 'sub_28873',
          reference: '#VP-28873',
          status: 'completed',
          name: 'FreshWipes starter routine',
          meta: '3 of 3 deliveries sent · ended 9 Jan 2026',
          image: IMAGES.freshwipes || ''
        }
      ],
      points: typeof config.points === 'number' ? config.points : 640,
      pointsHistory: [
        { label: 'Delivery renewed', date: '2026-07-10', delta: pointsPerRenewal },
        { label: 'Delivery renewed', date: '2026-05-11', delta: pointsPerRenewal },
        { label: 'Redeemed: free plush toy', date: '2026-04-02', delta: -300 },
        { label: 'Delivery renewed', date: '2026-03-12', delta: pointsPerRenewal },
        { label: 'Referred a friend', date: '2026-02-18', delta: 140 }
      ],
      orders: [
        { id: '10442', date: '2026-07-10', items: 'FreshWipes ×2, EyeWipes ×1', status: 'Delivered' },
        { id: '10218', date: '2026-05-11', items: 'FreshWipes ×2, EyeWipes ×1', status: 'Delivered' },
        { id: '10090', date: '2026-03-12', items: 'FreshWipes ×2', status: 'Delivered' },
        { id: '09934', date: '2026-01-11', items: 'FreshWipes ×2, GloveWipes ×1', status: 'Delivered' }
      ]
    };

    // Failure injection for QA of the API-error and expired-link states.
    var failNext = null;

    function maybeFail() {
      if (!failNext) return null;
      var f = failNext;
      failNext = null;
      return PortalError(f.code, f.message, f.reference);
    }

    /** Simulate a round-trip, honouring any queued failure. */
    function respond(producer) {
      return delay(LATENCY).then(function () {
        var err = maybeFail();
        if (err) throw err;
        return producer();
      });
    }

    // ---- derived pricing --------------------------------------------

    function lineTotal(line) {
      return multiplyMoney(priceOf(line.productKey), line.quantity);
    }

    function pricing(sub) {
      var subtotal = money(0, currency);
      sub.lines.forEach(function (l) { subtotal = addMoney(subtotal, lineTotal(l)); });
      var discount = money(subtotal.amount * sub.discountRate, currency);
      var oneTime = money(0, currency);
      sub.oneTimeItems.forEach(function (i) {
        oneTime = addMoney(oneTime, multiplyMoney(priceOf(i.productKey), i.quantity));
      });
      return {
        subtotal: subtotal,
        discount: discount,
        shipping: money(0, currency),
        oneTime: oneTime,
        total: money(subtotal.amount - discount.amount, currency),
        totalWithOneTime: money(subtotal.amount - discount.amount + oneTime.amount, currency)
      };
    }

    /** The single shape the UI renders a subscription from. */
    function projectSubscription() {
      var s = state.subscription;
      var p = pricing(s);
      return {
        id: s.id,
        reference: s.reference,
        status: s.status,
        name: s.name,
        startedOn: s.startedOn,
        deliveriesSoFar: s.deliveriesSoFar,
        intervalDays: s.intervalDays,
        nextOrderDate: s.nextOrderDate,
        pausedUntil: s.pausedUntil,
        cancelledOn: s.cancelledOn,
        daysUntilNextOrder: Math.max(0, daysBetween(TODAY, s.nextOrderDate)),
        currencyCode: currency,
        lines: s.lines.map(function (l) {
          return {
            id: l.id,
            title: l.title,
            subtitle: l.subtitle,
            quantity: l.quantity,
            image: l.image,
            imagePending: l.imagePending,
            unitPrice: priceOf(l.productKey),
            linePrice: lineTotal(l)
          };
        }),
        oneTimeItems: s.oneTimeItems.map(function (i) {
          return { id: i.id, title: i.title, quantity: i.quantity, unitPrice: priceOf(i.productKey) };
        }),
        pricing: p,
        address: clone(s.address),
        payment: clone(s.payment),
        shippingFree: s.shippingFree,
        discountRate: s.discountRate
      };
    }

    function projectLoyalty() {
      return {
        points: state.points,
        perRenewal: pointsPerRenewal,
        nextRewardAt: nextRewardAt,
        nextRewardName: nextRewardName,
        toNextReward: Math.max(0, nextRewardAt - state.points),
        progressPercent: Math.min(100, Math.round((state.points / nextRewardAt) * 100)),
        placeholderEconomics: true,
        history: clone(state.pointsHistory)
      };
    }

    // ---- the adapter surface ----------------------------------------

    var adapter = {
      kind: 'mock',
      isMock: true,

      /* --- market / currency --- */
      getCurrency: function () { return currency; },
      setCurrency: function (code) {
        if (VetPetsPortal.SUPPORTED_CURRENCIES.indexOf(code) === -1) {
          throw PortalError('unsupported_currency', code + ' is not supported');
        }
        currency = code;
        return Promise.resolve(code);
      },
      getSupportedCurrencies: function () { return VetPetsPortal.SUPPORTED_CURRENCIES.slice(); },

      /* --- QA hooks (mock only) --- */
      failNextCall: function (code, message, reference) {
        failNext = { code: code, message: message, reference: reference };
      },
      setStatus: function (status) {
        state.subscription.status = status;
        if (status === 'paused' && !state.subscription.pausedUntil) {
          state.subscription.pausedUntil = addMonths(TODAY, 2);
        }
        if (status === 'active') {
          state.subscription.pausedUntil = null;
          state.subscription.cancelledOn = null;
        }
        if (status === 'cancelled') state.subscription.cancelledOn = TODAY;
        return Promise.resolve(projectSubscription());
      },
      getToday: function () { return TODAY; },

      /* --- auth (magic link) --- */
      requestMagicLink: function (email) {
        return respond(function () {
          state.customer.email = email || state.customer.email;
          // Deliberately neutral: never reveals whether the address exists.
          return { ok: true, email: state.customer.email, expiresInMinutes: 15 };
        });
      },
      verifyMagicLink: function (token) {
        return respond(function () {
          if (token === 'expired') throw PortalError('expired_link', 'This link has expired');
          state.session = { token: 'mock-session', expiresAt: null };
          return { ok: true };
        });
      },
      signOut: function () {
        state.session = null;
        return Promise.resolve({ ok: true });
      },

      /* --- reads --- */
      getCustomer: function () {
        return respond(function () { return clone(state.customer); });
      },
      listSubscriptions: function () {
        return respond(function () {
          return { active: [projectSubscription()], inactive: clone(state.inactiveSubscriptions) };
        });
      },
      getSubscription: function () {
        return respond(function () { return projectSubscription(); });
      },
      listDeliveries: function () {
        return respond(function () {
          var s = state.subscription;
          var p = pricing(s);
          var upcoming = {
            date: s.nextOrderDate,
            title: 'Next delivery',
            items: s.lines.map(function (l) { return l.title.replace(' jar', '').replace(' pack', '') + ' ×' + l.quantity; }).join(', '),
            total: p.total,
            status: s.status === 'active' ? 'Scheduled' : (s.status === 'paused' ? 'Paused' : 'Cancelled')
          };
          var past = state.orders.map(function (o) {
            return {
              orderId: o.id,
              date: o.date,
              items: o.items,
              amount: money(p.total.amount, currency),
              status: o.status
            };
          });
          return { upcoming: upcoming, past: past };
        });
      },
      getLoyalty: function () {
        return respond(function () { return projectLoyalty(); });
      },
      listRewards: function () {
        return respond(function () {
          return [
            { id: 'rw_glove', name: 'GloveWipes pack', cost: 300, image: IMAGES.glovewipes || '', imagePending: false },
            { id: 'rw_plush', name: 'Free plush toy', cost: nextRewardAt, image: IMAGES.reward || '', imagePending: !IMAGES.reward },
            { id: 'rw_credit', name: 'Credit on your next delivery', cost: 600, image: IMAGES.freshwipes || '', imagePending: false },
            { id: 'rw_eye', name: 'EyeWipes jar', cost: 1200, image: IMAGES.eyewipes || '', imagePending: false }
          ].map(function (r) {
            r.affordable = state.points >= r.cost;
            r.pointsToGo = Math.max(0, r.cost - state.points);
            return r;
          });
        });
      },
      listSwapOptions: function () {
        return respond(function () {
          return [
            {
              id: 'opt_ear', productKey: 'earwipes', name: 'EarWipes jar',
              meta: 'Ear care · packshot photo pending', price: priceOf('earwipes'),
              image: '', imagePending: true
            },
            {
              id: 'opt_glove', productKey: 'glovewipes', name: 'GloveWipes pack',
              meta: 'Full-body wipe down after walks', price: priceOf('glovewipes'),
              image: IMAGES.glovewipes || '', imagePending: false
            },
            {
              id: 'opt_fresh_alt', productKey: 'freshwipes_alt', name: 'FreshWipes jar (alternate size)',
              meta: 'Alternate size · size to be confirmed', price: priceOf('freshwipes_alt'),
              image: IMAGES.freshwipes || '', imagePending: false
            }
          ];
        });
      },
      listAddonOptions: function () {
        return respond(function () {
          return [
            {
              id: 'add_glove', productKey: 'glovewipes', name: 'GloveWipes pack',
              meta: 'One-time · ships with next order', price: priceOf('glovewipes'),
              image: IMAGES.glovewipes || '', imagePending: false
            },
            {
              id: 'add_eye', productKey: 'eyewipes', name: 'EyeWipes jar',
              meta: 'One-time extra jar', price: priceOf('eyewipes'),
              image: IMAGES.eyewipes || '', imagePending: false
            },
            {
              id: 'add_fresh_alt', productKey: 'freshwipes_alt', name: 'FreshWipes jar (alternate size)',
              meta: 'One-time · size to be confirmed', price: priceOf('freshwipes_alt'),
              image: IMAGES.freshwipes || '', imagePending: false
            }
          ];
        });
      },

      /* --- mutations ---------------------------------------------------
       * Every mutation takes an idempotencyKey so a retry after a timeout
       * cannot double-apply. The real adapter must forward it to the
       * backend, which forwards it to the system of record.
       * ---------------------------------------------------------------- */

      skipNextDelivery: function (id, opts) {
        return respond(function () {
          var s = state.subscription;
          s.nextOrderDate = addDays(s.nextOrderDate, s.intervalDays);
          return projectSubscription();
        });
      },
      delayNextDelivery: function (id, days, opts) {
        return respond(function () {
          var s = state.subscription;
          s.nextOrderDate = addDays(s.nextOrderDate, days);
          return projectSubscription();
        });
      },
      rescheduleNextDelivery: function (id, isoDate, opts) {
        return respond(function () {
          state.subscription.nextOrderDate = isoDate;
          return projectSubscription();
        });
      },
      setFrequency: function (id, intervalDays, opts) {
        return respond(function () {
          state.subscription.intervalDays = intervalDays;
          return projectSubscription();
        });
      },
      pause: function (id, months, opts) {
        return respond(function () {
          var s = state.subscription;
          s.status = 'paused';
          s.pausedUntil = addMonths(TODAY, months);
          return projectSubscription();
        });
      },
      resume: function (id, opts) {
        return respond(function () {
          var s = state.subscription;
          s.status = 'active';
          s.pausedUntil = null;
          s.nextOrderDate = addDays(TODAY, 3);
          return projectSubscription();
        });
      },
      setQuantities: function (id, quantities, opts) {
        return respond(function () {
          state.subscription.lines.forEach(function (l) {
            if (Object.prototype.hasOwnProperty.call(quantities, l.id)) {
              l.quantity = Math.max(0, Math.min(50, quantities[l.id]));
            }
          });
          return projectSubscription();
        });
      },
      swapProduct: function (id, optionId, opts) {
        return respond(function () {
          var map = {
            opt_ear: { key: 'earwipes', title: 'EarWipes jar', subtitle: 'Ear care · packshot photo pending', image: '', pending: true },
            opt_glove: { key: 'glovewipes', title: 'GloveWipes pack', subtitle: 'Full-body wipe down after walks', image: IMAGES.glovewipes || '', pending: false },
            opt_fresh_alt: { key: 'freshwipes_alt', title: 'FreshWipes jar (alternate size)', subtitle: 'Alternate size · size to be confirmed', image: IMAGES.freshwipes || '', pending: false }
          };
          var pick = map[optionId];
          if (!pick) throw PortalError('unknown_option', 'Unknown swap option');
          var target = state.subscription.lines[1] || state.subscription.lines[0];
          target.productKey = pick.key;
          target.title = pick.title;
          target.subtitle = pick.subtitle;
          target.image = pick.image;
          target.imagePending = pick.pending;
          return projectSubscription();
        });
      },
      addOneTimeItem: function (id, optionId, opts) {
        return respond(function () {
          var map = {
            add_glove: { key: 'glovewipes', title: 'GloveWipes pack' },
            add_eye: { key: 'eyewipes', title: 'EyeWipes jar' },
            add_fresh_alt: { key: 'freshwipes_alt', title: 'FreshWipes jar (alternate size)' }
          };
          var pick = map[optionId];
          if (!pick) throw PortalError('unknown_option', 'Unknown add-on');
          state.subscription.oneTimeItems = [{ id: optionId, productKey: pick.key, title: pick.title, quantity: 1 }];
          return projectSubscription();
        });
      },
      previewOneTimeItem: function (optionId) {
        var map = { add_glove: 'glovewipes', add_eye: 'eyewipes', add_fresh_alt: 'freshwipes_alt' };
        var key = map[optionId];
        if (!key) return null;
        var p = pricing(state.subscription);
        return addMoney(p.total, priceOf(key));
      },
      updateAddress: function (id, address, opts) {
        return respond(function () {
          state.subscription.address = Object.assign({}, state.subscription.address, address);
          return projectSubscription();
        });
      },

      /**
       * Payment updates never happen in this portal. The backend mints a
       * short-lived hosted-page URL from the processor and we redirect.
       * The mock returns a marker the UI treats as "no real redirect".
       */
      createPaymentUpdateSession: function (id) {
        return respond(function () {
          return { redirectUrl: null, hosted: true, mock: true, expiresInMinutes: 15 };
        });
      },

      redeemReward: function (rewardId, opts) {
        return respond(function () {
          var costs = { rw_glove: 300, rw_plush: nextRewardAt, rw_credit: 600, rw_eye: 1200 };
          var cost = costs[rewardId];
          if (typeof cost !== 'number') throw PortalError('unknown_reward', 'Unknown reward');
          if (state.points < cost) throw PortalError('insufficient_points', 'Not enough points');
          state.points -= cost;
          return projectLoyalty();
        });
      },

      cancel: function (id, reasonCode, note, opts) {
        return respond(function () {
          var s = state.subscription;
          s.status = 'cancelled';
          s.cancelledOn = TODAY;
          s.cancelReason = reasonCode;
          return projectSubscription();
        });
      },
      reactivate: function (id, startOffsetDays, opts) {
        return respond(function () {
          var s = state.subscription;
          s.status = 'active';
          s.cancelledOn = null;
          s.pausedUntil = null;
          s.nextOrderDate = addDays(TODAY, startOffsetDays || 0);
          return projectSubscription();
        });
      }
    };

    return adapter;
  }

  VetPetsPortal.createMockAdapter = createMockAdapter;

  /* ---------------------------------------------------------------
   * HTTP adapter — deliberately not implemented yet.
   *
   * When the Phoenix/Solvpath contract is proven, implement this with
   * the SAME method names and the SAME return shapes as the mock. It
   * must call a same-origin App Proxy path only; it must never receive
   * an API key, and it must never be handed a vendor hostname.
   * --------------------------------------------------------------- */
  VetPetsPortal.createHttpAdapter = function (options) {
    var base = (options && options.basePath) || '/apps/subscriptions';
    throw PortalError(
      'not_implemented',
      'The live adapter is not wired up. It must call ' + base +
      ' (same-origin App Proxy) and is blocked on the Phoenix/Solvpath API proof gate.'
    );
  };
})(window);
