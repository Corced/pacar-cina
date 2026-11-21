// fetch-repos.mjs — one-time research helper.
// Downloads the three reference repositories the person pointed at
// (as zip archives from github.com/codeload) into app/.repos/ so the
// analysis tools can inventory them. This is NOT part of the built site:
// build.mjs only copies public/ into dist/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOS = [
  ['pingmike2-zai2api', 'pingmike2/zai2api'],
  ['d3vin-glm-zai-2api', 'D3-vin/GLM-ZAI-2API'],
  ['chaoticmindv-zai2api', 'chaoticmindv/zai2api'],
];

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '.repos');
mkdirSync(outDir, { recursive: true });

let failures = 0;
for (const [name, slug] of REPOS) {
  const dest = join(outDir, name + '.zip');
  let ok = false;
  for (const branch of ['main', 'master']) {
    const url = `https://codeload.github.com/${slug}/zip/refs/heads/${branch}`;
    const res = await fetch(url);
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(dest, buf);
      console.log(`${slug} (branch ${branch}) -> .repos/${name}.zip (${buf.length} bytes)`);
      ok = true;
      break;
    }
    console.log(`${slug} branch ${branch}: HTTP ${res.status}`);
  }
  if (!ok) { console.error(`${slug}: could not download`); failures++; }
}
process.exit(failures ? 1 : 0);
