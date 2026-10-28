import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

// PATH that GUI apps get when launched from the Dock / a desktop launcher, and
// what launchd/systemd hand to background jobs. Your shell rc files never run.
export function guiPath(platform = process.platform) {
  if (platform === 'darwin') return '/usr/bin:/bin:/usr/sbin:/sbin';
  if (platform === 'linux') return '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  return null;
}

function isExecutable(p, platform) {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    if (platform === 'win32') return true;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a command like a shell would. Returns the absolute path or null. */
export function which(command, { path = process.env.PATH || '', cwd = process.cwd(), platform = process.platform, pathext = process.env.PATHEXT } = {}) {
  if (!command) return null;
  const exts = platform === 'win32' ? ['', ...(pathext || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())] : [''];
  const sep = platform === 'win32' ? ';' : ':';
  const hasSlash = /[\\/]/.test(command);
  if (hasSlash || isAbsolute(command)) {
    const full = isAbsolute(command) ? command : resolve(cwd, command);
    for (const e of exts) if (isExecutable(full + e, platform)) return full + e;
    return null;
  }
  for (const dir of path.split(sep)) {
    if (!dir) continue;
    for (const e of exts) {
      const full = join(dir, command + e);
      if (isExecutable(full, platform)) return full;
    }
  }
  return null;
}

// Version-manager shims and per-version install dirs: they move or vanish when
// you switch versions, and some only work after shell init.
const SHIMS = [
  [/[\\/]\.nvm[\\/]versions[\\/]/, 'nvm'],
  [/[\\/]\.asdf[\\/](shims|installs)[\\/]/, 'asdf'],
  [/[\\/]\.volta[\\/]/, 'volta'],
  [/[\\/](fnm_multishells|\.fnm|fnm[\\/]node-versions)[\\/]/, 'fnm'],
  [/[\\/]mise[\\/](shims|installs)[\\/]/, 'mise'],
  [/[\\/]\.pyenv[\\/](shims|versions)[\\/]/, 'pyenv'],
  [/[\\/]\.rbenv[\\/]/, 'rbenv'],
  [/[\\/]\.nodenv[\\/]/, 'nodenv'],
];

export function versionManagerOf(path) {
  for (const [re, name] of SHIMS) if (re.test(path)) return name;
  return null;
}
