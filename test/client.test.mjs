import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FreedcampClient, FreedcampApiError } from '../lib/client.mjs';
import { loadConfig, loadDotenvInto, ConfigError } from '../lib/config.mjs';

let calls;
const realFetch = globalThis.fetch;
function respond(envelope, status = 200) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return new Response(JSON.stringify(envelope), { status, headers: { 'Content-Type': 'application/json' } });
  };
}
beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; });

const config = { apiKey: 'key123', apiSecret: 'secret456', baseUrl: 'https://freedcamp.com/api/v1', projectId: '42', listId: null };

test('secured keys sign GET requests with HMAC-SHA1(api_key + timestamp, secret)', async () => {
  respond({ http_code: 200, data: { projects: [] } });
  await new FreedcampClient(config).listProjects();
  const u = calls[0].url;
  const ts = u.searchParams.get('timestamp');
  assert.match(ts, /^\d+$/);
  assert.equal(u.searchParams.get('hash'), createHmac('sha1', 'secret456').update('key123' + ts).digest('hex'));
  assert.equal(calls[0].init.headers['X-API-KEY'], 'key123');
});

test('API errors in the envelope become FreedcampApiError', async () => {
  respond({ http_code: 404, msg: 'Not found', data: {} }, 404);
  await assert.rejects(new FreedcampClient(config).listProjects(), FreedcampApiError);
});

test('config requires an API key and treats an empty secret as unsecured', () => {
  assert.throws(() => loadConfig({}), ConfigError);
  const c = loadConfig({ FREEDCAMP_API_KEY: ' k ', FREEDCAMP_API_SECRET: '', FREEDCAMP_BASE_URL: 'https://x/api/v1/' });
  assert.equal(c.apiKey, 'k');
  assert.equal(c.apiSecret, null);
  assert.equal(c.baseUrl, 'https://x/api/v1');
});

test('dotenv loader never overrides real environment values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-'));
  const file = join(dir, '.env.freedcamp');
  writeFileSync(file, '# comment\nFREEDCAMP_API_KEY="from-file"\nFREEDCAMP_PROJECT_ID=7\n');
  const env = { FREEDCAMP_API_KEY: 'from-env' };
  assert.equal(loadDotenvInto(file, env), true);
  assert.equal(env.FREEDCAMP_API_KEY, 'from-env');
  assert.equal(env.FREEDCAMP_PROJECT_ID, '7');
  assert.equal(loadDotenvInto(join(dir, 'missing'), env), false);
});
