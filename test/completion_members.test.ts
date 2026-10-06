const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withEnvironment, testChildEnvironment } = require('./helpers/environment.ts');
const { completionMemberPaths, configByteLimit } = require('../commands/completion_members.ts');
const { snapshotByteLimit } = require('../commands/recursive_snapshot.ts');
const { configCompletionNames } = require('../config/completion.ts');

const { prepareMemberFixture, fixtureState, archive, bundle, destination } = require('./helpers/completion_members.ts');

describe('completion definitions and local member reader', () => {
  it('derives containers, leaves, and string boolean defaults from config definitions', () => {
    assert.deepEqual(configCompletionNames({ nested: { deep: { on: 'true', off: 'false', actual: true, disabled: false },
      value: 12, text: 'example', nil: null, list: [] } }), {
      readable: ['nested', 'nested.deep', 'nested.deep.on', 'nested.deep.off', 'nested.deep.actual', 'nested.deep.disabled',
        'nested.value', 'nested.text', 'nested.nil', 'nested.list'],
      leaves: ['nested.deep.on', 'nested.deep.off', 'nested.deep.actual', 'nested.deep.disabled', 'nested.value', 'nested.text', 'nested.nil', 'nested.list'],
      booleans: ['nested.deep.on', 'nested.deep.off', 'nested.deep.actual', 'nested.deep.disabled'],
    });
    assert.include(configCompletionNames().booleans, 'update.cleanup');
  });

  let fixture: string;
  let files: ReturnType<typeof prepareMemberFixture>;
  beforeEach(() => {
    fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-member-completion-')));
    files = prepareMemberFixture(fixture);
  });
  afterEach(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const complete = () => completionMemberPaths(bundle, fixture, files.config);

  it('reads only the current destination, preserves literal paths, and changes no state', () => {
    const before = fixtureState(fixture);
    const cwd = process.cwd();
    assert.deepEqual(complete(), ['skill with spaces/SKILL.md', "quotes'and\"marks/file.md", 'other/readme.md']);
    assert.equal(process.cwd(), cwd);
    assert.deepEqual(fixtureState(fixture), before);
    fs.writeFileSync(files.config, JSON.stringify({ backup: { repository: { ...destination, branch: 'different' } } }));
    assert.deepEqual(complete(), []);
    fs.writeFileSync(files.config, JSON.stringify({ backup: { repository: { ...destination, ownerId: 'other' } } }));
    assert.deepEqual(complete(), []);
    assert.deepEqual(completionMemberPaths('../' + bundle, fixture, files.config), []);
    assert.deepEqual(completionMemberPaths('bash_completions', fixture, files.config), []);
  });

  for (const [label, change] of [
    ['missing config', () => fs.unlinkSync(files.config)],
    ['malformed config', () => fs.writeFileSync(files.config, '{')],
    ['invalid UTF-8 config', () => fs.writeFileSync(files.config, Buffer.from([255]))],
    ['unconfigured destination', () => fs.writeFileSync(files.config, '{}')],
    ['invalid destination', () => fs.writeFileSync(files.config, '{"backup":{"repository":{}}}')],
    ['legacy destination', () => fs.writeFileSync(files.config, '{"backup":{"id":"legacy"}}')],
    ['oversized config', () => fs.truncateSync(files.config, configByteLimit + 1)],
    ['missing cache', () => fs.rmSync(files.cache, { recursive: true })],
    ['missing bundle', () => fs.unlinkSync(files.file)],
    ['public cache root', () => fs.chmodSync(files.cache, 0o755)],
    ['public destination cache', () => fs.chmodSync(files.directory, 0o755)],
    ['public bundle', () => fs.chmodSync(files.file, 0o644)],
    ['nonregular bundle', () => { fs.unlinkSync(files.file); fs.mkdirSync(files.file); }],
    ['hardlinked bundle', () => fs.linkSync(files.file, path.join(fixture, 'linked'))],
    ['hardlinked config', () => fs.linkSync(files.config, path.join(fixture, 'linked'))],
    ['oversized bundle', () => fs.truncateSync(files.file, snapshotByteLimit + 1)],
    ['invalid bundle', () => fs.writeFileSync(files.file, '{"format":"unknown"}')],
    ['old bundle version', () => fs.writeFileSync(files.file, archive().replace('"version":2', '"version":1'))],
    ['duplicate paths', () => fs.writeFileSync(files.file, archive(['same', 'same']))],
    ['traversal paths', () => fs.writeFileSync(files.file, archive(['../outside']))],
    ['control characters', () => fs.writeFileSync(files.file, archive(['line\nbreak']))],
  ] as const) {
    it(`quietly rejects ${label} without changing it`, () => {
      change();
      const before = fixtureState(fixture);
      assert.deepEqual(complete(), []);
      assert.deepEqual(fixtureState(fixture), before);
    });
  }

  for (const selected of ['config', 'cache', 'directory', 'file'] as const) {
    it(`rejects a symlinked ${selected} without following or repairing it`, () => {
      const original = files[selected];
      fs.renameSync(original, original + '-real');
      fs.symlinkSync(original + '-real', original);
      const before = fixtureState(fixture);
      assert.deepEqual(complete(), []);
      assert.deepEqual(fixtureState(fixture), before);
    });
  }

  it('returns no candidates for wrong owners and unstable reads', () => {
    const fstat = fs.fstatSync;
    let reads = 0;
    try {
      fs.fstatSync = ((...args: Parameters<typeof fs.fstatSync>) => ({ ...fstat(...args), uid: process.getuid!() + 1 })) as typeof fs.fstatSync;
      assert.deepEqual(complete(), []);
      fs.fstatSync = ((...args: Parameters<typeof fs.fstatSync>) => ({ ...fstat(...args), mtimeMs: ++reads })) as typeof fs.fstatSync;
      assert.deepEqual(complete(), []);
    } finally { fs.fstatSync = fstat; }
  });

  it('supports the silent subprocess protocol and rejects extra arguments', () => {
    const helper = path.join(__dirname, '..', 'commands', 'completion_members.ts');
    for (const [args, expected] of [[[bundle], 'skill with spaces/SKILL.md\nquotes\'and"marks/file.md\nother/readme.md\n'],
      [[bundle, 'extra'], ''], [['unknown'], '']] as const) {
      const result = spawnSync(process.execPath, [helper, ...args], { cwd: fixture, encoding: 'utf8', timeout: 2000,
        env: testChildEnvironment({ BALLIN_TEST_REPO_DIR: fixture, BALLIN_TEST_CONFIG_PATH: files.config,
          NODE_OPTIONS: `--require=${path.join(fixture, 'completion-guard.cjs')}` }) });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, expected);
      assert.isFalse(fs.existsSync(path.join(fixture, 'forbidden')));
    }
    withEnvironment({ BALLIN_TEST_CONFIG_PATH: undefined }, () => assert.deepEqual(completionMemberPaths('unknown'), []));
  });
});
