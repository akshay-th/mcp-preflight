import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expand, liveFindings, probeHttp, probeStdio } from '../src/live.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/stdio-server.js', import.meta.url));
const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const stdio = (mode, extra = {}) => ({ name: mode, client: 'Claude Code', transport: 'stdio', command: process.execPath, args: [FIXTURE, mode], env: {}, ...extra });

test('expand substitutes the reference styles clients use', () => {
  const env = { A: '1', B: '2' };
  assert.equal(expand('${A}-${env:B}-{env:A}-${C:-dflt}-${D}', env), '1-2-1-dflt-');
});

test('probeStdio: healthy server', async () => {
  const r = await probeStdio(stdio('ok', { env: { FIXTURE_TOKEN: '${PREFLIGHT_T}' } }), { env: { ...process.env, PREFLIGHT_T: 'x' } });
  assert.equal(r.ok, true);
  assert.equal(r.serverInfo.name, 'fixture');
  assert.deepEqual(r.tools.map((t) => t.name), ['echo', 'env']);
  assert.match(r.tools[1].description, /token set: true/);
  const f = liveFindings({}, r);
  assert.equal(f[0].code, 'live-ok');
  assert.match(f[0].message, /fixture 1\.2\.3 answered in \d+ms: 2 tool\(s\)/);
});

test('probeStdio: stdout pollution is an error even when the handshake works', async () => {
  const r = await probeStdio(stdio('noise'));
  assert.equal(r.ok, true);
  const f = liveFindings({}, r);
  assert.deepEqual(f.map((x) => x.code), ['live-ok', 'stdout-pollution']);
  assert.match(f[1].message, /Server listening on stdio/);
});

test('probeStdio: crash shows the tail of stderr', async () => {
  const r = await probeStdio(stdio('crash'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'exit');
  const f = liveFindings({}, r);
  assert.match(f[0].message, /exit code 1/);
  assert.match(f[0].message, /GITHUB_TOKEN is required/);
});

test('probeStdio: hanging server times out', async () => {
  const r = await probeStdio(stdio('hang'), { timeoutMs: 400 });
  assert.equal(r.code, 'timeout');
});

test('probeStdio: missing binary', async () => {
  const r = await probeStdio({ ...stdio('ok'), command: 'no-such-binary-for-preflight' });
  assert.equal(r.ok, false);
  assert.match(r.error, /ENOENT/);
});

function httpServer(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function readBody(req) {
  let b = '';
  for await (const c of req) b += c;
  return JSON.parse(b);
}

test('probeHttp: JSON and SSE responses, session header, auth', async () => {
  const seen = [];
  const srv = await httpServer(async (req, res) => {
    if (req.url === '/auth') {
      res.writeHead(401, { 'www-authenticate': 'Bearer resource_metadata="x"' }).end();
      return;
    }
    const msg = await readBody(req);
    seen.push({ method: msg.method, session: req.headers['mcp-session-id'] });
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'abc' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'remote' } } }));
    } else if (msg.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'a', inputSchema: { type: 'object' } }] } })}\n\n`);
    } else {
      res.writeHead(202).end();
    }
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const ok = await probeHttp({ url: `${base}/mcp`, headers: {} });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.tools.map((t) => t.name), ['a']);
    assert.deepEqual(seen.map((s) => `${s.method}:${s.session || ''}`), ['initialize:', 'notifications/initialized:abc', 'tools/list:abc']);
    const auth = await probeHttp({ url: `${base}/auth`, headers: {} });
    assert.equal(auth.auth, true);
    assert.equal(liveFindings({}, auth)[0].code, 'needs-auth');
  } finally {
    srv.close();
  }
  const down = await probeHttp({ url: 'http://127.0.0.1:1/mcp', headers: {} }, { timeoutMs: 2000 });
  assert.equal(down.ok, false);
});

test('cli end-to-end with a fake HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'preflight-cli-'));
  const proj = join(home, 'proj');
  mkdirSync(proj);
  writeFileSync(
    join(proj, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        good: { command: process.execPath, args: [FIXTURE, 'ok'] },
        noisy: { command: process.execPath, args: [FIXTURE, 'noise'] },
        missing: { command: 'nope-not-installed-anywhere' },
      },
    }),
  );
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), NO_COLOR: '1' };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  delete env.APPDATA;

  const r = spawnSync(process.execPath, [CLI, '--cwd', proj, '--live', '--json'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  const servers = Object.fromEntries(out.files[0].servers.map((s) => [s.name, s.findings.map((x) => x.code)]));
  assert.deepEqual(servers.good, ['live-ok']);
  assert.deepEqual(servers.noisy, ['live-ok', 'stdout-pollution']);
  assert.deepEqual(servers.missing, ['command-not-found']);

  const text = spawnSync(process.execPath, [CLI, '--cwd', proj, '--project-only', '--server', 'good'], { env, encoding: 'utf8' });
  assert.equal(text.status, 0, text.stdout);
  assert.match(text.stdout, /✓ good/);
  assert.match(text.stdout, /0 errors/);
});
