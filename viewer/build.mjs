// Build script.
//
// 1. Bundles third-party editor libraries into vendor/editor.js so the app
//    works fully offline (no CDN). The app code itself stays as plain,
//    unbundled ES modules — see app.js and src/.
// 2. Stamps sw.js with the list of app files and a content hash, so a new
//    deploy installs a fresh cache automatically.
//
//   node build.mjs          one-off build
//   node build.mjs --watch  rebuild the vendor bundle on change
//   node build.mjs --stamp  only re-stamp sw.js and index.html (after app/CSS edits; needs no dependencies)

import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const stampOnly = process.argv.includes('--stamp');

const bundleOptions = {
  entryPoints: ['src/vendor-entry.js'],
  bundle: true,
  format: 'esm',
  outfile: 'vendor/editor.js',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  target: ['es2022'],
  logLevel: 'info',
  legalComments: 'none',
};

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

/** Stamp the vendor bundle's content hash into index.html (import map + preload). */
async function stampVendor() {
  const hash = createHash('sha256').update(await readFile('vendor/editor.js')).digest('hex').slice(0, 12);
  const html = await readFile('index.html', 'utf8');
  const next = html.replace(/vendor\/editor\.js\?v=[0-9a-z]+/g, `vendor/editor.js?v=${hash}`);
  if (next !== html) { await writeFile('index.html', next); console.log(`index.html stamped: vendor ${hash}`); }
  return hash;
}

async function stampServiceWorker() {
  const vendorHash = await stampVendor();
  const roots = ['index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'vendor/editor.js', `vendor/editor.js?v=${vendorHash}`];
  const files = [
    ...roots,
    ...(await walk('src')).filter((f) => !f.endsWith('vendor-entry.js')),
    ...(await walk('icons')),
  ].map((f) => f.split(path.sep).join('/')).sort();

  const hash = createHash('sha256');
  for (const f of files) hash.update(await readFile(f.replace(/\?.*$/, '')));
  const version = hash.digest('hex').slice(0, 12);

  const assets = ['./', ...files].map((f) => `  '${f}',`).join('\n');
  const block = `/* BUILD:START */\nconst VERSION = '${version}';\nconst ASSETS = [\n${assets}\n];\n/* BUILD:END */`;
  const sw = await readFile('sw.js', 'utf8');
  const next = sw.replace(/\/\* BUILD:START \*\/[\s\S]*?\/\* BUILD:END \*\//, block);
  if (next !== sw) {
    await writeFile('sw.js', next);
    console.log(`sw.js stamped: version ${version}, ${files.length} assets`);
  }
}

if (stampOnly) {
  await stampServiceWorker();
} else if (watch) {
  const esbuild = await import('esbuild');
  const ctx = await esbuild.context({
    ...bundleOptions,
    plugins: [{ name: 'stamp-sw', setup(build) { build.onEnd(() => stampServiceWorker()); } }],
  });
  await ctx.watch();
} else {
  const esbuild = await import('esbuild');
  await esbuild.build(bundleOptions);
  await stampServiceWorker();
}
