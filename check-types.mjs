// check-types.mjs — type-check the frontend scripts that opt in with // @ts-check.
//
// Zero dependencies is a harder rule than types are a soft one, so this looks for
// `tsc` on PATH and *skips* when it is not there: a checkout with no TypeScript
// installed still runs `npm run check` and still gets a green result. On a
// machine that has it, the same command type-checks the files below.
//
// A file opts in by starting with `// @ts-check`. That is the whole ratchet:
// nothing is checked until someone annotates a file, and once annotated it stays
// clean or the suite fails. The browser still runs the identical bytes — there is
// no build step here and this file must never become one.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const pub = join(root, 'public');

const optedIn = readdirSync(pub)
  .filter((f) => f.endsWith('.js'))
  .sort()
  .filter((f) => /^\uFEFF?\s*\/\/\s*@ts-check/.test(readFileSync(join(pub, f), 'utf8')));

if (!optedIn.length) {
  console.log('types check: nothing opted in (add // @ts-check to the top of a script to start)');
  process.exit(0);
}

const bin = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
const flags = [
  '--noEmit', '--allowJs', '--checkJs', '--strict',
  '--target', 'es2020', '--lib', 'es2020', '--lib', 'dom', '--module', 'esnext',
];
// Run from public/ with bare filenames: no spaces, so Windows needs no quoting
// layer of its own (a .cmd shim is not an executable, so it needs cmd.exe).
const args = [...flags, ...optedIn];
const run = process.platform === 'win32'
  ? spawnSync('cmd.exe', ['/d', '/c', bin, ...args], { cwd: pub, encoding: 'utf8' })
  : spawnSync(bin, args, { cwd: pub, encoding: 'utf8' });

const out = (run.stdout || '') + (run.stderr || '');

if (run.error || /is not recognized|command not found|No such file/i.test(out)) {
  // ENOENT and friends: no compiler on this machine. Say so out loud rather than
  // passing silently — a skip nobody notices is a check nobody has.
  const why = run.error ? (/** @type {NodeJS.ErrnoException} */ (run.error).code || run.error.message) : 'not on PATH';
  console.log('types check: skipped — no ' + bin + ' (' + why + '); '
    + optedIn.length + ' file(s) would have been checked');
  process.exit(0);
}

const errors = out.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
if (errors.length) {
  console.log(out.trim());
  console.log('types check: ' + errors.length + ' problem(s) in ' + optedIn.join(', '));
  process.exit(1);
}
console.log('types check: ' + optedIn.length + ' file(s) type-check clean (' + optedIn.join(', ') + ')');
process.exit(0);