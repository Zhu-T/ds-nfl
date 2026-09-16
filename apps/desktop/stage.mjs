/**
 * Build the web app and stage it for packaging.
 *
 * Next's `output: 'standalone'` emits a server plus only the node_modules it
 * actually traced, but it deliberately leaves out two things that have to be
 * copied alongside it: the static chunk output and anything in public/.
 * Forgetting them produces an app that boots and then renders unstyled.
 */

import { execSync } from 'node:child_process';
import { cpSync, existsSync, rmSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const webDir = join(repoRoot, 'apps', 'web');
const nextDir = join(webDir, '.next');
const standalone = join(nextDir, 'standalone');
const target = join(here, 'resources', 'server');

function sizeOf(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    total += entry.isDirectory() ? sizeOf(p) : statSync(p).size;
  }
  return total;
}

console.log('Building the web app...');
execSync('npm run build --workspace=@ds-nfl/web', { cwd: repoRoot, stdio: 'inherit' });

if (!existsSync(standalone)) {
  throw new Error(
    `No standalone output at ${standalone}. Check that next.config.mjs sets output: 'standalone'.`,
  );
}

console.log('Staging...');
try {
  // Windows refuses to remove a directory that any process has open — including
  // a shell whose working directory is inside it, and a previously launched app
  // still holding the server. Retry briefly, then say which it is.
  rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
} catch (err) {
  if (err?.code === 'EPERM' || err?.code === 'EBUSY') {
    throw new Error(
      `Cannot clear ${target}: it is in use.\n` +
        'Close any running ds-nfl window, and make sure no terminal is cd\'d inside that folder.',
    );
  }
  throw err;
}
mkdirSync(target, { recursive: true });

// The whole tree, so server.js can resolve node_modules from the workspace root —
// minus `.next/cache`, which is webpack's incremental build cache. It is useless
// at runtime and was 82 MB of the first build I measured, more than half the app.
cpSync(standalone, target, {
  recursive: true,
  filter: (src) =>
    // webpack's incremental build cache: useless at runtime, 82 MB when measured.
    !src.includes(`${sep}.next${sep}cache`) &&
    // Guard against staging this directory into itself. next.config excludes it
    // from tracing too, but a recursive copy is bad enough to block twice.
    !src.includes(`${sep}apps${sep}desktop`),
});

// Static assets are not part of the traced output.
const staticSrc = join(nextDir, 'static');
if (existsSync(staticSrc)) {
  cpSync(staticSrc, join(target, 'apps', 'web', '.next', 'static'), { recursive: true });
}

const publicSrc = join(webDir, 'public');
if (existsSync(publicSrc)) {
  cpSync(publicSrc, join(target, 'apps', 'web', 'public'), { recursive: true });
}

const entry = join(target, 'apps', 'web', 'server.js');
if (!existsSync(entry)) {
  throw new Error(`Staged tree is missing its entry point at ${entry}.`);
}

console.log(`Staged ${(sizeOf(target) / 1024 / 1024).toFixed(0)} MB to resources/server`);
