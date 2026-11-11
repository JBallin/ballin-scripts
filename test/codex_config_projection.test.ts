const { projectCodexConfig } = require('../commands/codex_config_projection.ts');
const { codexRuntimeConfig } = require('./helpers/codex_config.ts');
import type { Projection } from '../commands/codex_config_projection.ts';

const project = (source: string | Buffer): Projection => projectCodexConfig(Buffer.isBuffer(source) ? source : Buffer.from(source));
const output = (source: string): string => project(source).bytes.toString('utf8');
const config = codexRuntimeConfig() as string;

describe('Codex configuration runtime metadata projection', () => {
  it('removes only the generated version and bundled browser service, retaining unrelated bytes', () => {
    const result = project(config);
    assert.isFalse(result.skipped);
    assert.equal(result.bytes.toString(), config
      .replace('BROWSER_USE_CODEX_APP_VERSION = "26.100.123"\n', '')
      .replace('"browser":"/synthetic/codex/plugins/cache/openai-bundled/browser/26.100.123/scripts/browser-service.mjs",', ''));
    assert.equal(output(codexRuntimeConfig('26.200.456', '26.201.789')), result.bytes.toString());
    assert.equal(output(result.bytes.toString()), result.bytes.toString());
  });

  it('keeps real preference and custom service changes visible', () => {
    for (const [before, after] of [['synthetic-model', 'another-model'], ['STEPS_COMMANDS', 'STEPS_PROSE'], ['high', 'low'], ['/synthetic/service.mjs', '/synthetic/updated.mjs']]) {
      assert.notEqual(output(config.replace(before, after)), output(config));
      assert.include(output(config.replace(before, after)), after);
    }
  });

  it('supports quoted/dotted keys, reordered fields and a relocated Codex home', () => {
    const modified = config
      .replace('[mcp_servers.node_repl.env]\n', '')
      .replace(/^(CODEX_HOME|BROWSER_USE_CODEX_APP_BUILD_FLAVOR|BROWSER_USE_CODEX_APP_VERSION|NODE_REPL_TRUSTED_SERVICES|CUSTOM_SETTING)/gmu, 'env."$1"')
      .replace('[mcp_servers.node_repl]', '["mcp_servers".\'node_repl\']')
      .replaceAll('/synthetic/codex', '/synthetic/relocated root')
      .replace('env."BROWSER_USE_CODEX_APP_VERSION" = "26.100.123"\n', '')
      + 'env."BROWSER_USE_CODEX_APP_VERSION" = "26.100.123"\n';
    assert.notInclude(output(modified), 'BROWSER_USE_CODEX_APP_VERSION');
    assert.notInclude(output(modified), '/plugins/cache/');
    assert.include(output(modified), 'env."CUSTOM_SETTING" = "preserved"');
  });

  it('keeps comments, CRLF and multiline instructions without interpreting embedded settings', () => {
    const instructions = `instructions = """\n[mcp_servers.node_repl.env]\nBROWSER_USE_CODEX_APP_VERSION = \\"not a setting\\"\nNODE_REPL_TRUSTED_SERVICES = \\"not a setting\\"\n"""\n`;
    const modified = (instructions + config).replace('"26.100.123"\n', '"26.100.123" # keep this comment\n').replaceAll('\n', '\r\n');
    const result = output(modified);
    assert.include(result, instructions.replaceAll('\n', '\r\n'));
    assert.include(result, ' # keep this comment\r\n');
    assert.notInclude(result, '"browser":');
    assert.notMatch(result, /(?<!\r)\n/u);
  });

  it('preserves arbitrary JSON service names and escapes without prototype changes', () => {
    const services = JSON.stringify({ browser: '/synthetic/codex/plugins/cache/openai-bundled/browser/26.100.123/scripts/browser-service.mjs', sky: '@oai/sky/service', "owner's service": 'quoted "value"', ['__proto__']: 'preserved' });
    const modified = config.replace(/^NODE_REPL_TRUSTED_SERVICES = .*$/mu, `NODE_REPL_TRUSTED_SERVICES = ${JSON.stringify(services)}`);
    const result = output(modified);
    assert.notInclude(result, '/plugins/cache/');
    assert.include(result, '__proto__');
    assert.include(result, "owner's service");
    assert.include(result, 'preserved');
  });

  it('handles a browser-only map and a final version line without a newline', () => {
    const modified = config.replace(',"sky":"@oai/sky/service","custom":"/synthetic/service.mjs"', '')
      .replace('BROWSER_USE_CODEX_APP_VERSION = "26.100.123"\n', '')
      + 'BROWSER_USE_CODEX_APP_VERSION = "26.100.123"';
    assert.include(output(modified), "NODE_REPL_TRUSTED_SERVICES = '{}'\n");
    assert.notInclude(output(modified), 'BROWSER_USE_CODEX_APP_VERSION');
  });

  for (const literal of [true, false]) {
    it(`keeps an escaped DEL valid in the projected service JSON and TOML (literal: ${literal})`, () => {
      let source = config.replace('/synthetic/service.mjs', '\\u007f');
      if (!literal) source = source.replace(/^NODE_REPL_TRUSTED_SERVICES = '(.*)'$/mu,
        (_line, json: string) => `NODE_REPL_TRUSTED_SERVICES = ${JSON.stringify(json)}`);
      const result = project(source);
      assert.isFalse(result.skipped);
      assert.notInclude(result.bytes.toString(), 'BROWSER_USE_CODEX_APP_VERSION');
      assert.isFalse(result.bytes.includes(127));
      assert.include(result.bytes.toString(), '\\u007f');
    });
  }

  const unrecognized: [string, (source: string) => string][] = [
    ['custom server', (s) => s.replace('/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl', '/synthetic/node_repl')],
    ['server arguments', (s) => s.replace('args = []', 'args = ["custom"]')],
    ['development flavor', (s) => s.replace('"prod"', '"dev"')],
    ['relative home', (s) => s.replaceAll('/synthetic/codex', 'relative/codex')],
    ['traversal home', (s) => s.replaceAll('/synthetic/codex', '/synthetic/../codex')],
    ['trailing home separator', (s) => s.replace('CODEX_HOME = "/synthetic/codex"', 'CODEX_HOME = "/synthetic/codex/"')],
    ['custom browser service', (s) => s.replace('/synthetic/codex/plugins/cache/openai-bundled/browser/26.100.123/scripts/browser-service.mjs', '/synthetic/custom-browser.mjs')],
    ['different marketplace', (s) => s.replace('/cache/openai-bundled/', '/cache/custom/')],
    ['different home in service path', (s) => s.replace('/synthetic/codex/plugins/', '/other/codex/plugins/')],
    ['nonversion cache directory', (s) => s.replace('/browser/26.100.123/', '/browser/latest/')],
    ['nonversion app value', (s) => s.replace('VERSION = "26.100.123"', 'VERSION = "custom"')],
    ['missing version', (s) => s.replace(/^BROWSER_USE_CODEX_APP_VERSION.*\n/mu, '')],
    ['missing services', (s) => s.replace(/^NODE_REPL_TRUSTED_SERVICES.*\n/mu, '')],
    ['different server name', (s) => s.replaceAll('mcp_servers.node_repl', 'mcp_servers.custom_repl')],
    ['similarly named literal table', (s) => s.replace('[mcp_servers.node_repl.env]', '["mcp_servers.node_repl.env"]')],
    ['no browser mapping', (s) => s.replace('"browser":', '"other":')],
  ];
  for (const [name, change] of unrecognized) {
    it(`retains ${name} unchanged`, () => {
      const source = change(config);
      assert.equal(output(source), source);
    });
  }

  const unsupported: [string, (source: string) => string][] = [
    ['inline tables', (s) => `custom = { nested = true }\n${s}`],
    ['array tables', (s) => `${s}\n[[custom]]\nvalue = true\n`],
    ['dates', (s) => `custom = 2026-01-01\n${s}`],
    ['duplicate table', (s) => `${s}\n[mcp_servers.node_repl.env]\n`],
    ['implicit parent redefined after a dotted assignment', (s) => `${s}\n[a.b.c]\nx = 1\n[a]\nb.y = 2\n[a.b]\nz = 3\n`],
    ['duplicate key', (s) => `${s}\nBROWSER_USE_CODEX_APP_VERSION = "26.200.123"\n`],
    ['escaped duplicate key', (s) => `${s}\n"BROWSER_USE_CODEX_APP_VER\\u0053ION" = "26.200.123"\n`],
    ['scalar/table collision', (s) => `mcp_servers = "custom"\n${s}`],
    ['table/scalar collision', (s) => `${s}\n[mcp_servers]\nnode_repl = "custom"\n`],
    ['unterminated string', (s) => `${s}\ncustom = "unterminated`],
    ['invalid escape', (s) => `custom = "\\q"\n${s}`],
    ['invalid Unicode escape', (s) => `custom = "\\uD800"\n${s}`],
    ['invalid Unicode digits', (s) => `custom = "\\uZZZZ"\n${s}`],
    ['too many closing quotes', (s) => `custom = """text""""""\n${s}`],
    ['newline in a single-line string', (s) => `custom = "first\nsecond"\n${s}`],
    ['missing table closing bracket', (s) => `[custom\n${s}`],
    ['missing equals', (s) => `custom true\n${s}`],
    ['missing value', (s) => `custom = # none\n${s}`],
    ['overly deep keys', (s) => `${'a.'.repeat(65)}b = true\n${s}`],
    ['invalid array', (s) => `custom = [1 2]\n${s}`],
    ['unknown value', (s) => `custom = undefined\n${s}`],
    ['trailing statement', (s) => `custom = true extra\n${s}`],
    ['raw control character', (s) => `# comment\u0000\n${s}`],
    ['lone CR', (s) => `custom = true\r${s}`],
    ['multiline key', (s) => `"""key""" = true\n${s}`],
    ['malformed service JSON', (s) => s.replace("SERVICES = '{", "SERVICES = 'broken{")],
    ['duplicate service key', (s) => s.replace('{"browser":', '{"browser":"custom","browser":')],
    ['escaped duplicate service key', (s) => s.replace('{"browser":', '{"bro\\u0077ser":"custom","browser":')],
    ['unknown service value shape', (s) => s.replace('"custom":"/synthetic/service.mjs"', '"custom":{"nested":true}')],
    ['non-object service map', (s) => s.replace(/^NODE_REPL_TRUSTED_SERVICES = .*$/mu, "NODE_REPL_TRUSTED_SERVICES = '[]'")],
    ['trailing service comma', (s) => s.replace("service.mjs\"}'", "service.mjs\",}'")],
    ['invalid JSON whitespace', (s) => s.replace('{"browser":', '{\u00a0"browser":')],
    ['overly deep arrays', (s) => `custom = ${'['.repeat(66)}0${']'.repeat(66)}\n${s}`],
    ['overly many entries', (s) => Array.from({ length: 8193 }, (_, i) => `key${i} = true\n`).join('') + s],
  ];
  for (const [name, change] of unsupported) {
    it(`retains ${name} unchanged and reports that filtering was skipped`, () => {
      const source = change(config);
      const result = project(source);
      assert.isTrue(result.skipped);
      assert.equal(result.bytes.toString(), source);
    });
  }

  it('retains non-UTF-8 source bytes without lossy decoding', () => {
    const bytes = Buffer.concat([Buffer.from(config), Buffer.from([255])]);
    const result = project(bytes);
    assert.isTrue(result.skipped);
    assert.deepEqual(result.bytes, bytes);
  });

  it('allows implicit parent declarations after ordinary values in nested tables', () => {
    const suffix = '\n[a.b.c]\nx = 1\n[a.b]\ny = 2\n[a]\nz = 3\n';
    const result = project(config + suffix);
    assert.isFalse(result.skipped);
    assert.equal(result.bytes.toString(), output(config) + suffix);
  });

  it('accepts conservative scalar, string and array forms without rewriting them', () => {
    const prefix = `quoted = "tab\\tunicode\\u0061\\U0001F600"\nliteral = 'literal # value'\nmultiline = '''\nline\nquote ''\n'''\ncontinued = """first\\\n  second"""\narray = [true, false, [1, -2, +3.14, 1e2, 0xFF, 0o77, 0b11, +inf, nan], # comment\n]\n`;
    assert.isFalse(project(prefix + config).skipped);
    assert.equal(output(prefix + config), prefix + output(config));
    assert.equal(output(config + '  \n# final comment\n'), output(config) + '  \n# final comment\n');
  });
});
