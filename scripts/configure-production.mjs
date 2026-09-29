// Switch the local bot to production persistence; preserve provider credentials.
import { readFile, writeFile } from 'node:fs/promises';
const api = process.argv[2];
const pages = process.argv[3];
for (const value of [api, pages]) {
  if (!value || new URL(value).protocol !== 'https:') throw new Error('Usage: node scripts/configure-production.mjs <https-worker-url> <https-pages-url>');
}
const path = new URL('../bot/.env', import.meta.url);
let contents = await readFile(path, 'utf8');
function set(name, value) {
  const pattern = new RegExp('^' + name + '=.*$', 'm');
  contents = pattern.test(contents) ? contents.replace(pattern, () => name + '=' + value) : contents.trimEnd() + '\n' + name + '=' + value + '\n';
}
set('CALLS_API_BASE_URL', new URL(api).origin);
set('ALLOWED_ORIGINS', 'http://127.0.0.1:5173,http://localhost:5173,' + new URL(pages).origin);
set('STUN_SERVER_URL', 'stun:stun.cloudflare.com:3478');
await writeFile(path, contents);
console.log('Bot production URL, allowed frontend origin, and STUN configured. Restart the bot after checking for unfinished saves. Provider credentials unchanged.');
