# Captured storefront fixtures

These are **real captures**, not hand-written samples. They exist so a test can
assert a claim about production behaviour instead of restating an assumption.

## preview-root.html

The portal root element as the storefront actually rendered it on unpublished
theme `181692858635`, captured after Shopify's preview redirect.

Reproduce with:

```sh
curl -sL -c jar -b jar -w '%{url_effective}\n' -o page.html \
  "https://shopvetpets.com/pages/subscription-policy?spp_dev=1&view=subscription-portal&preview_theme_id=181692858635"
```

Two things matter in the result, and the tests assert both:

1. `%{url_effective}` contains **no** `preview_theme_id`. Shopify consumes the
   parameter into the HttpOnly `_shopify_essential` cookie and 302s to a clean
   URL, so nothing in the browser can read it back.
2. The rendered root still carries `data-spp-theme-id="181692858635"`, because
   Liquid emits the theme identity server-side, where the cookie is honoured.

## preview-redirect.json

The redirect itself: what was requested, and the exact `Location` Shopify
answered with.
