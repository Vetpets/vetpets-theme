/* Mounts the Original-mode daily countdown strip (snippets/vp-daily-countdown.liquid)
   on the shared clock in assets/vp-countdown.js: ends 23:59:59 America/New_York daily. */
(function () {
  'use strict';
  if (!window.VPCountdown) return;
  window.VPCountdown.mount(document.querySelectorAll('[data-vp-dcd]'), { attr: 'data-vp-dcd', mode: 'daily-et' });
}());
