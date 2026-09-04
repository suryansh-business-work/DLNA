/**
 * Makes sure packages that ship a downloaded/platform binary actually have it
 * after `npm install`.
 *
 * npm 12 blocks dependency install scripts by default. Both `electron` (which
 * downloads a ~100 MB runtime) and `esbuild` (which unpacks a platform binary)
 * rely on theirs. Without this guard you get "Process failed to launch" from
 * Electron and "you installed esbuild for another platform" from the preload
 * build. Re-installing any package can re-link these and wipe the binary again,
 * so this runs on every install.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/** Resolves a package's directory, or `null` when it is not installed. */
function packageDir(name) {
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

async function ensure({ name, binary, installer }) {
  const dir = packageDir(name);
  if (!dir) return;

  if (existsSync(binary(dir))) return;

  console.log(`[ensure-binaries] ${name}: binary missing, running its installer...`);
  try {
    await import(pathToFileURL(path.join(dir, installer)).href);
    console.log(`[ensure-binaries] ${name}: ready.`);
  } catch (error) {
    console.error(`[ensure-binaries] ${name} failed:`, error?.message ?? error);
    console.error(`[ensure-binaries] Retry by hand: node node_modules/${name}/${installer}`);
    process.exitCode = 1;
  }
}

await ensure({
  name: 'electron',
  installer: 'install.js',
  binary: (dir) =>
    process.platform === 'win32'
      ? path.join(dir, 'dist', 'electron.exe')
      : process.platform === 'darwin'
        ? path.join(dir, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
        : path.join(dir, 'dist', 'electron'),
});

await ensure({
  name: 'esbuild',
  installer: 'install.js',
  binary: (dir) =>
    process.platform === 'win32'
      ? path.join(dir, 'bin', 'esbuild.exe')
      : path.join(dir, 'bin', 'esbuild'),
});
