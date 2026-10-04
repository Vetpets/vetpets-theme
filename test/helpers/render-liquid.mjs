/**
 * Minimal Shopify-flavoured Liquid renderer for the campaign-mode tests.
 * Uses liquidjs when it can be resolved (LIQUIDJS_DIR env var, or a normal
 * node_modules install); otherwise `loadLiquid()` resolves to null and the
 * render tests skip themselves. It is NOT a Shopify emulator — unknown filters
 * pass their input through and Shopify-only tags are stubbed — so it is used
 * only to prove WHICH branch of a section/layout is emitted for a given
 * `settings.*_campaign_mode`.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function loadLiquid() {
  const req = createRequire(import.meta.url);
  const paths = [process.env.LIQUIDJS_DIR, root].filter(Boolean);
  let mod = null;
  for (const p of paths) {
    try { mod = req(req.resolve('liquidjs', { paths: [p] })); break; } catch { /* try next */ }
  }
  if (!mod) return null;
  const { Liquid, Tag } = mod;
  const engine = new Liquid({
    root: [resolve(root, 'snippets'), resolve(root, 'sections')],
    extname: '.liquid',
    strictFilters: false,
    strictVariables: false,
    jsTruthy: false
  });
  const swallow = (name) => engine.registerTag(name, class extends Tag {
    constructor(token, remain, liquid) {
      super(token, remain, liquid);
      this.tpls = [];
      const end = 'end' + name;
      const stream = liquid.parser.parseStream(remain).on('tag:' + end, () => stream.stop()).on('template', (t) => this.tpls.push(t)).on('end', () => { throw new Error(`tag ${name} not closed`); });
      stream.start();
    }
    * render() { /* body intentionally dropped */ }
  });
  swallow('schema'); swallow('javascript'); swallow('stylesheet');
  const passthrough = (name) => engine.registerTag(name, class extends Tag {
    constructor(token, remain, liquid) {
      super(token, remain, liquid);
      this.tpls = [];
      const end = 'end' + name;
      const stream = liquid.parser.parseStream(remain).on('tag:' + end, () => stream.stop()).on('template', (t) => this.tpls.push(t)).on('end', () => { throw new Error(`tag ${name} not closed`); });
      stream.start();
    }
    * render(ctx, emitter) {
      if (name === 'style') emitter.write('<style>');
      yield this.liquid.renderer.renderTemplates(this.tpls, ctx, emitter);
      if (name === 'style') emitter.write('</style>');
    }
  });
  passthrough('form'); passthrough('paginate'); passthrough('style');
  engine.registerFilter('asset_url', (v) => `/assets/${v}`);
  engine.registerFilter('stylesheet_tag', (v) => `<link rel="stylesheet" href="${v}">`);
  engine.registerFilter('script_tag', (v) => `<script src="${v}"></script>`);
  engine.registerFilter('img_url', (v) => `${v}`);
  engine.registerFilter('image_url', (v) => `${v}`);
  engine.registerFilter('money', (v) => `$${v}`);
  engine.registerFilter('t', (v) => `${v}`);
  engine.registerFilter('json', (v) => JSON.stringify(v));
  engine.registerFilter('handleize', (v) => String(v).toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  return engine;
}

export function readText(rel) { return readFileSync(resolve(root, rel), 'utf8'); }
export const repoRoot = root;
