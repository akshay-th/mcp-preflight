// Just enough TOML to read MCP server tables from Codex's config.toml:
// [tables], [dotted.tables], key = "string" | 'literal' | number | bool | [arrays] | { inline }.
// Multi-line arrays are supported; multi-line strings are skipped.

export function parseToml(text) {
  const root = {};
  let cur = root;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = stripComment(lines[i]).trim();
    if (!line) continue;
    if (/^\[\[.*\]\]$/.test(line)) {
      const path = splitKey(line.slice(2, -2));
      const parent = descend(root, path.slice(0, -1));
      const key = path[path.length - 1];
      if (!Array.isArray(parent[key])) parent[key] = [];
      cur = {};
      parent[key].push(cur);
      continue;
    }
    if (/^\[.*\]$/.test(line)) {
      cur = descend(root, splitKey(line.slice(1, -1)));
      continue;
    }
    const eq = findEq(line);
    if (eq === -1) continue;
    const keyPath = splitKey(line.slice(0, eq));
    let raw = line.slice(eq + 1).trim();
    if (raw.startsWith('"""') || raw.startsWith("'''")) {
      // multi-line string: skip to the closing delimiter
      const delim = raw.slice(0, 3);
      let body = raw.slice(3);
      while (!body.includes(delim) && i + 1 < lines.length) body += `\n${lines[++i]}`;
      assign(cur, keyPath, body.slice(0, body.indexOf(delim)).replace(/^\n/, ''));
      continue;
    }
    while (!balanced(raw) && i + 1 < lines.length) raw += ` ${stripComment(lines[++i]).trim()}`;
    try {
      assign(cur, keyPath, parseValue(raw));
    } catch {
      // ignore values we can't read
    }
  }
  return root;
}

function stripComment(line) {
  let inStr = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === '\\' && inStr === '"') i++;
      else if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'") inStr = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function findEq(line) {
  let inStr = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'") inStr = c;
    else if (c === '=') return i;
  }
  return -1;
}

function splitKey(s) {
  const parts = [];
  let buf = '';
  let inStr = null;
  for (const c of s.trim()) {
    if (inStr) {
      if (c === inStr) inStr = null;
      else buf += c;
    } else if (c === '"' || c === "'") inStr = c;
    else if (c === '.') {
      parts.push(buf.trim());
      buf = '';
    } else buf += c;
  }
  parts.push(buf.trim());
  return parts;
}

function descend(obj, path) {
  let cur = obj;
  for (const p of path) {
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = Array.isArray(cur[p]) ? cur[p][cur[p].length - 1] : cur[p];
  }
  return cur;
}

function assign(obj, path, value) {
  descend(obj, path.slice(0, -1))[path[path.length - 1]] = value;
}

function balanced(raw) {
  let depth = 0;
  let inStr = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (c === '\\' && inStr === '"') i++;
      else if (c === inStr) inStr = null;
    } else if (c === '"' || c === "'") inStr = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0;
}

export function parseValue(raw) {
  const p = { s: raw.trim(), i: 0 };
  const v = value(p);
  return v;
}

function ws(p) {
  while (p.i < p.s.length && /[\s,]/.test(p.s[p.i])) p.i++;
}

function value(p) {
  ws(p);
  const c = p.s[p.i];
  if (c === '"') {
    let out = '';
    p.i++;
    while (p.i < p.s.length && p.s[p.i] !== '"') {
      if (p.s[p.i] === '\\') {
        const n = p.s[++p.i];
        const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' };
        if (n === 'u' || n === 'U') {
          const len = n === 'u' ? 4 : 8;
          out += String.fromCodePoint(parseInt(p.s.slice(p.i + 1, p.i + 1 + len), 16));
          p.i += len;
        } else out += map[n] ?? n;
      } else out += p.s[p.i];
      p.i++;
    }
    p.i++;
    return out;
  }
  if (c === "'") {
    const end = p.s.indexOf("'", p.i + 1);
    const out = p.s.slice(p.i + 1, end);
    p.i = end + 1;
    return out;
  }
  if (c === '[') {
    p.i++;
    const arr = [];
    for (;;) {
      ws(p);
      if (p.s[p.i] === ']' || p.i >= p.s.length) {
        p.i++;
        return arr;
      }
      arr.push(value(p));
    }
  }
  if (c === '{') {
    p.i++;
    const obj = {};
    for (;;) {
      ws(p);
      if (p.s[p.i] === '}' || p.i >= p.s.length) {
        p.i++;
        return obj;
      }
      let key = '';
      ws(p);
      if (p.s[p.i] === '"' || p.s[p.i] === "'") key = value(p);
      else {
        while (p.i < p.s.length && !/[\s=]/.test(p.s[p.i])) key += p.s[p.i++];
      }
      ws(p);
      if (p.s[p.i] === '=') p.i++;
      obj[key] = value(p);
    }
  }
  const m = /^[^,\]}\s]+/.exec(p.s.slice(p.i));
  const tok = m ? m[0] : '';
  p.i += tok.length;
  if (tok === 'true') return true;
  if (tok === 'false') return false;
  const n = Number(tok.replace(/_/g, ''));
  if (!Number.isNaN(n) && tok !== '') return n;
  return tok;
}
