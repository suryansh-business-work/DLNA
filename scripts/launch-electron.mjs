/**
 * Launches Electron with a clean environment.
 *
 * VS Code's extension host exports `ELECTRON_RUN_AS_NODE=1`, and every terminal
 * it spawns inherits it. With that variable set, `electron.exe` boots as a plain
 * Node process: `require('electron')` returns the path string instead of the
 * API, and the app dies with `Cannot read properties of undefined (reading
 * 'isPackaged')`. Stripping it here means `npm start` and `npm run dev` behave
 * the same inside and outside an editor terminal.
 *
 * Any arguments are forwarded to Electron.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, '..');

let electronBinary;
try {
  // The `electron` package's main export is the path to the binary.
  electronBinary = require('electron');
} catch {
  console.error('[launch-electron] electron is not installed. Run: npm install');
  process.exit(1);
}

if (typeof electronBinary !== 'string') {
  console.error('[launch-electron] Unexpected electron export; run: npm install');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// These leak from a VS Code terminal too and confuse Electron's own bootstrap.
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const child = spawn(electronBinary, [projectRoot, ...process.argv.slice(2)], {
  cwd: projectRoot,
  env,
  stdio: 'inherit',
});

child.on('close', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});

child.on('error', (error) => {
  console.error('[launch-electron] Failed to start Electron:', error.message);
  process.exit(1);
});
