import { existsSync, statSync } from 'node:fs';
import { guiPath, versionManagerOf, which } from './which.js';

// Variable reference syntaxes clients expand, per client.
const REF_SYNTAX = {
  'Claude Code': [/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g],
  Cursor: [/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g],
  'VS Code': [/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g],
  'Gemini CLI': [/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, /\$([A-Za-z_][A-Za-z0-9_]*)/g],
  OpenCode: [/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g],
};

const ANY_REF = /\$\{[^}]+\}|\{env:[^}]+\}|\{file:[^}]+\}|^\$[A-Za-z_]/;

const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)/i;
const SECRET_VALUE = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(sk|rk)_live_[A-Za-z0-9]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /Bearer\s+[A-Za-z0-9._~+/-]{20,}/,
];

export const mask = (v) => (v.length <= 8 ? '****' : `${v.slice(0, 4)}…${v.slice(-2)}`);

function refsIn(client, value) {
  const out = [];
  for (const re of REF_SYNTAX[client] || []) {
    for (const m of value.matchAll(re)) out.push(m[1]);
  }
  return out;
}

function looksLikeSecret(key, value) {
  if (typeof value !== 'string' || !value) return false;
  if (ANY_REF.test(value)) return false;
  if (SECRET_VALUE.some((re) => re.test(value))) return true;
  if (key && SECRET_KEY.test(key) && value.length >= 12 && !/\s/.test(value) && !/^(true|false|\d+)$/i.test(value)) return true;
  return false;
}

const isLocalHost = (h) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i.test(h);

/**
 * Static checks for one normalised server. Returns findings:
 *   { level: 'error' | 'warn' | 'info', code, message, fix? }
 */
export function checkServer(server, { env = process.env, platform = process.platform, path = env.PATH || '' } = {}) {
  const f = [];
  const push = (level, code, message, fix) => f.push(fix ? { level, code, message, fix } : { level, code, message });

  if (server.disabled) {
    push('info', 'disabled', 'server is disabled in this config');
    return f;
  }

  if (server.transport === 'stdio') {
    if (!server.command) {
      push('error', 'no-command', server.url ? 'has a url but the client will treat it as stdio' : 'neither "command" nor "url" is set',
        server.url && server.client === 'Claude Code' ? 'add "type": "http" (or "sse") next to "url"' : undefined);
      return f;
    }
    if (server.url) push('warn', 'command-and-url', 'both "command" and "url" are set; the client will ignore one of them');

    if (server.cwd && !existsSync(server.cwd)) push('error', 'cwd-missing', `cwd does not exist: ${server.cwd}`);

    const cmdHasRef = ANY_REF.test(server.command);
    const resolved = cmdHasRef ? null : which(server.command, { path, platform, cwd: server.cwd });
    if (!resolved && !cmdHasRef) {
      push('error', 'command-not-found', `"${server.command}" was not found on PATH`,
        /^(npx|npm|node)$/.test(server.command) ? 'install Node.js, or use the absolute path to npx'
          : /^(uv|uvx)$/.test(server.command) ? 'install uv (https://docs.astral.sh/uv/), or use the absolute path to uvx'
            : undefined);
    } else if (resolved) {
      const gp = guiPath(platform);
      const isBare = !/[\\/]/.test(server.command);
      if (gp && isBare && !which(server.command, { path: gp, platform, cwd: server.cwd })) {
        const level = server.gui ? 'warn' : 'info';
        push(level, 'gui-path',
          server.gui
            ? `"${server.command}" is only on your shell PATH (${resolved}). ${server.client} started from the Dock/launcher may only get ${gp} and fail with "spawn ${server.command} ENOENT"`
            : `"${server.command}" resolves via your shell PATH (${resolved}); background or scheduled sessions started without your shell profile may not find it`,
          `use the absolute path: "command": "${resolved}"`);
      }
      const vm = versionManagerOf(resolved);
      if (vm && (!/[\\/]/.test(server.command) || versionManagerOf(server.command))) {
        push('info', 'version-manager', `"${server.command}" comes from ${vm}; switching or uninstalling that version breaks this server`);
      }
      if (platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
        push('warn', 'windows-cmd-shim', `"${server.command}" is a .cmd shim; clients that spawn without a shell fail with ENOENT on Windows`,
          `use "command": "cmd", "args": ["/c", "${server.command}", ...]`);
      }
    }
  } else {
    if (!server.url) push('error', 'no-url', `${server.transport} server has no url`);
    else {
      let u;
      try {
        u = new URL(server.url.replace(/\$\{[^}]+\}/g, 'x'));
      } catch {
        push('error', 'bad-url', `url is not valid: ${server.url}`);
      }
      if (u && u.protocol === 'http:' && !isLocalHost(u.hostname)) push('warn', 'insecure-url', `plain http to ${u.hostname}; tokens are sent unencrypted`);
      if (u && !/^https?:$/.test(u.protocol)) push('error', 'bad-url', `unsupported url scheme ${u.protocol}`);
    }
    if (server.transport === 'sse') push('info', 'sse-deprecated', 'the HTTP+SSE transport is deprecated since MCP 2025-03-26; use streamable HTTP if the server supports it');
  }

  // Undefined variable references
  const values = [server.command, ...(server.args || []), ...Object.values(server.env || {}), ...Object.values(server.headers || {}), server.url].filter((v) => typeof v === 'string');
  const missing = new Set();
  for (const v of values) for (const name of refsIn(server.client, v)) if (env[name] === undefined) missing.add(name);
  if (missing.size) {
    push('warn', 'undefined-env', `references unset environment variable(s): ${[...missing].join(', ')}`,
      server.gui ? 'GUI apps do not see variables exported in your shell profile; set them in the config or via launchctl setenv' : undefined);
  }

  // Plaintext secrets
  const leaks = [];
  for (const [k, v] of Object.entries(server.env || {})) if (looksLikeSecret(k, v)) leaks.push(`env.${k}=${mask(String(v))}`);
  for (const [k, v] of Object.entries(server.headers || {})) if (looksLikeSecret(k, v)) leaks.push(`headers.${k}=${mask(String(v))}`);
  (server.args || []).forEach((a, i) => {
    if (SECRET_VALUE.some((re) => re.test(a))) leaks.push(`args[${i}]=${mask(a)}`);
  });
  if (server.url && /[?&](api[_-]?key|token|key|access_token)=[^&]{8,}/i.test(server.url)) leaks.push('url query string');
  if (leaks.length) {
    push('warn', 'plaintext-secret', `secret stored in plain text: ${leaks.join(', ')}`, 'reference an environment variable instead, and keep the file out of git');
  }
  return f;
}

/** File-level findings: parse errors, permissions on files that hold secrets. */
export function checkFile(file, servers, { platform = process.platform } = {}) {
  const f = [];
  if (file.error) {
    const at = file.error.line ? ` at line ${file.error.line}, column ${file.error.col}` : '';
    f.push({ level: 'error', code: 'invalid-config', message: `cannot parse config${at}: ${file.error.error}. The client will load none of the servers in this file` });
  }
  if (platform !== 'win32' && servers.some((s) => checkServerHasSecret(s))) {
    try {
      const mode = statSync(file.path).mode & 0o777;
      if (mode & 0o044) {
        f.push({ level: 'warn', code: 'readable-secrets', message: `file holds secrets but is readable by other users (mode ${mode.toString(8)})`, fix: `chmod 600 "${file.path}"` });
      }
    } catch {}
  }
  return f;
}

function checkServerHasSecret(s) {
  return Object.entries(s.env || {}).some(([k, v]) => looksLikeSecret(k, v)) || Object.entries(s.headers || {}).some(([k, v]) => looksLikeSecret(k, v));
}

/** Same server name defined differently in several places. */
export function findDrift(servers) {
  const by = new Map();
  for (const s of servers) {
    if (!by.has(s.name)) by.set(s.name, []);
    by.get(s.name).push(s);
  }
  const out = [];
  for (const [name, list] of by) {
    if (list.length < 2) continue;
    const sig = (s) => JSON.stringify([s.transport, s.command, s.args, s.url]);
    const distinct = new Set(list.map(sig));
    if (distinct.size > 1) {
      out.push({ name, where: list.map((s) => `${s.client} (${s.scope})`), variants: distinct.size });
    }
  }
  return out;
}
