// JSON with comments and trailing commas (VS Code, OpenCode and Zed accept these),
// plus error positions as line:column for humans.

export function stripJsonc(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i++;
      } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i++;
      }
      out += '\n';
    } else if (c === '/' && n === '*') {
      out += '  ';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i++;
    } else out += c;
  }
  // trailing commas before } or ]
  return out.replace(/,(\s*[}\]])/g, ' $1');
}

export function lineCol(text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const col = index - before.lastIndexOf('\n');
  return { line, col };
}

/**
 * Parse strict JSON first; fall back to JSONC when allowed.
 * Returns { ok: true, data } or { ok: false, error: "msg", line, col }.
 */
export function parseConfig(text, { jsonc = false } = {}) {
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (strictErr) {
    if (jsonc) {
      try {
        return { ok: true, data: JSON.parse(stripJsonc(text)) };
      } catch {
        // report the strict error below; it points at the real problem
      }
    }
    const err = { ok: false, error: strictErr.message.replace(/^JSON\.parse: /, '') };
    const pos = /position (\d+)/.exec(strictErr.message);
    const lc = /line (\d+) column (\d+)/.exec(strictErr.message);
    if (lc) Object.assign(err, { line: Number(lc[1]), col: Number(lc[2]) });
    else if (pos) Object.assign(err, lineCol(text, Number(pos[1])));
    return err;
  }
}
