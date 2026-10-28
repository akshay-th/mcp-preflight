import { spawn } from 'node:child_process';
import { needsShell, onLines, tryParse } from './lines.js';
import { which } from './which.js';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'mcp-preflight', version: '0.1.0' };

// Substitute ${VAR} / ${env:VAR} / {env:VAR} the way clients do, from our env.
export function expand(value, env) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => env[n] ?? '')
    .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => env[n] ?? '')
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, n, d) => env[n] ?? d ?? '');
}

export function estimateTokens(tools) {
  // ~4 characters per token for JSON; good enough to compare servers.
  return Math.round(JSON.stringify(tools).length / 4);
}

/**
 * Start a stdio server and run initialize + tools/list.
 * Resolves { ok, ms, serverInfo, protocolVersion, tools, noise, stderr, error? }
 */
export function probeStdio(server, { timeoutMs = 20000, env = process.env, pathOverride } = {}) {
  return new Promise((resolve) => {
    const childEnv = { ...env };
    for (const [k, v] of Object.entries(server.env || {})) childEnv[k] = expand(String(v), env);
    if (pathOverride) childEnv.PATH = pathOverride;
    const command = expand(server.command, env);
    const args = (server.args || []).map((a) => expand(a, env));
    const started = Date.now();
    let child;
    const noise = [];
    let stderr = '';
    let done = false;
    const pending = new Map();
    let nextId = 1;
    const out = { ok: false, noise };

    const finish = (extra) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
        child.kill();
      } catch {}
      resolve({ ...out, ...extra, stderr: stderr.trim().slice(-2000) });
    };
    const timer = setTimeout(() => finish({ error: `no response within ${timeoutMs}ms`, code: 'timeout' }), timeoutMs);

    // Through a shell (Windows .cmd shims) a missing binary is just "exit code 1"; say ENOENT like everywhere else.
    if (needsShell(command) && !which(command, { path: childEnv.PATH || childEnv.Path || '', cwd: server.cwd })) {
      finish({ error: `spawn ${command} ENOENT`, code: 'spawn' });
      return;
    }
    try {
      child = spawn(command, args, { env: childEnv, cwd: server.cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: needsShell(command), windowsHide: true });
    } catch (e) {
      finish({ error: e.message, code: 'spawn' });
      return;
    }
    child.on('error', (e) => finish({ error: e.code === 'ENOENT' ? `spawn ${command} ENOENT` : e.message, code: 'spawn' }));
    child.on('exit', (code, signal) => finish({ error: `server exited before answering (${signal || `exit code ${code}`})`, code: 'exit' }));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-8000)));
    child.stdin.on('error', () => {});

    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const request = (method, params) =>
      new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, { res, rej });
        send({ jsonrpc: '2.0', id, method, params });
      });

    onLines(child.stdout, (line) => {
      const msg = tryParse(line);
      if (!msg || typeof msg !== 'object') {
        noise.push(line.slice(0, 200));
        return;
      }
      if (msg.id != null && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(Object.assign(new Error(msg.error.message || 'error'), { rpc: msg.error }));
        else p.res(msg.result);
      } else if (msg.method && msg.id != null) {
        send({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'roots/list' ? { roots: [] } : {} });
      }
    });

    (async () => {
      const init = await request('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: { roots: {} }, clientInfo: CLIENT_INFO });
      out.ms = Date.now() - started;
      out.serverInfo = init?.serverInfo;
      out.protocolVersion = init?.protocolVersion;
      out.capabilities = init?.capabilities || {};
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const tools = [];
      if (out.capabilities.tools) {
        let cursor;
        for (let i = 0; i < 50; i++) {
          const r = await request('tools/list', cursor ? { cursor } : {});
          tools.push(...(r?.tools || []));
          cursor = r?.nextCursor;
          if (!cursor) break;
        }
      }
      out.tools = tools;
      finish({ ok: true });
    })().catch((e) => finish({ error: e.message, code: 'rpc' }));
  });
}

async function readRpc(res, id) {
  const type = res.headers.get('content-type') || '';
  const text = await res.text();
  if (type.includes('text/event-stream')) {
    for (const block of text.split(/\n\n/)) {
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      const msg = tryParse(data);
      if (msg && msg.id === id) return msg;
    }
    return undefined;
  }
  return tryParse(text);
}

/** Streamable HTTP handshake. 401/403 is reported as "needs auth", not as broken. */
export async function probeHttp(server, { timeoutMs = 20000, env = process.env } = {}) {
  const url = expand(server.url, env);
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  for (const [k, v] of Object.entries(server.headers || {})) headers[k] = expand(String(v), env);
  const started = Date.now();
  const ctl = AbortSignal.timeout(timeoutMs);
  const post = (body, extra = {}) => fetch(url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body), signal: ctl });
  try {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } });
    const ms = Date.now() - started;
    if (res.status === 401 || res.status === 403) {
      return { ok: true, ms, auth: true, status: res.status, wwwAuthenticate: res.headers.get('www-authenticate') || undefined };
    }
    if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status} ${res.statusText}`, code: 'http' };
    const init = await readRpc(res, 1);
    if (!init || init.error) return { ok: false, ms, error: init?.error?.message || 'response was not a JSON-RPC initialize result', code: 'rpc' };
    const session = res.headers.get('mcp-session-id');
    const extra = { 'mcp-protocol-version': init.result?.protocolVersion || PROTOCOL_VERSION, ...(session ? { 'mcp-session-id': session } : {}) };
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, extra).then((r) => r.text()).catch(() => {});
    let tools = [];
    if (init.result?.capabilities?.tools) {
      const lr = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, extra);
      const list = lr.ok ? await readRpc(lr, 2) : undefined;
      tools = list?.result?.tools || [];
    }
    return { ok: true, ms, serverInfo: init.result?.serverInfo, protocolVersion: init.result?.protocolVersion, tools };
  } catch (e) {
    const msg = e.name === 'TimeoutError' ? `no response within ${timeoutMs}ms` : e.cause?.code || e.message;
    return { ok: false, ms: Date.now() - started, error: msg, code: 'network' };
  }
}

/** Turn a probe result into findings. */
export function liveFindings(server, r) {
  const f = [];
  if (!r.ok) {
    let message = `failed to start: ${r.error}`;
    if (r.stderr) message += `\n${r.stderr.split('\n').slice(-6).map((l) => `      │ ${l}`).join('\n')}`;
    f.push({ level: 'error', code: `live-${r.code}`, message });
  } else if (r.auth) {
    f.push({ level: 'info', code: 'needs-auth', message: `reachable; requires authentication (HTTP ${r.status}${r.wwwAuthenticate ? `, ${r.wwwAuthenticate.split(' ')[0]}` : ''}). Sign in from the client` });
  } else {
    const n = r.tools?.length ?? 0;
    const tokens = estimateTokens(r.tools || []);
    const who = r.serverInfo ? `${r.serverInfo.name}${r.serverInfo.version ? ` ${r.serverInfo.version}` : ''}` : 'server';
    f.push({ level: 'ok', code: 'live-ok', message: `${who} answered in ${r.ms}ms: ${n} tool(s), ~${tokens.toLocaleString('en-US')} tokens of tool definitions` });
    if (r.ms > 10000) f.push({ level: 'warn', code: 'slow-start', message: `took ${(r.ms / 1000).toFixed(1)}s to initialize; some clients time out at 10s` });
    if (tokens > 15000) f.push({ level: 'warn', code: 'context-heavy', message: `tool definitions use ~${tokens.toLocaleString('en-US')} tokens of context in every request` });
    if (n > 100) f.push({ level: 'warn', code: 'many-tools', message: `${n} tools; OpenAI-based clients cap requests at 128 tools in total` });
  }
  if (r.noise && r.noise.length) {
    f.push({
      level: 'error',
      code: 'stdout-pollution',
      message: `wrote ${r.noise.length} non-JSON line(s) to stdout (e.g. "${r.noise[0].slice(0, 80)}"). stdout is the protocol channel; logs must go to stderr`,
    });
  }
  return f;
}
