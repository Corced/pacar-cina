// check-docs.mjs — keep the hand-off note and README honest about the code.
//
// A hand-off note goes stale the moment someone renames a setting or deletes a
// file, and a stale note is worse than none: it sends the next person looking
// for something that isn't there. So this reads the docs the way a reader would
// and checks every concrete claim against the tree:
//
//   - every SETTING the note names must appear in server/hub.mjs
//   - every file path the note points at must exist
//   - claims that were true once and are not any more must stay gone
//   - the "not done" list must not silently shrink (a fixed gap should be
//     removed on purpose, not lost by accident)
//
// Read-only; nothing is written.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(ok, what, detail) {
  if (ok) console.log('ok   ' + what);
  else { failures++; console.log('FAIL ' + what + (detail ? '  — ' + detail : '')); }
}

const note = readFileSync(join(root, 'HANDOFF.md'), 'utf8');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const hub = readFileSync(join(root, 'server', 'hub.mjs'), 'utf8');

/* ── it is a hand-off note, not a stub ── */
check(note.length > 4000, 'the hand-off note is substantial', note.length + ' bytes');
for (const heading of ['What this is', 'What actually works', 'What is not done yet',
  'Before you change anything', 'Verifying', 'Where to look']) {
  check(note.includes('## ' + heading) || note.includes(heading),
    'the note covers "' + heading + '"');
}

/* ── every setting it names must exist in the hub ── */
// SETTINGS are the upper-case names the note talks about as knobs. A name in
// the note that the hub has never heard of would send a reader nowhere.
const named = [...note.matchAll(/\b((?:GLM|SESSION|TOKEN|FE|PORT)_[A-Z0-9_]+|PORT|FE_VERSION)\b/g)]
  .map((m) => m[1]);
const settings = [...new Set(named)].sort();
check(settings.length >= 5, 'the note names the settings it relies on',
  settings.length + ' named');
const unknown = settings.filter((s) => !hub.includes(s));
check(unknown.length === 0, 'every setting the note names exists in the hub',
  unknown.length ? 'unknown: ' + unknown.join(', ') : settings.length + ' settings verified');

/* ── every path it points at must exist ── */
// Paths appear both in prose (`public/minter.js`) and in the plain listing at
// the end, so both forms are collected. Only names with an extension count, so
// prose like "public/" or "server/" is not mistaken for a file.
const paths = [...new Set([...note.matchAll(/\b((?:public|server)\/[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)\b/g)]
  .map((m) => m[1]))].sort();
check(paths.length >= 8, 'the note points at real files', paths.length + ' paths');
const missing = paths.filter((p) => !existsSync(join(root, p)));
check(missing.length === 0, 'every file the note points at exists',
  missing.length ? 'missing: ' + missing.join(', ') : paths.length + ' paths verified');

/* ── claims that are no longer true must stay gone ── *
 * Each of these was true at some point and would mislead a reader now. */
const stale = [
  ['the minter is public and needs no login', /no login needed/i],
  ['every page is one gate with no per-page roles', /no per-page roles/i],
  ['the front door is the minter page', /`\/` serves the minter/i],
];
for (const [what, re] of stale) {
  check(!re.test(note), 'the note does not repeat the stale claim that ' + what);
}

/* ── the gap list must not shrink by accident ──
 * 9 gaps originally; the chat-forwarding and pool-consumer work closed two,
 * then runtime revocation closed one more. A fixed gap is removed on purpose —
 * this number is the tripwire, so lower it deliberately and say why. */
const numbered = (note.match(/^### \d+\. /gm) || []).length;
check(numbered >= 7, 'the note lists the open gaps', numbered + ' numbered gaps');

/* ── README and the note must agree that roles are separated ── */
check(readme.includes('Roles do not share pages'),
  'the README records the per-role navigation');
check(note.toLowerCase().includes('hiding a link is not access control'),
  'the note warns that the bar is not a lock');

/* ── the note must name what would finish each gap, not just complain ── */
const closers = (note.match(/Close (?:it|them) by:/g) || []).length;
check(closers >= 6, 'most gaps name what would close them',
  closers + ' closing hints for ' + numbered + ' gaps');

console.log(failures === 0
  ? 'docs check: the hand-off note matches the code'
  : 'docs check: ' + failures + ' failure(s)');
process.exit(failures === 0 ? 0 : 1);
