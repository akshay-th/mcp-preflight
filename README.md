# mcp-preflight

**One command that checks every MCP server config on your machine and tells you why a server won't start, before your agent fails without saying why.**

MCP servers fail in a handful of recurring ways, and each client reports them differently or not at all:

| Symptom | Real cause | What mcp-preflight reports |
|---|---|---|
| *All* servers vanished from Cursor or Claude Desktop | One trailing comma in the config file | `invalid-config` with line and column |
| `spawn npx ENOENT` in Claude Desktop, but it works in your terminal | Node comes from nvm or Homebrew, and GUI apps get `/usr/bin:/bin:/usr/sbin:/sbin` | `gui-path`, with the absolute path to use instead |
| Server "connected" but no tools, or random JSON errors | The server prints logs to **stdout**, the protocol channel | `stdout-pollution` (with `--live`) |
| Server exits immediately | Missing token or bad argument | `live-exit`, plus the last lines of its stderr |
| Works today, breaks after `nvm use 22` | Command points into a version manager directory | `version-manager` |
| `npx` fails on Windows | `npx` is a `.cmd` shim, and spawning without a shell fails | `windows-cmd-shim`, suggesting the `cmd /c` fix |
| Agent feels slow and dumb | One server adds 30k tokens of tool definitions to every request | `context-heavy`, from a token estimate per server |
| Token committed to git | API key pasted into `env` | `plaintext-secret` (masked), and `readable-secrets` if the file mode is 644 |

Some tools check one client's schema in a browser, and some do live checks for a few clients. `mcp-preflight` covers **all eight major clients, including Codex's TOML and Gemini CLI**. It runs locally with zero dependencies and gives a CI-friendly exit code.

## Usage

```bash
npx -y github:akshay-th/mcp-preflight            # static checks, all clients
npx -y github:akshay-th/mcp-preflight --live     # also start each server and run initialize + tools/list
npx -y github:akshay-th/mcp-preflight --live --simulate-gui   # start servers with the GUI-app PATH
```

```
Claude Desktop ~/Library/Application Support/Claude/claude_desktop_config.json (user)
  ! github npx -y @modelcontextprotocol/server-github
      ! "npx" is only on your shell PATH (/Users/me/.nvm/versions/node/v22.11.0/bin/npx). Claude Desktop started
        from the Dock/launcher may only get /usr/bin:/bin:/usr/sbin:/sbin and fail with "spawn npx ENOENT" [gui-path]
        fix: use the absolute path: "command": "/Users/me/.nvm/versions/node/v22.11.0/bin/npx"
      i "npx" comes from nvm; switching or uninstalling that version breaks this server [version-manager]
      ! secret stored in plain text: env.GITHUB_PERSONAL_ACCESS_TOKEN=ghp_…Xk [plaintext-secret]
        fix: reference an environment variable instead, and keep the file out of git

Cursor ~/.cursor/mcp.json (user)
  ✗ cannot parse config at line 9, column 5: Expected double-quoted property name in JSON at position 212.
    The client will load none of the servers in this file [invalid-config]

Claude Code ~/work/app/.mcp.json (project)
  ✓ playwright npx @playwright/mcp@latest
      ✓ Playwright 0.0.41 answered in 1840ms: 21 tool(s), ~6,912 tokens of tool definitions
  ✗ db node ./scripts/db-mcp.js
      ✗ wrote 1 non-JSON line(s) to stdout (e.g. "Connected to postgres"). stdout is the protocol channel;
        logs must go to stderr [stdout-pollution]

Drift same server name, different definitions
  i github: 2 variants across Claude Desktop (user), Claude Code (project)

5 server(s) in 3 file(s): 2 error(s), 2 warning(s)
```

## What it reads

| Client | Files |
|---|---|
| Claude Code | `~/.claude.json` (user, plus local servers for this project), `.mcp.json` |
| Claude Desktop | `claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json`, `.cursor/mcp.json` |
| VS Code | user `mcp.json`, `.vscode/mcp.json` (JSONC) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Gemini CLI | `~/.gemini/settings.json`, `.gemini/settings.json` |
| Codex | `~/.codex/config.toml` (`$CODEX_HOME`), `.codex/config.toml` |
| OpenCode | `~/.config/opencode/opencode.json(c)`, `opencode.json(c)` |

`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME` and `APPDATA` are respected.

## Options

| Flag | |
|---|---|
| `-l, --live` | Start stdio servers and call HTTP servers, then run the MCP handshake. **This runs the commands in your configs**, so it is opt-in. HTTP 401/403 is reported as "needs auth", not as a failure. |
| `--simulate-gui` | With `--live`, use the PATH a Dock-launched app gets. |
| `-c, --client <name>` | Filter by client, for example `cursor` or `codex`. |
| `-s, --server <name>` | Filter by server name. |
| `-p, --project-only` | Only check project files (`.mcp.json`, `.cursor/mcp.json`, …). |
| `--cwd <dir>` | Project to check (default `.`). |
| `--strict` | Exit 1 on warnings, not just errors. |
| `--json` | Machine-readable output. |
| `-q, --quiet` | Only show problems. |

## In CI

Use it to keep a repo's shared MCP config healthy:

```yaml
- run: npx -y github:akshay-th/mcp-preflight --project-only --live --strict
```

## Checks

`invalid-config` · `no-command` · `command-and-url` · `command-not-found` · `cwd-missing` · `gui-path` · `version-manager` · `windows-cmd-shim` · `undefined-env` (per client syntax: `${VAR}`, `${env:VAR}`, `{env:VAR}`) · `plaintext-secret` · `readable-secrets` · `no-url` / `bad-url` / `insecure-url` · `sse-deprecated` · `disabled` · and with `--live`: `live-ok` · `live-exit` · `live-timeout` · `live-spawn` · `live-rpc` · `needs-auth` · `stdout-pollution` · `slow-start` · `context-heavy` · `many-tools` · plus cross-client **drift**.

Token counts are estimates (about 4 characters per token of tool JSON). They are good for comparing servers, not for billing.

## License

MIT
