# FreshWipes offer lander (variant B)

Native theme build of the `lander1pdp` landing page, for an A/B test against the
GemPages control at https://shopvetpets.com/pages/lander1pdp.

The only intended differences from the control are **section order** (the offer
moved to the top) and **one new proof section** (`dirty-wipe-proof`).

## Template

| | |
|---|---|
| Template file | `templates/page.freshwipes-offer.json` |
| Template name in admin | **page.freshwipes-offer** |
| Assigned page | **Lander1pdp B** — handle `lander1pdp-b` (already created, **draft**) |
| Dev theme | `vetpets-theme/dev`, id `181692858635` (unpublished, tracks this branch) |

Preview (you must be logged into Shopify admin — the page is a draft, so it
returns 404 to everyone else):

```
https://shopvetpets.com/pages/lander1pdp-b?preview_theme_id=181692858635
```

**To go live:** publish the page (Online Store → Pages → Lander1pdp B →
visibility) *and* merge `dev` into `main` so the template reaches the live
theme. Until the merge, the live theme has no `freshwipes-offer` template and
the page would fall back to the default page template.

## Files added

```
templates/page.freshwipes-offer.json   the page: section order + all content
sections/fwo-offer-hero.liquid         1. hero: H1, image, offer, price, CTA, trust row
sections/fwo-dirty-wipe-proof.liquid   2. NEW before/after wipe pair + caption
sections/fwo-mechanism.liquid          3. texture macro + product shot, named ingredients
sections/fwo-sticky-cta.liquid         4. sticky bottom bar (activates at this point)
sections/fwo-ugc-grid.liquid           5. 6 customer images + rating line
sections/fwo-comparison-table.liquid   6. 3 columns x 6 rows
sections/fwo-problem.liquid            7. "Dental Problems Start Hidden"
sections/fwo-objection.liquid          8. "Most dogs dental care are designed to fail"
sections/fwo-offer-repeat.liquid       9. same offer + guarantee + scarcity
snippets/fwo-image.liquid              shared image renderer (picker or CDN url)
snippets/fwo-offer-card.liquid         shared buy block, used by sections 1 and 9
assets/freshwipes-offer.css            scoped stylesheet, every selector prefixed .fwo-
```

Sections 1 and 9 render the same buy block from one shared snippet, so the two
offers cannot drift apart. Both have their own settings — keep them in sync.

## Settings you need to fill in

### Required — the page ships with these empty

| Section | Setting | Notes |
|---|---|---|
| 2. Dirty wipe proof | Block "Clean wipe" → Image | No asset existed on the control. Empty slot. |
| 2. Dirty wipe proof | Block "Used wipe" → Image | Same. |
| 5. UGC grid | 6 × "Customer image" → Image | The control renders these through an app, so no URLs were recoverable. |

### Recommended — check before launch

| Section | Setting | Notes |
|---|---|---|
| 1. Offer hero | **Price** / **Compare-at price** | Empty by default; the control page does not expose a price, so nothing was assumed. The price row is hidden while both are blank. |
| 9. Offer repeat | **Price** / **Compare-at price** | Must match the hero exactly. |
| 6. Comparison table | Row check/cross values | **Verify these.** See the note below. |
| 1. Offer hero | **Theme header height (mobile)** | Default 60px. Raise it if the announcement bar is showing, otherwise the hero can overflow the first viewport. |
| 3. Mechanism | Ingredient → Short description | Blank on purpose — do not add health claims without compliance sign-off. |

### Comparison table — needs your confirmation

The control renders its tick/cross icons lazily, so the actual per-cell pattern
was not recoverable from the live page. Row labels, column labels, column images
and the "Time per day" values **are** taken from the control verbatim. The
check/cross marks on the other five rows are a sensible default and should be
checked against the control before the test goes live:

| Row | FreshWipes | Toothbrush + Toothpaste | Dental powders |
|---|---|---|---|
| Direct contact with plaque | ✓ | ✓ | ✕ |
| Most dogs accept it | ✓ | ✕ | ✓ |
| You can see it working | ✓ | ✓ | ✕ |
| Stress-free solution | ✓ | ✕ | ✓ |
| Effective on the gumline | ✓ | ✓ | ✕ |
| Time per day | 30 seconds - 1 minute | 5-10 minutes | 30 seconds - 1 minute |

Each row is a block with a Check / Cross / Text selector per column.

## Images

Images reuse the control's existing Shopify CDN assets — nothing new was
generated. Every image slot has two settings:

* **Image** — an image picker. Wins whenever it is set.
* **Image URL fallback** — the control's CDN url, prefilled in the template.

Picking an image in the editor overrides the URL. If you do use the URL field,
also fill **Image URL width/height** so the page does not shift as it loads.

Assets wired up from the control:

| Where | File |
|---|---|
| 1. Hero | `gempages_577888762156024773-2f099bba-…-31a23fe77405.png` (2000×1080) |
| 3. Mechanism, texture | `5_reasons_why_page_9.webp` (1600×900) |
| 3. Mechanism, product | `5_reasons_why_page_11.jpg` (1600×900) |
| 6. Comparison, col 1 | `gempages_577888762156024773-ed0d10ff-…-1570a31387e1.webp` (1080×1080) |
| 6. Comparison, col 2 | `Din_Hunds_Leende_spelar_ocksa_roll_80.webp` (1080×1080) |
| 6. Comparison, col 3 | `Din_Hunds_Leende_spelar_ocksa_roll_82.webp` (1080×1080) |
| 7. Problem | `5_reasons_why_page_7.webp` (1600×900) |
| 9. Offer repeat | `Din_Hunds_Leende_spelar_ocksa_roll_-_2026-06-15T160800.859.jpg` (1080×1080) |

Two further control assets were left unused, available if you want them:
`gempages_577888762156024773-4338bf83-…-5ab506e78c03.png` (1080×1080) and
`Pre-lander_IMG_6.jpg` (1600×900).

## How the build meets the brief

* **Mobile-first.** Base CSS targets 390px; desktop rules sit behind
  `min-width: 750px` (the theme's breakpoint).
* **CTA above the fold.** The hero is a flex column sized to
  `100svh − header offset`, with the image as the only flexible track. However
  long the H1 wraps, the image shrinks rather than pushing the CTA down.
* **Sticky bar.** `fwo-sticky-cta` drops a zero-height sentinel at its position
  in the flow (after section 3). An `IntersectionObserver` reveals the bar once
  the sentinel scrolls off the top, then disconnects, so the bar stays for the
  rest of the page. ~40 lines of vanilla JS in a custom element, no library.
* **Performance.** No external JS and no extra web fonts. Everything below the
  fold is `loading="lazy"`; the hero image is `eager` + `fetchpriority="high"`.
  All images carry width/height or a CSS `aspect-ratio` wrapper to prevent CLS.
* **Schema-driven.** Every string and image is a setting; repeatable content
  (trust row, proof pair, UGC tiles, comparison rows, badges, ingredients) is
  blocks, so it reorders and edits in the theme editor without code changes.
* **No hardcoded colours.** Only the theme's own custom properties
  (`--color-foreground`, `--color-button`, `--color-base-accent-1`, …).
* **Accessible.** Real `<a>` elements, a real `<table>` with scoped headers,
  alt text on every image, 44px+ tap targets, visible focus outlines, and
  `prefers-reduced-motion` respected on the sticky bar.

## Deliberately not included

* **The "Dr. Anders Larsson, DVM" quote and photo.** Omitted for compliance —
  no named veterinarian endorsements. (It was not present on the live control
  page either.)
* **Inline add-to-cart.** Every CTA links to the PDP. Subscription selling plans
  are handled by Loop + Katching on the PDP, so rebuilding them here would break
  the single-variable rule and risk the subscription flow.

## One deviation from the brief: the CTA link is relative

The brief specified the absolute URL
`https://shopvetpets.com/products/freshwipes-kit-protects-against-dental-diseases`.
The template ships the same destination as a **relative path** instead:
`/products/freshwipes-kit-protects-against-dental-diseases`.

Two reasons:

1. Shopify rejects an absolute URL as the *schema default* of a `url` setting.
   The three sections carrying one silently failed to sync to the theme until
   the default was removed.
2. On a preview theme an absolute URL drops the `preview_theme_id`, so clicking
   the CTA would bounce the tester out of the preview and onto the live theme.
   A relative path keeps both the preview and the locale context.

For a visitor on shopvetpets.com the destination is byte-identical. If you want
the absolute URL anyway, set it per section in the theme editor under
**Call to action → Button link** — it is only the schema *default* that Shopify
refuses, not the value.
* **`main-page`.** The template renders only the nine sections above, so the
  Shopify page body content is not output. All copy lives in section settings.
