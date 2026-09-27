(function () {
  var root = document.getElementById('freshbreath-ebook-pdp');
  if (!root || root.dataset.fbInit) return;
  root.dataset.fbInit = 'true';

  var GALLERY = JSON.parse(root.querySelector('#fb-gallery-data').textContent);
  var mainImg = root.querySelector('[data-fb-gallery-main] img');
  var thumbs = Array.prototype.slice.call(root.querySelectorAll('[data-fb-thumb]'));

  function selectGallery(i) {
    var g = GALLERY[i];
    if (!g || !mainImg) return;
    mainImg.src = g.src;
    mainImg.alt = g.alt;
    mainImg.className = 'fb-' + g.kind;
    thumbs.forEach(function (t, ti) {
      t.setAttribute('aria-selected', ti === i ? 'true' : 'false');
    });
  }
  thumbs.forEach(function (t, i) {
    t.addEventListener('click', function () { selectGallery(i); });
  });

  /* ---------- FAQ accordion ---------- */
  var faqItems = Array.prototype.slice.call(root.querySelectorAll('[data-fb-faq-item]'));
  faqItems.forEach(function (item) {
    var btn = item.querySelector('[data-fb-faq-toggle]');
    btn.addEventListener('click', function () {
      var isOpen = item.getAttribute('data-open') === 'true';
      faqItems.forEach(function (i2) {
        i2.setAttribute('data-open', 'false');
        i2.querySelector('[data-fb-faq-toggle]').setAttribute('aria-expanded', 'false');
        i2.querySelector('[data-fb-faq-sign]').textContent = '+';
      });
      if (!isOpen) {
        item.setAttribute('data-open', 'true');
        btn.setAttribute('aria-expanded', 'true');
        item.querySelector('[data-fb-faq-sign]').textContent = '−';
      }
    });
  });

  /* ---------- bundle teaser scroll ---------- */
  var bundleLink = root.querySelector('[data-fb-goto-bundle]');
  var bundleBox = root.querySelector('#fb-bundle');
  if (bundleLink && bundleBox) {
    bundleLink.addEventListener('click', function (e) {
      e.preventDefault();
      var top = bundleBox.getBoundingClientRect().top + window.scrollY - 16;
      window.scrollTo({ top: top, behavior: 'smooth' });
    });
  }

  /* ---------- lightbox preview ---------- */
  var PAGES = JSON.parse(root.querySelector('#fb-pages-data').textContent);
  var lightbox = root.querySelector('[data-fb-lightbox]');
  var lbImg = lightbox.querySelector('img');
  var lbCaption = lightbox.querySelector('[data-fb-lb-caption]');
  var lbIndex = -1;

  function openLightbox(i) {
    lbIndex = i;
    var p = PAGES[i];
    lbImg.src = p.src;
    lbImg.alt = p.alt;
    lbCaption.textContent = p.label + ' · Page ' + p.num;
    lightbox.setAttribute('data-open', 'true');
  }
  function closeLightbox() {
    lightbox.setAttribute('data-open', 'false');
    lbIndex = -1;
  }
  function stepLightbox(d) {
    if (lbIndex < 0) return;
    openLightbox((lbIndex + d + PAGES.length) % PAGES.length);
  }

  Array.prototype.slice.call(root.querySelectorAll('[data-fb-open-page]')).forEach(function (btn) {
    btn.addEventListener('click', function () {
      openLightbox(parseInt(btn.getAttribute('data-fb-open-page'), 10));
    });
  });
  root.querySelector('[data-fb-lb-close]').addEventListener('click', closeLightbox);
  root.querySelector('[data-fb-lb-prev]').addEventListener('click', function (e) { e.stopPropagation(); stepLightbox(-1); });
  root.querySelector('[data-fb-lb-next]').addEventListener('click', function (e) { e.stopPropagation(); stepLightbox(1); });
  lightbox.addEventListener('click', function (e) { if (e.target === lightbox) closeLightbox(); });
  lbImg.addEventListener('click', function (e) { e.stopPropagation(); });
  document.addEventListener('keydown', function (e) {
    if (lbIndex < 0) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowRight') stepLightbox(1);
    if (e.key === 'ArrowLeft') stepLightbox(-1);
  });

  /* ---------- sticky bar ---------- */
  var buySection = root.querySelector('[data-fb-buy-section]');
  var sticky = root.querySelector('[data-fb-sticky]');
  if (buySection && sticky) {
    var onScroll = function () {
      var visible = buySection.getBoundingClientRect().bottom < 80;
      sticky.setAttribute('data-visible', visible ? 'true' : 'false');
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ---------- sticky ATC proxies the real add-to-cart button ---------- */
  var realAtc = root.querySelector('[data-fb-atc-real]');
  Array.prototype.slice.call(root.querySelectorAll('[data-fb-atc-proxy]')).forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (realAtc) realAtc.click();
    });
  });
})();
