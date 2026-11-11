const { isUtf8 } = require('node:buffer');

type Assignment = { path: string[]; value: unknown; start: number; end: number; valueStart: number; valueEnd: number };
type Projection = { bytes: Buffer; skipped: boolean };

// Recognize ordinary TOML tables, dotted keys, strings, scalars and arrays without
// reserializing the document. Unsupported forms (including inline/array tables)
// retain the entire source. This is deliberately not a general TOML parser.
const assignments = (source: string): Assignment[] => {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\r(?!\n)/u.test(source)) throw new Error('Unsupported TOML controls');
  let offset = 0;
  let table: string[] = [];
  const result: Assignment[] = [];
  const values = new Set<string>();
  const tables = new Map<string, 'implicit' | 'explicit' | 'dotted'>();
  const invalid = (): never => { throw new Error('Unsupported Codex configuration'); };
  const horizontal = (): void => { while (/[ \t]/u.test(source[offset] ?? 'x')) offset += 1; };
  const whitespace = (): void => {
    while (offset < source.length) {
      if (source[offset] === '#') {
        while (offset < source.length && source[offset] !== '\n') offset += 1;
      } else if (/[ \t\r\n]/u.test(source[offset])) offset += 1;
      else break;
    }
  };
  const string = (key = false): string => {
    const quote = source[offset];
    const multiline = source.startsWith(quote.repeat(3), offset);
    if (key && multiline) invalid();
    offset += multiline ? 3 : 1;
    let value = '';
    if (multiline && source[offset] === '\r' && source[offset + 1] === '\n') offset += 2;
    else if (multiline && source[offset] === '\n') offset += 1;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === quote) {
        if (!multiline) return value;
        let count = 1;
        while (source[offset] === quote) { count += 1; offset += 1; }
        if (count > 5) invalid();
        if (count >= 3) return value + quote.repeat(count - 3);
        value += quote.repeat(count);
      } else if (char === '\\' && quote === '"') {
        const continuation = multiline ? /^[ \t]*\r?\n[ \t\r\n]*/u.exec(source.slice(offset)) : null;
        if (continuation) { offset += continuation[0].length; continue; }
        const escaped = source[offset++];
        const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
        if (Object.hasOwn(simple, escaped)) value += simple[escaped];
        else if (escaped === 'u' || escaped === 'U') {
          const digits = escaped === 'u' ? 4 : 8;
          const hex = source.slice(offset, offset + digits);
          if (hex.length !== digits || !/^[\da-f]+$/iu.test(hex)) invalid();
          const codepoint = Number.parseInt(hex, 16);
          if (codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) invalid();
          value += String.fromCodePoint(codepoint);
          offset += digits;
        } else invalid();
      } else if (char === '\n' || char === '\r') {
        if (!multiline) invalid();
        if (char === '\r') offset += 1; // CRLF was checked before parsing.
        value += '\n';
      } else {
        value += char;
      }
    }
    return invalid();
  };
  const keyPath = (): string[] => {
    const keys: string[] = [];
    do {
      horizontal();
      if (source[offset] === '"' || source[offset] === "'") keys.push(string(true));
      else {
        const bare = /^[A-Za-z0-9_-]+/u.exec(source.slice(offset));
        if (!bare) invalid();
        keys.push(bare![0]); offset += bare![0].length;
      }
      horizontal();
      if (source[offset] !== '.') return keys;
      offset += 1;
    } while (keys.length < 64);
    return invalid();
  };
  const value = (depth = 0): unknown => {
    if (depth > 64) invalid();
    horizontal();
    if (source[offset] === '"' || source[offset] === "'") return string();
    if (source[offset] === '[') {
      offset += 1;
      const array: unknown[] = [];
      whitespace();
      while (source[offset] !== ']') {
        array.push(value(depth + 1)); whitespace();
        if (source[offset] !== ',') break;
        offset += 1; whitespace();
      }
      if (source[offset++] !== ']') invalid();
      return array;
    }
    const scalar = /^[^\s\]#,}]+/u.exec(source.slice(offset))?.[0];
    if (!scalar) return invalid();
    const decimal = '(?:0|[1-9](?:_?\\d)*)';
    if (!new RegExp(`^(?:true|false|[+-]?(?:inf|nan|${decimal}(?:\\.\\d(?:_?\\d)*)?(?:[eE][+-]?\\d(?:_?\\d)*)?)|0x[\\da-fA-F](?:_?[\\da-fA-F])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*)$`, 'u').test(scalar)) invalid();
    offset += scalar.length;
    return null; // Only string values and empty argument arrays identify this runtime.
  };
  const parents = (keys: string[], kind: 'implicit' | 'dotted', first = 1): void => {
    for (let length = first; length < keys.length; length += 1) {
      const id = JSON.stringify(keys.slice(0, length));
      if (values.has(id)) invalid();
      if (!tables.has(id) || (kind === 'dotted' && tables.get(id) === 'implicit')) tables.set(id, kind);
    }
  };
  while (offset < source.length) {
    whitespace();
    if (offset === source.length) break;
    if (result.length >= 8192) invalid();
    if (source[offset] === '[') {
      offset += 1;
      const keys = keyPath();
      if (source[offset++] !== ']') invalid();
      parents(keys, 'implicit');
      const id = JSON.stringify(keys);
      if (values.has(id) || (tables.has(id) && tables.get(id) !== 'implicit')) invalid();
      tables.set(id, 'explicit'); table = keys;
    } else {
      const start = offset;
      const keys = [...table, ...keyPath()];
      if (source[offset++] !== '=') invalid();
      horizontal();
      const valueStart = offset;
      const parsed = value();
      const valueEnd = offset;
      parents(keys, 'dotted', table.length + 1);
      const id = JSON.stringify(keys);
      if (values.has(id) || tables.has(id)) invalid();
      values.add(id);
      result.push({ path: keys, value: parsed, start, end: offset, valueStart, valueEnd });
    }
    horizontal();
    if (source[offset] === '#') while (offset < source.length && source[offset] !== '\n') offset += 1;
    if (source[offset] === '\r') offset += 1;
    if (offset < source.length && source[offset++] !== '\n') invalid();
  }
  return result;
};

// A service map is a JSON string-to-string object. Refuse duplicate (including
// escaped) keys and unfamiliar value shapes rather than normalize them away.
const serviceMap = (source: string): Map<string, string> => {
  JSON.parse(source); // Validate JSON whitespace and syntax before inspecting duplicate keys.
  const token = '"(?:[^"\\\\\\u0000-\\u001f]|\\\\(?:["\\\\/bfnrt]|u[\\da-fA-F]{4}))*"';
  const pair = new RegExp(`\\s*(${token})\\s*:\\s*(${token})\\s*`, 'uy');
  const map = new Map<string, string>();
  let offset = source.search(/\S/u);
  if (source[offset++] !== '{') throw new Error('Unsupported service map');
  while (source.slice(offset).trim() !== '}') {
    pair.lastIndex = offset;
    const match = pair.exec(source);
    if (!match) throw new Error('Unsupported service map');
    const key = JSON.parse(match[1]) as string;
    if (map.has(key)) throw new Error('Ambiguous service map');
    map.set(key, JSON.parse(match[2]) as string);
    offset = pair.lastIndex;
    if (source[offset] !== ',') break;
    offset += 1;
  }
  return map;
};

const projectCodexConfig = (bytes: Buffer): Projection => {
  if (!bytes.includes('BROWSER_USE_CODEX_APP_VERSION') || !bytes.includes('NODE_REPL_TRUSTED_SERVICES')) return { bytes, skipped: false };
  try {
    if (!isUtf8(bytes)) throw new Error('Unsupported encoding');
    const source = bytes.toString('utf8');
    const entries = assignments(source);
    const get = (...keys: string[]): Assignment | undefined => entries.find((entry) => JSON.stringify(entry.path) === JSON.stringify(keys));
    const server = ['mcp_servers', 'node_repl'];
    const env = [...server, 'env'];
    const command = get(...server, 'command')?.value;
    const args = get(...server, 'args')?.value;
    const home = get(...env, 'CODEX_HOME')?.value;
    const version = get(...env, 'BROWSER_USE_CODEX_APP_VERSION');
    const services = get(...env, 'NODE_REPL_TRUSTED_SERVICES');
    const appVersion = /^\d+(?:\.\d+){2,}$/u;
    if (typeof command !== 'string' || !/^\/(?:[^/]+\/)*(?:ChatGPT|Codex)\.app\/Contents\/Resources\/cua_node\/bin\/node_repl$/u.test(command)
      || !Array.isArray(args) || args.length !== 0 || get(...env, 'BROWSER_USE_CODEX_APP_BUILD_FLAVOR')?.value !== 'prod'
      || typeof home !== 'string' || !home.startsWith('/') || home.endsWith('/') || home.split('/').some((part) => part === '.' || part === '..')
      || typeof version?.value !== 'string' || !appVersion.test(version.value) || typeof services?.value !== 'string') return { bytes, skipped: false };
    const map = serviceMap(services.value);
    const browser = map.get('browser');
    const prefix = `${home}/plugins/cache/openai-bundled/browser/`;
    const suffix = '/scripts/browser-service.mjs';
    if (typeof browser !== 'string' || !browser.startsWith(prefix) || !browser.endsWith(suffix)
      || !appVersion.test(browser.slice(prefix.length, -suffix.length))) return { bytes, skipped: false };
    map.delete('browser');
    // JSON permits a raw DEL character; TOML strings do not. Keep it escaped
    // inside the service JSON before wrapping it in either TOML string form.
    const json = JSON.stringify(Object.fromEntries(map)).replaceAll('\u007f', '\\u007f');
    const replacement = source[services.valueStart] === "'" && !json.includes("'") ? `'${json}'` : JSON.stringify(json);
    // Keep comments and all non-target bytes. Remove an otherwise empty version
    // line, but retain a trailing comment as its own comment line.
    const lineStart = source.lastIndexOf('\n', version.start - 1) + 1;
    const newline = source.indexOf('\n', version.end);
    const lineEnd = newline < 0 ? source.length : newline + 1;
    const removeLine = /^[ \t]*$/u.test(source.slice(lineStart, version.start)) && /^[ \t\r\n]*$/u.test(source.slice(version.end, lineEnd));
    const edits = [
      { start: removeLine ? lineStart : version.start, end: removeLine ? lineEnd : version.end, text: '' },
      { start: services.valueStart, end: services.valueEnd, text: replacement },
    ].sort((left, right) => right.start - left.start);
    let projected = source;
    for (const edit of edits) projected = projected.slice(0, edit.start) + edit.text + projected.slice(edit.end);
    return { bytes: Buffer.from(projected), skipped: false };
  } catch {
    return { bytes, skipped: true };
  }
};

module.exports = { projectCodexConfig };
export type { Projection };
