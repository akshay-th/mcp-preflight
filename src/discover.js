import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseConfig } from './jsonc.js';
import { parseToml } from './toml.js';

/**
 * Every MCP config file each client reads, user-level and for the given project.
 * kind: how servers are laid out in the file.
 */
export function configFiles({ home = homedir(), cwd = process.cwd(), platform = process.platform, env = process.env } = {}) {
  const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
  const xdg = env.XDG_CONFIG_HOME || join(home, '.config');
  const appDir = (name) =>
    platform === 'darwin' ? join(home, 'Library', 'Application Support', name) : platform === 'win32' ? join(appData, name) : join(xdg, name);
  const claudeHome = env.CLAUDE_CONFIG_DIR || home;
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  const proj = resolve(cwd);
  return [
    { client: 'Claude Code', scope: 'user', path: join(claudeHome, '.claude.json'), kind: 'claude-code', project: proj },
    { client: 'Claude Code', scope: 'project', path: join(proj, '.mcp.json'), kind: 'mcpServers' },
    { client: 'Claude Desktop', scope: 'user', path: join(appDir('Claude'), 'claude_desktop_config.json'), kind: 'mcpServers', gui: true },
    { client: 'Cursor', scope: 'user', path: join(home, '.cursor', 'mcp.json'), kind: 'mcpServers', gui: true },
    { client: 'Cursor', scope: 'project', path: join(proj, '.cursor', 'mcp.json'), kind: 'mcpServers', gui: true },
    { client: 'VS Code', scope: 'user', path: join(appDir('Code'), 'User', 'mcp.json'), kind: 'vscode', jsonc: true, gui: true },
    { client: 'VS Code', scope: 'project', path: join(proj, '.vscode', 'mcp.json'), kind: 'vscode', jsonc: true, gui: true },
    { client: 'Windsurf', scope: 'user', path: join(home, '.codeium', 'windsurf', 'mcp_config.json'), kind: 'mcpServers', gui: true },
    { client: 'Gemini CLI', scope: 'user', path: join(home, '.gemini', 'settings.json'), kind: 'gemini', jsonc: true },
    { client: 'Gemini CLI', scope: 'project', path: join(proj, '.gemini', 'settings.json'), kind: 'gemini', jsonc: true },
    { client: 'Codex', scope: 'user', path: join(codexHome, 'config.toml'), kind: 'codex' },
    { client: 'Codex', scope: 'project', path: join(proj, '.codex', 'config.toml'), kind: 'codex' },
    { client: 'OpenCode', scope: 'user', path: join(xdg, 'opencode', 'opencode.json'), kind: 'opencode', jsonc: true },
    { client: 'OpenCode', scope: 'user', path: join(xdg, 'opencode', 'opencode.jsonc'), kind: 'opencode', jsonc: true },
    { client: 'OpenCode', scope: 'project', path: join(proj, 'opencode.json'), kind: 'opencode', jsonc: true },
    { client: 'OpenCode', scope: 'project', path: join(proj, 'opencode.jsonc'), kind: 'opencode', jsonc: true },
  ];
}

const str = (v) => (typeof v === 'string' ? v : undefined);
const strArr = (v) => (Array.isArray(v) ? v.map(String) : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** Normalise one server entry to { name, transport, command, args, env, url, headers, cwd, disabled, raw } */
export function normalize(kind, name, s) {
  s = obj(s);
  const base = { name, raw: s, env: obj(s.env), headers: obj(s.headers), cwd: str(s.cwd), disabled: s.disabled === true || s.enabled === false };
  if (kind === 'opencode') {
    const cmd = strArr(s.command);
    return {
      ...base,
      env: obj(s.environment),
      transport: s.type === 'remote' ? 'http' : 'stdio',
      command: cmd[0],
      args: cmd.slice(1),
      url: str(s.url),
    };
  }
  if (kind === 'gemini') {
    const url = str(s.httpUrl) || str(s.url);
    return { ...base, transport: s.httpUrl ? 'http' : s.url ? 'sse' : 'stdio', command: str(s.command), args: strArr(s.args), url: s.command ? undefined : url };
  }
  if (kind === 'codex') {
    return {
      ...base,
      headers: obj(s.http_headers),
      transport: s.url ? 'http' : 'stdio',
      command: str(s.command),
      args: strArr(s.args),
      url: str(s.url),
    };
  }
  // Claude Code, Claude Desktop, Cursor, Windsurf, VS Code
  const type = str(s.type);
  const url = str(s.url) || str(s.serverUrl);
  let transport = 'stdio';
  if (type === 'sse') transport = 'sse';
  else if (type === 'http' || type === 'streamable-http' || type === 'streamableHttp') transport = 'http';
  else if (!s.command && url) transport = 'http';
  return { ...base, transport, command: str(s.command), args: strArr(s.args), url, envFile: str(s.envFile) };
}

export function serversIn(kind, data, project) {
  data = obj(data);
  const list = [];
  const add = (table, scope) => {
    for (const [name, s] of Object.entries(obj(table))) list.push({ ...normalize(kind, name, s), scopeOverride: scope });
  };
  if (kind === 'claude-code') {
    add(data.mcpServers);
    const p = obj(data.projects)[project];
    if (p) add(p.mcpServers, 'local');
  } else if (kind === 'vscode') add(data.servers);
  else if (kind === 'codex') add(data.mcp_servers);
  else if (kind === 'opencode') add(data.mcp);
  else add(data.mcpServers);
  return list;
}

/**
 * Returns { files: [{ client, scope, path, exists, error?, servers: [...] }] }
 */
export function discover(opts = {}) {
  const files = [];
  for (const f of configFiles(opts)) {
    if (!existsSync(f.path)) continue;
    const text = readFileSync(f.path, 'utf8');
    const entry = { client: f.client, scope: f.scope, path: f.path, gui: !!f.gui, servers: [] };
    let data;
    if (f.kind === 'codex') {
      try {
        data = parseToml(text);
      } catch (e) {
        entry.error = { error: e.message };
      }
    } else {
      const r = parseConfig(text, { jsonc: f.jsonc });
      if (r.ok) data = r.data;
      else entry.error = r;
    }
    if (data) {
      entry.servers = serversIn(f.kind, data, f.project).map((s) => ({
        ...s,
        client: f.client,
        scope: s.scopeOverride || f.scope,
        file: f.path,
        gui: !!f.gui,
      }));
      for (const s of entry.servers) delete s.scopeOverride;
    }
    // ~/.claude.json holds lots of unrelated state; only list it when it has servers
    if (f.kind === 'claude-code' && !entry.servers.length && !entry.error) continue;
    files.push(entry);
  }
  return { files };
}
