#!/usr/bin/env node
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkFile, checkServer, findDrift } from '../src/checks.js';
import { discover } from '../src/discover.js';
import { liveFindings, probeHttp, probeStdio } from '../src/live.js';
import { guiPath } from '../src/which.js';

const HELP = `mcp-preflight — check every MCP server config on this machine before your agent trips over it

Usage
  mcp-preflight [options]

Reads the MCP configs of Claude Code, Claude Desktop, Cursor, VS Code, Windsurf,
Gemini CLI, Codex and OpenCode (user-level, plus the project in --cwd).

Options
  -l, --live            start every stdio server / call every HTTP server and run the
                        MCP handshake (initialize + tools/list). Off by default because
                        it executes the configured commands.
      --simulate-gui    with --live: start stdio servers with the PATH GUI apps get
                        (reproduces "spawn npx ENOENT" from Claude Desktop & co.)
  -c, --client <name>   only this client (e.g. cursor, "claude code", codex)
  -s, --server <name>   only servers with this name
  -p, --project-only    only project-level config files (good for CI)
      --cwd <dir>       project directory (default: current directory)
      --timeout <ms>    live handshake timeout per server (default 20000)
      --strict          exit 1 on warnings too
      --json            machine-readable output
  -q, --quiet           hide info-level findings and passing servers
  -h, --help
`;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c) => (s) => (color ? `\x1b[${c}m${s}\x1b[0m` : String(s));
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const cyan = paint(36);
const dim = paint(2);
const bold = paint(1);

const ICON = { error: red('✗'), warn: yellow('!'), info: cyan('i'), ok: green('✓') };
const RANK = { ok: 0, info: 1, warn: 2, error: 3 };
const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  });
  await Promise.all(workers);
  return out;
}

function describe(s) {
  if (s.transport === 'stdio') return [s.command, ...(s.args || [])].join(' ');
  return `${s.transport} ${s.url}`;
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      live: { type: 'boolean', short: 'l' },
      'simulate-gui': { type: 'boolean' },
      client: { type: 'string', short: 'c' },
      server: { type: 'string', short: 's' },
      'project-only': { type: 'boolean', short: 'p' },
      cwd: { type: 'string' },
      timeout: { type: 'string' },
      strict: { type: 'boolean' },
      json: { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const cwd = resolve(values.cwd || process.cwd());
  const timeoutMs = Number(values.timeout || 20000);
  let { files } = discover({ cwd });
  if (values['project-only']) files = files.filter((f) => f.scope === 'project');
  if (values.client) files = files.filter((f) => f.client.toLowerCase().includes(values.client.toLowerCase()));
  for (const f of files) {
    if (values.server) f.servers = f.servers.filter((s) => s.name === values.server);
  }

  const allServers = files.flatMap((f) => f.servers);
  for (const f of files) {
    f.findings = checkFile(f, f.servers);
    for (const s of f.servers) s.findings = checkServer(s);
  }

  if (values.live) {
    const gp = values['simulate-gui'] ? guiPath() : null;
    await pool(allServers.filter((s) => !s.disabled && !s.findings.some((x) => x.level === 'error' && x.code !== 'gui-path')), 4, async (s) => {
      let r;
      if (s.transport === 'stdio') r = await probeStdio(s, { timeoutMs, pathOverride: gp || undefined });
      else if (s.transport === 'http') r = await probeHttp(s, { timeoutMs });
      else {
        s.findings.push({ level: 'info', code: 'live-skipped', message: 'live check not implemented for the legacy SSE transport' });
        return;
      }
      s.live = { ok: r.ok, ms: r.ms, tools: r.tools?.map((t) => t.name), serverInfo: r.serverInfo, error: r.error };
      s.findings.push(...liveFindings(s, r));
    });
  }

  const drift = findDrift(allServers);
  const counts = { error: 0, warn: 0, info: 0 };
  for (const x of [...files.flatMap((f) => f.findings), ...allServers.flatMap((s) => s.findings)]) {
    if (x.level in counts) counts[x.level]++;
  }

  if (values.json) {
    const clean = (s) => {
      const { raw, gui, ...rest } = s;
      return rest;
    };
    console.log(JSON.stringify({ cwd, files: files.map((f) => ({ ...f, servers: f.servers.map(clean) })), drift, counts }, null, 2));
  } else {
    print(files, drift, counts, values);
  }
  if (counts.error) return 1;
  if (values.strict && counts.warn) return 1;
  return 0;
}

function print(files, drift, counts, values) {
  if (!files.length) {
    console.log('No MCP config files found.');
    return;
  }
  const hide = (x) => values.quiet && (x.level === 'info' || x.level === 'ok');
  for (const f of files) {
    console.log(`\n${bold(f.client)} ${dim(`${tilde(f.path)} (${f.scope})`)}`);
    for (const x of f.findings) printFinding(x, '  ');
    if (!f.servers.length && !f.error) console.log(dim('  (no servers)'));
    for (const s of f.servers) {
      const worst = s.findings.reduce((m, x) => Math.max(m, RANK[x.level] ?? 0), 0);
      const shown = s.findings.filter((x) => !hide(x));
      if (values.quiet && worst < RANK.warn) continue;
      const icon = worst >= RANK.error ? ICON.error : worst >= RANK.warn ? ICON.warn : s.disabled ? dim('-') : ICON.ok;
      const cmd = describe(s);
      console.log(`  ${icon} ${bold(s.name)} ${dim(cmd.length > 90 ? `${cmd.slice(0, 87)}...` : cmd)}${s.scope === 'local' ? dim(' [local]') : ''}`);
      for (const x of shown) printFinding(x, '      ');
    }
  }
  if (drift.length) {
    console.log(`\n${bold('Drift')} ${dim('same server name, different definitions')}`);
    for (const d of drift) console.log(`  ${ICON.info} ${bold(d.name)}: ${d.variants} variants across ${d.where.join(', ')}`);
  }
  const total = files.reduce((n, f) => n + f.servers.length, 0);
  console.log(
    `\n${total} server(s) in ${files.length} file(s): ${counts.error ? red(`${counts.error} error(s)`) : green('0 errors')}, ${counts.warn ? yellow(`${counts.warn} warning(s)`) : '0 warnings'}${values.live ? '' : dim('  (add --live to start servers and run the MCP handshake)')}`,
  );
}

function printFinding(x, indent) {
  const [first, ...rest] = x.message.split('\n');
  console.log(`${indent}${ICON[x.level] || ' '} ${x.level === 'ok' ? first : `${first} ${dim(`[${x.code}]`)}`}`);
  for (const l of rest) console.log(dim(`${indent}${l}`));
  if (x.fix) console.log(`${indent}  ${dim('fix:')} ${x.fix}`);
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (e) => {
    console.error(`mcp-preflight: ${e.message}`);
    process.exitCode = 2;
  },
);
