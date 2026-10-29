import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, stripJsonc } from '../src/jsonc.js';
import { discover, normalize } from '../src/discover.js';
import { checkFile, checkServer, findDrift } from '../src/checks.js';
import { versionManagerOf, which } from '../src/which.js';

const unix = process.platform !== 'win32';
const codes = (f) => f.map((x) => x.code);

test('jsonc: comments and trailing commas', () => {
  const t = '{\n  // servers\n  "servers": { "a": { "command": "x", /* inline */ "args": ["//not a comment"], }, },\n}';
  assert.deepEqual(JSON.parse(stripJsonc(t)), { servers: { a: { command: 'x', args: ['//not a comment'] } } });
  assert.equal(parseConfig(t).ok, false);
  assert.equal(parseConfig(t, { jsonc: true }).ok, true);
});

test('parseConfig reports line and column', () => {
  const r = parseConfig('{\n  "mcpServers": {\n    "a": { "command": "x", }\n  }\n}');
  assert.equal(r.ok, false);
  assert.equal(r.line, 3);
  assert.ok(r.col > 1);
});

test('normalize handles each client shape', () => {
  assert.deepEqual(
    (({ transport, command, args, url }) => ({ transport, command, args, url }))(normalize('opencode', 'a', { type: 'local', command: ['npx', '-y', 'pkg'], environment: { A: '1' } })),
    { transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], url: undefined },
  );
  assert.equal(normalize('opencode', 'a', { type: 'remote', url: 'https://x' }).transport, 'http');
  assert.equal(normalize('gemini', 'g', { httpUrl: 'https://x/mcp' }).transport, 'http');
  assert.equal(normalize('gemini', 'g', { url: 'https://x/sse' }).transport, 'sse');
  assert.equal(normalize('mcpServers', 'c', { type: 'http', url: 'https://x' }).transport, 'http');
  assert.equal(normalize('mcpServers', 'c', { url: 'https://x' }).transport, 'http');
  assert.equal(normalize('mcpServers', 'c', { type: 'sse', url: 'https://x' }).transport, 'sse');
  assert.equal(normalize('codex', 'x', { command: 'uvx', args: ['a'], enabled: false }).disabled, true);
});

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'preflight-home-'));
  const proj = join(home, 'proj');
  mkdirSync(proj);
  const w = (rel, text) => {
    const p = join(home, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, text);
    return p;
  };
  return { home, proj, w };
}

test('discover finds every client, user and project scope', () => {
  const { home, proj, w } = fakeHome();
  w('.claude.json', JSON.stringify({ numStartups: 3, mcpServers: { u: { command: 'node', args: ['u.js'] } }, projects: { [proj]: { mcpServers: { l: { command: 'node' } } } } }));
  w('proj/.mcp.json', JSON.stringify({ mcpServers: { p: { type: 'http', url: 'https://example.com/mcp' } } }));
  w('.cursor/mcp.json', '{ "mcpServers": { "c": { "command": "npx", } } }'); // invalid: trailing comma
  w('proj/.vscode/mcp.json', '{ // comment\n "servers": { "v": { "type": "stdio", "command": "node" } } }');
  w('.gemini/settings.json', JSON.stringify({ mcpServers: { g: { httpUrl: 'https://g.example.com/mcp' } } }));
  w('.codex/config.toml', '[mcp_servers.x]\ncommand = "uvx"\nargs = ["mcp-x"]\n');
  w('.config/opencode/opencode.json', JSON.stringify({ mcp: { o: { type: 'local', command: ['bun', 'o.ts'] } } }));
  const { files } = discover({ home, cwd: proj, platform: 'linux', env: {} });
  const summary = files.map((f) => `${f.client}/${f.scope}:${f.error ? 'ERR' : f.servers.map((s) => `${s.name}@${s.scope}`).join(',')}`);
  assert.deepEqual(summary, [
    'Claude Code/user:u@user,l@local',
    'Claude Code/project:p@project',
    'Cursor/user:ERR',
    'VS Code/project:v@project',
    'Gemini CLI/user:g@user',
    'Codex/user:x@user',
    'OpenCode/user:o@user',
  ]);
});

test('~/.claude.json without servers is not listed', () => {
  const { home, proj, w } = fakeHome();
  w('.claude.json', JSON.stringify({ numStartups: 3 }));
  assert.equal(discover({ home, cwd: proj, platform: 'linux', env: {} }).files.length, 0);
});

const S = (over) => ({ name: 's', client: 'Claude Code', scope: 'user', transport: 'stdio', args: [], env: {}, headers: {}, ...over });

test('missing command and bad cwd are errors', () => {
  assert.deepEqual(codes(checkServer(S({ command: 'definitely-not-a-real-binary-xyz' }), { path: '/nope' })), ['command-not-found']);
  assert.ok(codes(checkServer(S({ command: process.execPath, cwd: '/no/such/dir' }))).includes('cwd-missing'));
  const urlNoType = checkServer(S({ command: undefined, url: 'https://x/mcp' }));
  assert.equal(urlNoType[0].code, 'no-command');
  assert.match(urlNoType[0].fix, /"type": "http"/);
});

test('gui-path: command only reachable through the shell PATH', { skip: !unix }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-bin-'));
  const bin = join(dir, 'my-mcp-launcher');
  writeFileSync(bin, '#!/bin/sh\n');
  chmodSync(bin, 0o755);
  const gui = checkServer(S({ client: 'Claude Desktop', gui: true, command: 'my-mcp-launcher' }), { path: dir, platform: process.platform });
  assert.equal(gui[0].code, 'gui-path');
  assert.equal(gui[0].level, 'warn');
  assert.match(gui[0].fix, new RegExp(bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const cli = checkServer(S({ command: 'my-mcp-launcher' }), { path: dir, platform: process.platform });
  assert.equal(cli[0].level, 'info');
  // absolute paths are fine
  assert.deepEqual(checkServer(S({ client: 'Claude Desktop', gui: true, command: bin }), { path: dir }), []);
});

test('which honours PATH and executability', { skip: !unix }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-which-'));
  writeFileSync(join(dir, 'noexec'), 'x');
  assert.equal(which('noexec', { path: dir }), null);
  assert.equal(which('sh', { path: '/bin:/usr/bin' }) !== null, true);
});

test('version manager paths are recognised', () => {
  assert.equal(versionManagerOf('/Users/me/.nvm/versions/node/v22.1.0/bin/npx'), 'nvm');
  assert.equal(versionManagerOf('/Users/me/.asdf/shims/node'), 'asdf');
  assert.equal(versionManagerOf('/Users/me/.volta/bin/npx'), 'volta');
  assert.equal(versionManagerOf('/opt/homebrew/bin/npx'), null);
});

test('undefined env references, per client syntax', () => {
  const env = { PATH: process.env.PATH, HAVE: '1' };
  const f = checkServer(S({ command: process.execPath, env: { A: '${HAVE}', B: '${MISSING_ONE}', C: '${WITH_DEFAULT:-x}' } }), { env });
  const u = f.find((x) => x.code === 'undefined-env');
  assert.match(u.message, /MISSING_ONE/);
  assert.match(u.message, /WITH_DEFAULT/);
  assert.doesNotMatch(u.message, /HAVE/);
  const cursor = checkServer(S({ client: 'Cursor', command: process.execPath, env: { A: '${env:NOPE_X}' } }), { env });
  assert.match(cursor.find((x) => x.code === 'undefined-env').message, /NOPE_X/);
});

test('plaintext secrets are flagged and masked, references are not', () => {
  const f = checkServer(
    S({
      command: process.execPath,
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_' + 'a'.repeat(36), OTHER_TOKEN: '${OTHER_TOKEN}', DEBUG: 'true' },
      args: ['--api-key', 'sk-ant-' + 'b'.repeat(30)],
    }),
  );
  const s = f.find((x) => x.code === 'plaintext-secret');
  assert.match(s.message, /env\.GITHUB_PERSONAL_ACCESS_TOKEN=ghp_…aa/);
  assert.match(s.message, /args\[1\]/);
  assert.doesNotMatch(s.message, /OTHER_TOKEN|DEBUG/);
  assert.doesNotMatch(s.message, /a{10}/);
});

test('remote server checks', () => {
  assert.ok(codes(checkServer(S({ transport: 'http', url: 'http://mcp.example.com/mcp' }))).includes('insecure-url'));
  assert.deepEqual(codes(checkServer(S({ transport: 'http', url: 'http://localhost:3000/mcp' }))), []);
  assert.ok(codes(checkServer(S({ transport: 'http', url: 'not a url' }))).includes('bad-url'));
  assert.ok(codes(checkServer(S({ transport: 'sse', url: 'https://x/sse' }))).includes('sse-deprecated'));
  assert.ok(codes(checkServer(S({ transport: 'http', url: 'https://x/mcp?api_key=abcdefghijkl' }))).includes('plaintext-secret'));
});

test('disabled servers are only reported as info', () => {
  assert.deepEqual(codes(checkServer(S({ command: 'nope-nope', disabled: true }))), ['disabled']);
});

test('file checks: parse errors and readable secrets', { skip: !unix }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-file-'));
  const p = join(dir, 'mcp.json');
  writeFileSync(p, '{}');
  chmodSync(p, 0o644);
  const servers = [S({ env: { API_KEY: 'abcdefghijklmnop' } })];
  assert.deepEqual(codes(checkFile({ path: p }, servers)), ['readable-secrets']);
  assert.equal(checkFile({ path: p }, servers, { home: dir })[0].fix, 'chmod 600 "$HOME/mcp.json"');
  assert.equal(checkFile({ path: p }, servers, { home: '/elsewhere' })[0].fix, `chmod 600 "${p}"`);
  chmodSync(p, 0o600);
  assert.deepEqual(codes(checkFile({ path: p }, servers)), []);
  assert.match(checkFile({ path: p, error: { error: 'Unexpected token }', line: 3, col: 9 } }, [])[0].message, /line 3, column 9/);
});

test('drift between clients', () => {
  const d = findDrift([
    S({ name: 'github', client: 'Cursor', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }),
    S({ name: 'github', client: 'Claude Code', command: 'docker', args: ['run', 'ghcr.io/github/github-mcp-server'] }),
    S({ name: 'same', client: 'Cursor', command: 'x' }),
    S({ name: 'same', client: 'Codex', command: 'x' }),
  ]);
  assert.equal(d.length, 1);
  assert.equal(d[0].name, 'github');
});
