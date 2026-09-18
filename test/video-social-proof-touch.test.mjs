/**
 * Video social proof - mobile swipe regression.
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * The carousel is a plain overflow-x/scroll-snap rail with no custom JS
 * drag/pointer handling at all - arrows and dots move it with scrollTo(),
 * everything else is native browser touch scrolling. That means the entire
 * gesture depends on one CSS declaration: `.vp-vsp__rail`'s `touch-action`.
 *
 * It shipped as `pan-y pinch-zoom`, which tells the browser "only vertical
 * panning is a native gesture here" - on the one element that only ever
 * scrolls horizontally. That silently killed finger-swipe on every touch
 * device while leaving desktop (mouse, arrow buttons, scrollTo) untouched,
 * which is exactly the reported split. The fix is `pan-x pinch-zoom`, which
 * matches what the adjacent comment always said the intent was.
 *
 * Run with:  node --test test/video-social-proof-touch.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(resolve(here, '..', ...p), 'utf8');

const src = read('sections', 'video-social-proof.liquid');

function rule(selector) {
  const re = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'
  );
  const m = re.exec(src);
  assert.ok(m, `expected to find a ${selector} rule`);
  return m[1];
}

describe('video social proof carousel - touch behaviour', () => {
  test('the rail hands horizontal panning to the browser, not vertical', () => {
    const railCss = rule('.vp-vsp__rail');
    assert.match(
      railCss,
      /touch-action:\s*pan-x\s+pinch-zoom;/,
      'rail must allow native horizontal panning (pan-x) - pan-y disables the only swipe this element performs'
    );
    assert.doesNotMatch(
      railCss,
      /touch-action:\s*pan-y\b/,
      'pan-y here is the regression: it blocks horizontal touch scrolling on the rail'
    );
  });

  test('native scroll-snap machinery is untouched', () => {
    const railCss = rule('.vp-vsp__rail');
    assert.match(railCss, /overflow-x:\s*auto;/);
    assert.match(railCss, /scroll-snap-type:\s*x mandatory;/);
  });

  test('pinch-zoom is preserved alongside the pan fix', () => {
    const railCss = rule('.vp-vsp__rail');
    assert.match(railCss, /pinch-zoom/);
  });

  test('no custom touch/pointer drag handlers were introduced', () => {
    // This carousel is native-scroll only; adding manual drag/pointer
    // tracking here would reopen the stuck-drag-state failure mode the
    // section's own comments say this design avoids.
    assert.doesNotMatch(src, /addEventListener\(\s*['"](touchstart|touchmove|pointerdown|pointermove)['"]/);
    assert.doesNotMatch(src, /setPointerCapture/);
    assert.doesNotMatch(src, /preventDefault\(/);
  });

  test('play, mute and card-link affordances still render inside each card', () => {
    assert.match(src, /data-vp-vsp-play/);
    assert.match(src, /data-vp-vsp-mute/);
    assert.match(src, /data-vp-vsp-video/);
  });

  test('desktop arrow navigation is unchanged', () => {
    const desktopBlock = /@media screen and \(min-width: 990px\) \{([\s\S]*?)\n  \}\n\n  \/\* Mobile padding/.exec(src);
    assert.ok(desktopBlock, 'expected the desktop media query block');
    assert.match(desktopBlock[1], /\.vp-vsp__arrow \{[\s\S]*?display: flex;/);
  });

  test('reduced-motion still disables smooth scrolling, not the gesture', () => {
    const reduceBlock = /@media \(prefers-reduced-motion: reduce\) \{([^}]*\{[^}]*\}[^}]*)\}/.exec(src);
    assert.ok(reduceBlock, 'expected the prefers-reduced-motion block');
    assert.match(reduceBlock[1], /\.vp-vsp__rail \{\s*scroll-behavior: auto;\s*\}/);
  });
});
