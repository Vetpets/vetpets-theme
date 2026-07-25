// Upsell product validation - TAG BASED VERSION
(function() {
  const MAIN_TAG = 'main-kit';
  const UPSELL_TAG = 'upsell-product';
  const productTagCache = {};

  function getProductTags(handle) {
    if (productTagCache[handle]) {
      return Promise.resolve(productTagCache[handle]);
    }
    return fetch(`/products/${handle}.js`)
      .then(res => res.json())
      .then(data => {
        const tags = data.tags || [];
        productTagCache[handle] = tags;
        return tags;
      })
      .catch(() => []);
  }

  function checkCartValidity() {
    return fetch('/cart.js')
      .then(res => res.json())
      .then(cart => {
        if (cart.items.length === 0) return { hasMain: false, hasUpsell: false, upsellItems: [], cart };
        return Promise.all(
          cart.items.map(item =>
            getProductTags(item.handle).then(tags => ({ ...item, tags }))
          )
        ).then(itemsWithTags => {
          const hasMain = itemsWithTags.some(item => item.tags.includes(MAIN_TAG));
          const upsellItems = itemsWithTags.filter(item => item.tags.includes(UPSELL_TAG));
          const hasUpsell = upsellItems.length > 0;
          return { hasMain, hasUpsell, upsellItems, cart };
        });
      });
  }

  function showBanner(message) {
    const existingBanner = document.querySelector('.upsell-warning-banner');
    if (existingBanner) existingBanner.remove();

    const banner = document.createElement('div');
    banner.className = 'upsell-warning-banner';
    banner.style.cssText = `
      position: fixed;
      top: 80px;
      left: 50%;
      transform: translateX(-50%);
      background: #ff6b6b;
      color: white;
      padding: 16px 24px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 99999;
      max-width: 90%;
      width: 500px;
      text-align: center;
      font-size: 15px;
      font-weight: 500;
      line-height: 1.4;
      animation: slideDown 0.3s ease;
    `;
    banner.innerHTML = message;

    if (!document.querySelector('#upsell-banner-style')) {
      const style = document.createElement('style');
      style.id = 'upsell-banner-style';
      style.textContent = `
        @keyframes slideDown {
          from { opacity: 0; transform: translateX(-50%) translateY(-20px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(banner);

    setTimeout(() => {
      banner.style.opacity = '0';
      banner.style.transition = 'opacity 0.3s ease';
      setTimeout(() => banner.remove(), 300);
    }, 6000);
  }

  function updateCartIcon(itemCount) {
    const cartIcons = document.querySelectorAll('[id*="cart-icon"], cart-icon-bubble, #cart-icon-bubble');
    cartIcons.forEach(icon => {
      const span = icon.querySelector('span');
      if (span) span.textContent = itemCount;
      if (itemCount === 0) {
        icon.style.display = 'none';
        icon.classList.add('hidden');
      } else {
        icon.style.display = '';
        icon.classList.remove('hidden');
      }
    });
  }

  function validateCart(showMessage = false) {
    return checkCartValidity().then(({ hasMain, hasUpsell, upsellItems }) => {
      if (!hasMain && hasUpsell) {
        return Promise.all(
          upsellItems.map(item =>
            fetch('/cart/change.js', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: item.key, quantity: 0 })
            })
          )
        ).then(() => {
          if (showMessage) {
            showBanner('⚠️ Upsell product removed.<br><strong>It can only be purchased with a main kit.</strong>');
          }
          return fetch('/cart.js')
            .then(res => res.json())
            .then(updatedCart => {
              updateCartIcon(updatedCart.item_count);
              return false;
            });
        });
      }
      return true;
    });
  }

  // BLOCK CHECKOUT BUTTON
  document.addEventListener('click', function(e) {
    const checkoutBtn = e.target.closest('button[name="checkout"], [name="checkout"], a[href="/checkout"], input[name="checkout"]');
    if (checkoutBtn) {
      e.preventDefault();
      e.stopImmediatePropagation();

      checkCartValidity().then(({ hasMain, hasUpsell }) => {
        if (hasUpsell && !hasMain) {
          showBanner('⚠️ Cannot checkout with upsell product only.<br><strong>Please add a main kit to your cart first.</strong>');
          validateCart(false);
        } else {
          window.location.href = '/checkout';
        }
      });
    }
  }, true);

  // Intercept fetch requests
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const url = args[0];

    if (typeof url === 'string' && url.includes('/cart/add')) {
      return originalFetch.apply(this, args).then(response => {
        const clonedResponse = response.clone();
        response.json().then(addedItem => {
          if (addedItem.handle) {
            getProductTags(addedItem.handle).then(tags => {
              if (tags.includes(UPSELL_TAG)) {
                setTimeout(() => validateCart(true), 100);
              }
            });
          }
        }).catch(() => {});
        return clonedResponse;
      });
    }

    if (typeof url === 'string' && (url.includes('/cart/change') || url.includes('/cart/update'))) {
      return originalFetch.apply(this, args).then(response => {
        const clonedResponse = response.clone();
        setTimeout(() => validateCart(true), 300);
        return clonedResponse;
      });
    }

    return originalFetch.apply(this, args);
  };

  document.addEventListener('DOMContentLoaded', function() {
    validateCart(false);

    const observer = new MutationObserver(function(mutations) {
      mutations.forEach(function(mutation) {
        const target = mutation.target;
        if (target.tagName === 'CART-DRAWER' && target.classList.contains('active')) {
          checkCartValidity().then(({ hasMain, hasUpsell }) => {
            if (hasUpsell && !hasMain) {
              target.classList.remove('active');
            }
          });
        }
      });
    });

    const cartDrawer = document.querySelector('cart-drawer');
    if (cartDrawer) {
      observer.observe(cartDrawer, {
        attributes: true,
        attributeFilter: ['class'],
        subtree: false
      });
    }
  });

})();
