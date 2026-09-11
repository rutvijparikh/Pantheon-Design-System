/**
 * Build the loadable extension into `dist/`.
 *
 * `dist/` is the folder you point Chrome at with "Load unpacked" — it holds the
 * manifest, the bundled scripts, the static assets and a copy of the Pantheon
 * tokens. Nothing outside `dist/` is read at runtime.
 */
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

/**
 * The design system's tokens live at the repo root and the extension ships a
 * copy, so there is exactly one source of truth. `PANTHEON_TOKENS` overrides it
 * for building against a different token file.
 */
const TOKENS = process.env.PANTHEON_TOKENS
  ? path.resolve(process.env.PANTHEON_TOKENS)
  : path.join(root, '..', 'sample-tokens.json');

/** Content scripts run in the page and cannot be ES modules, so they build as IIFEs. */
const bundles = [
  { in: 'src/background/service-worker.js', out: 'service-worker.js', format: 'esm' },
  { in: 'src/sidepanel/sidepanel.js', out: 'sidepanel.js', format: 'esm' },
  { in: 'src/options/options.js', out: 'options.js', format: 'esm' },
  { in: 'src/content/inspector.js', out: 'inspector.js', format: 'iife' },
];

const staticFiles = [
  'manifest.json',
  'src/sidepanel/sidepanel.html',
  'src/sidepanel/sidepanel.css',
  'src/options/options.html',
  'src/options/options.css',
  'src/content/inspector.css',
];

async function copyStatic() {
  for (const file of staticFiles) {
    await cp(path.join(root, file), path.join(dist, path.basename(file)));
  }
  await cp(path.join(root, 'icons'), path.join(dist, 'icons'), { recursive: true });

  if (!existsSync(TOKENS)) {
    throw new Error(
      `No token file at ${TOKENS}. Build from inside the repository, or set PANTHEON_TOKENS to a token file.`,
    );
  }
  const tokens = JSON.parse(await readFile(TOKENS, 'utf8'));
  await mkdir(path.join(dist, 'tokens'), { recursive: true });
  await writeFile(
    path.join(dist, 'tokens', 'pantheon.tokens.json'),
    JSON.stringify(tokens, null, 2),
  );
  return path.relative(root, TOKENS);
}

async function build() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  const contexts = await Promise.all(
    bundles.map((bundle) =>
      esbuild.context({
        entryPoints: [path.join(root, bundle.in)],
        outfile: path.join(dist, bundle.out),
        bundle: true,
        format: bundle.format,
        target: 'chrome116',
        platform: 'browser',
        minify: !watch,
        sourcemap: watch ? 'inline' : false,
        logLevel: 'warning',
      }),
    ),
  );

  if (watch) {
    await Promise.all(contexts.map((context) => context.watch()));
    const tokenSource = await copyStatic();
    console.log(`watching… (tokens from ${tokenSource})`);
    return;
  }

  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
  const tokenSource = await copyStatic();
  console.log(`Built extension/dist (tokens from ${tokenSource}). Load that folder in chrome://extensions.`);
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
