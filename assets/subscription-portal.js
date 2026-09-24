/*
 * VetPets Subscription Portal — UI controller
 * ------------------------------------------------------------------
 * Owns navigation, rendering, sheets, pending/toast/error states and
 * focus management. It never fetches and never formats currency on its
 * own — everything comes from the adapter, so replacing the mock with
 * the live backend requires no change in this file.
 *
 * Scope is the Phoenix-supported surface: skip, delay/reschedule, cancel
 * and reactivate. Quantity, swap, one-time item, address, card and
 * frequency/pause/resume are not portal capabilities and have no code
 * path here.
 */
(function (window, document) {
  'use strict';

  var NS = window.VetPetsPortal;
  if (!NS) return;

  var SCREENS_WITH_CHROME = {
    login: false, sent: false, expired: false, loading: false, error: false
  };

PLACEHOLDER_WILL_REPLACE