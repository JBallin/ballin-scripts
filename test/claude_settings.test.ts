const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { projectClaudeSettings, serializeClaudeSettings, captureClaudeSettings } = require('../commands/claude_settings.ts');
const { snapshotDefinitions, classifySnapshotFileName } = require('../commands/backup_snapshots.ts');
const { snapshotByteLimit } = require('../commands/recursive_snapshot.ts');
const { testChildEnvironment } = require('./helpers/environment.ts');
import type { SnapshotDefinition } from '../commands/backup_snapshots.ts';

describe('filtered Claude settings', () => {
  let home: string;
  let root: string;
  const definition = (snapshotDefinitions as SnapshotDefinition[]).find(({ name }) => name === 'claude_settings.json')!;
  const write = (value: string | Buffer, directory = root): string => {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'settings.json');
    fs.writeFileSync(file, value);
    return file;
  };
  const discover = (env: NodeJS.ProcessEnv = {}) => definition.discover({ homeDir: home, env: testChildEnvironment({ HOME: home, ...env }) });
  const run = (extra: string[] = [], env: NodeJS.ProcessEnv = {}) => {
    const observation = discover(env);
    if (observation.status !== 'available') throw new Error('Fixture source unavailable');
    return spawnSync(observation.collector.command, [...observation.collector.args!, ...extra], {
      env: observation.collector.env, encoding: 'utf8',
    });
  };
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-claude-settings-')));
    root = path.join(home, '.claude');
    fs.mkdirSync(root);
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('uses the settings filename without adding a pre-release read alias', () => {
    assert.equal(definition.inclusionGroup, 'sensitive');
    assert.equal(classifySnapshotFileName('claude_settings.json'), 'current');
    assert.equal(classifySnapshotFileName('claude_preferences.json'), 'unexpected');
  });

  it('preserves the exact reviewed settings and reconstructs nested objects', () => {
    const expected = {
      model: 'synthetic-model', effortLevel: 'high', alwaysThinkingEnabled: false,
      language: 'English', outputStyle: 'custom-style', theme: 'custom-theme', verbose: true,
      editorMode: 'vim', viewMode: 'focus', spinnerTipsEnabled: false,
      terminalProgressBarEnabled: true, showTurnDuration: false, prefersReducedMotion: true,
      attribution: { commit: '', pr: 'Private attribution', sessionUrl: false },
      modelSettings: { 'synthetic-model': { effortLevel: 'xhigh', maxEffortLevel: 'max' } },
    };
    const actual = projectClaudeSettings({
      ...expected,
      env: { SECRET: 'DUMMY_EXCLUDED' }, apiKeyHelper: 'DUMMY_EXCLUDED', awsAuthRefresh: 'DUMMY_EXCLUDED',
      hooks: { PreToolUse: [{ hooks: [{ type: 'http', url: 'DUMMY_EXCLUDED' }, { type: 'mcp', tool: 'DUMMY_EXCLUDED' }] }] },
      statusLine: { command: 'DUMMY_EXCLUDED' }, subagentStatusLine: { command: 'DUMMY_EXCLUDED' },
      fileSuggestion: { command: 'DUMMY_EXCLUDED' }, processWrapper: 'DUMMY_EXCLUDED',
      permissions: { allow: ['DUMMY_EXCLUDED'], deny: ['DUMMY_EXCLUDED'] }, sandbox: { enabled: false },
      autoMode: { environment: ['DUMMY_EXCLUDED'] },
      enableAllProjectMcpServers: true, enabledPlugins: { DUMMY_EXCLUDED: true },
      pluginConfigs: { DUMMY_EXCLUDED: {} }, extraKnownMarketplaces: { DUMMY_EXCLUDED: {} },
      autoMemoryDirectory: 'DUMMY_EXCLUDED', cleanupPeriodDays: 1, futureKey: 'DUMMY_EXCLUDED',
      attribution: { ...expected.attribution, future: 'DUMMY_EXCLUDED' },
      modelSettings: {
        'synthetic-model': { ...expected.modelSettings['synthetic-model'], autoCompactWindow: 100000, future: 'DUMMY_EXCLUDED' },
        'unknown-only-model': { future: 'DUMMY_EXCLUDED' },
      },
    });
    assert.deepEqual(actual, expected);
    assert.notInclude(JSON.stringify(actual), 'DUMMY_EXCLUDED');
    assert.equal(projectClaudeSettings({ attribution: false }).attribution, false);
    assert.deepEqual(projectClaudeSettings({}), {});
    assert.deepEqual(projectClaudeSettings({ attribution: {}, modelSettings: {} }), { attribution: {}, modelSettings: {} });
  });

  it('keeps admitted arbitrary strings intact, without claiming to scan for secrets', () => {
    const value = 'DUMMY_PRIVATE_VALUE\nwith whitespace';
    assert.deepEqual(projectClaudeSettings({ model: value, language: value, outputStyle: value, attribution: { commit: value } }), {
      model: value, language: value, outputStyle: value, attribution: { commit: value },
    });
  });

  it('is deterministic across formatting and top-level, leaf and model ordering', () => {
    const a = { modelSettings: { z: { maxEffortLevel: 'max', effortLevel: 'low' }, a: { effortLevel: 'high' } }, attribution: { pr: '', commit: '' }, model: 'sonnet' };
    const b = { model: 'sonnet', attribution: { commit: '', pr: '' }, modelSettings: { a: { effortLevel: 'high' }, z: { effortLevel: 'low', maxEffortLevel: 'max' } } };
    assert.equal(serializeClaudeSettings(JSON.stringify(a)), serializeClaudeSettings(JSON.stringify(b, null, 4)));
    assert.equal(serializeClaudeSettings('{"future":42,"env":false,"permissions":null}'), '{}\n');
    assert.equal(serializeClaudeSettings('{"env":{"duplicated":1,"duplicated":2}}'), '{}\n');
    assert.equal(serializeClaudeSettings('{"attribution":{"future":1,"future":2}}'), '{\n  "attribution": {}\n}\n');
  });

  it('ignores inherited properties and safely retains unusual model identifiers', () => {
    assert.deepEqual(projectClaudeSettings(Object.create({ model: 'inherited' })), {});
    const output = JSON.parse(serializeClaudeSettings('{"modelSettings":{"__proto__":{"effortLevel":"low"},"constructor":{"maxEffortLevel":"max"}}}'));
    assert.equal(Object.getPrototypeOf(output), Object.prototype);
    assert.isTrue(Object.hasOwn(output.modelSettings, '__proto__'));
    assert.deepEqual(output.modelSettings.__proto__, { effortLevel: 'low' });
  });

  for (const [name, text] of [
    ['empty', ''], ['whitespace', ' \n'], ['invalid syntax', '{"DUMMY_PRIVATE_VALUE":'],
    ['null root', 'null'], ['array root', '["DUMMY_PRIVATE_VALUE"]'], ['scalar root', '"DUMMY_PRIVATE_VALUE"'],
    ['wrong model type', '{"model":false}'], ['wrong Boolean type', '{"verbose":"DUMMY_PRIVATE_VALUE"}'],
    ['unknown effort', '{"effortLevel":"DUMMY_PRIVATE_VALUE"}'], ['invalid editor mode', '{"editorMode":false}'],
    ['invalid view mode', '{"viewMode":null}'], ['wrong attribution', '{"attribution":true}'],
    ['wrong attribution leaf', '{"attribution":{"commit":false}}'],
    ['wrong model map', '{"modelSettings":[]}'], ['wrong model entry', '{"modelSettings":{"DUMMY_PRIVATE_VALUE":null}}'],
    ['wrong model effort', '{"modelSettings":{"DUMMY_PRIVATE_VALUE":{"effortLevel":1}}}'],
    ['wrong model cap', '{"modelSettings":{"DUMMY_PRIVATE_VALUE":{"maxEffortLevel":"invalid"}}}'],
    ['duplicate root', '{"model":"sonnet","m\\u006fdel":"opus"}'],
    ['duplicate attribution', '{"attribution":{"commit":"","c\\u006fmmit":""}}'],
    ['duplicate model', '{"modelSettings":{"DUMMY_PRIVATE_VALUE":{},"DUMMY_PRIVATE_VALUE":{}}}'],
    ['duplicate model leaf', '{"modelSettings":{"DUMMY_PRIVATE_VALUE":{"effortLevel":"low","effortLevel":"high"}}}'],
  ]) {
    it(`fails ${name} without partial output or source values`, () => {
      write(text);
      const result = run();
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.include(result.stderr, 'ballin Claude settings:');
      assert.notInclude(result.stderr, 'DUMMY_PRIVATE_VALUE');
    });
  }

  it('ignores duplicates and nested values inside excluded fields', () => {
    assert.equal(serializeClaudeSettings('{"future":[{"model":1,"model":2}],"env":{"model":"a","model":"b"},"other":"commas, brackets[] {}"}'), '{}\n');
  });

  for (const mode of ['default', 'empty', 'absolute', 'relative', 'alias']) {
    it(`uses only the selected global root (${mode})`, () => {
      write('{"model":"default"}');
      const active = path.join(home, 'active');
      write('{"model":"active"}', active);
      const alias = path.join(home, 'alias');
      fs.symlinkSync(active, alias);
      const override = mode === 'default' ? undefined : mode === 'empty' ? '' : mode === 'absolute' ? active
        : mode === 'relative' ? path.relative(process.cwd(), active) : alias;
      const result = run([], { CLAUDE_CONFIG_DIR: override });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { model: ['default', 'empty'].includes(mode) ? 'default' : 'active' });
    });
  }

  it('does not read source bytes during discovery or add project/local sources', () => {
    write('{"model":"synthetic"}');
    const original = fs.readFileSync;
    try {
      fs.readFileSync = () => { throw new Error('Source read during discovery'); };
      assert.equal(discover().status, 'available');
    } finally { fs.readFileSync = original; }
    fs.unlinkSync(path.join(root, 'settings.json'));
    fs.writeFileSync(path.join(root, 'settings.local.json'), 'DUMMY_LOCAL_SECRET');
    write('{"model":"project"}', path.join(home, 'project', '.claude'));
    assert.equal(discover().status, 'absent');
  });

  it('rejects a directory, symlink, hard link and capture-time replacement without following them', () => {
    const file = path.join(root, 'settings.json');
    fs.mkdirSync(file); assert.equal(discover().status, 'unavailable'); fs.rmdirSync(file);
    const outside = write('{"model":"DUMMY_PRIVATE_VALUE"}', path.join(home, 'outside'));
    fs.symlinkSync(outside, file); assert.equal(discover().status, 'unavailable'); fs.unlinkSync(file);
    fs.linkSync(outside, file); assert.equal(discover().status, 'discovery-failed'); fs.unlinkSync(file);
    write('{}'); const observation = discover();
    if (observation.status !== 'available') throw new Error('Expected available fixture');
    fs.unlinkSync(file); fs.symlinkSync(outside, file);
    const result = spawnSync(observation.collector.command, observation.collector.args, { env: observation.collector.env, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.notInclude(result.stderr, 'DUMMY_PRIVATE_VALUE');
  });

  it('fails closed for invalid UTF-8 and oversized raw input', () => {
    write(Buffer.from([0xff]));
    assert.include(run().stderr, 'not valid UTF-8');
    write(Buffer.alloc(snapshotByteLimit + 1, 32));
    const result = run();
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
  });

  it('bounds filtered output independently of raw input and emits a JSON empty object', () => {
    write(JSON.stringify({ env: { VALUE: 'x'.repeat(1000) } }));
    assert.equal(run(['--max-bytes', '3']).stdout, '{}\n');
    const result = run(['--max-bytes', '2']);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.equal(captureClaudeSettings(root, 'settings.json'), '{}\n');
  });

  for (const extra of [['--max-bytes', '-1'], ['--max-bytes', 'NaN'], ['--max-bytes'], ['--unexpected'], ['--max-bytes', String(snapshotByteLimit + 1)]]) {
    it(`rejects invalid collector flags ${extra.join(' ')}`, () => {
      write('{}'); const result = run(extra);
      assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.include(result.stderr, 'Invalid snapshot limit');
    });
  }
  it('rejects incomplete collector arguments', () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../commands/claude_settings.ts')], {
      env: testChildEnvironment({ HOME: home }), encoding: 'utf8',
    });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.include(result.stderr, 'Invalid collector arguments');
  });
});
