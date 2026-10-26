const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const { topLevelCommandNames } = require('../commands/top_level_commands.ts');
const { backupCommandNames } = require('../commands/backup_commands.ts');

const repoRoot = path.join(__dirname, '..');
const forms: { args: string[]; canonical: string[]; usage: string }[] = [
  ...topLevelCommandNames.flatMap((command: string) => [
    { args: [command, '--help'], canonical: [command, '--help'], usage: `ballin ${command}` },
    { args: ['help', command], canonical: [command, '--help'], usage: `ballin ${command}` },
  ]),
  ...backupCommandNames.flatMap((command: string) => [
    { args: ['backup', command, '--help'], canonical: ['backup', command, '--help'], usage: `ballin backup ${command}` },
    { args: ['help', 'backup', command], canonical: ['backup', command, '--help'], usage: `ballin backup ${command}` },
  ]),
  { args: ['backup', 'help'], canonical: ['--help'], usage: 'ballin <command> [options]' },
  { args: ['config', 'help'], canonical: ['config', '--help'], usage: 'ballin config' },
];

describe('offline command and backup subcommand help', () => {
  let root: string;
  let configPath: string;
  let preloadPath: string;
  let attemptsPath: string;

  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'ballin'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 3000,
    env: testChildEnvironment({
      HOME: root, PATH: root, TMPDIR: root,
      BALLIN_TEST_REPO_DIR: root, BALLIN_TEST_CONFIG_PATH: configPath,
      NODE_ENV: 'production', BALLIN_NO_ANALYTICS: undefined, BALLIN_NO_COMMAND_ANALYTICS: undefined,
      NODE_OPTIONS: `--require=${preloadPath}`, ...env,
    }),
  });

  const snapshot = (): unknown => {
    const visit = (directory: string): unknown => fs.readdirSync(directory).sort().map((name: string) => {
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      return { name, mode: stat.mode, value: stat.isDirectory() ? visit(target) : fs.readFileSync(target, 'base64') };
    });
    return visit(root);
  };

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-help-')));
    configPath = path.join(root, 'ballin.config.json');
    preloadPath = path.join(root, 'guard.cjs');
    attemptsPath = path.join(root, 'forbidden-actions');
    for (const directory of ['.backup-cache', '.config/gh']) {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
      fs.writeFileSync(path.join(root, directory, 'sentinel'), 'retained\n', { mode: 0o600 });
    }
    fs.writeFileSync(preloadPath, `
Object.defineProperty(process.stdout, 'columns', { value: Number(process.env.HELP_COLUMNS) || undefined });
Object.defineProperty(process.stdout, 'isTTY', { value: process.env.HELP_TTY === '1' });
const fs = require('fs');
const path = require('path');
const open = fs.openSync.bind(fs);
const write = fs.writeSync.bind(fs);
const close = fs.closeSync.bind(fs);
const reject = (action) => {
  const fd = open(${JSON.stringify(attemptsPath)}, 'a');
  try { write(fd, action + '\\n'); } finally { close(fd); }
  const error = new Error('Forbidden help action: ' + action);
  error.code = 'EACCES';
  throw error;
};
for (const api of [fs, fs.promises]) {
  for (const name of ['readFile', 'writeFile', 'appendFile', 'open', 'access', 'exists',
    'stat', 'lstat', 'mkdir', 'readdir', 'rename', 'link', 'unlink', 'rm', 'rmdir',
    'chmod', 'chown', 'copyFile', 'realpath', 'mkdtemp', 'createReadStream', 'createWriteStream']) {
    for (const method of [name, name + 'Sync']) {
      const original = api[method];
      if (!original) continue;
      api[method] = (...values) => {
        const targets = ['rename', 'link', 'copyFile'].includes(name) ? values.slice(0, 2) : values.slice(0, 1);
        for (const target of targets) {
          if (typeof target !== 'string' && !Buffer.isBuffer(target)) continue;
          const resolved = path.resolve(String(target));
          if (resolved === ${JSON.stringify(root)} || resolved.startsWith(${JSON.stringify(root + path.sep)})
            || resolved === ${JSON.stringify(path.join(repoRoot, 'config', '.defaultConfig.json'))}) reject('fs.' + method);
        }
        return original.apply(api, values);
      };
    }
  }
}
const readSync = fs.readSync;
fs.readSync = (...args) => args[0] === 0 ? reject('stdin read') : readSync(...args);
Object.defineProperty(process, 'stdin', { get() { return reject('stdin stream'); } });
for (const module of ['http', 'https']) {
  for (const name of ['request', 'get']) require(module)[name] = () => reject(module + '.' + name);
}
for (const name of ['connect', 'createConnection']) require('net')[name] = () => reject('net.' + name);
globalThis.fetch = () => reject('fetch');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  require('child_process')[name] = () => reject('child_process.' + name);
}
const analytics = require(${JSON.stringify(path.join(repoRoot, 'commands', 'analytics.ts'))});
for (const name of ['ensureAnalyticsInstallId', 'runWithCommandAnalytics', 'recordBehavioralAnalyticsEvent']) {
  analytics[name] = () => reject(name);
}
const helpers = require(${JSON.stringify(path.join(repoRoot, 'commands', 'commandHelpers.ts'))});
for (const name of ['readPromptLine', 'readYesNo', 'promptInputState']) helpers[name] = () => reject(name);
`);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('detects ordinary operational routing with the enabled-analytics guard', () => {
    fs.writeFileSync(configPath, '{"analytics":{"enabled":"true"}}');
    const result = run(['backup', 'list']);
    assert.notEqual(result.status, 0);
    const attempts = fs.readFileSync(attemptsPath, 'utf8');
    assert.include(attempts, 'fs.readFileSync');
    assert.include(attempts, 'runWithCommandAnalytics');
    assert.equal(result.stdout, '');
  });

  it('shows operation-specific syntax and backup consequences', () => {
    for (const [command, details] of Object.entries({
      setup: ['setup [repository-name]', 'confirmation', 'sensitive-source', '#optional-backup-setup-and-reconnect', 'docs/backup-sources.md'],
      open: ['Open the configured backup in your browser', 'authentication for the selected GitHub host and remote access'],
      list: ['List supported snapshots', 'remote read access', 'does not collect local backup sources'],
      read: ['read <snapshot> --list', 'read <snapshot> --file <path>', 'original bytes', 'Without a snapshot selector', '#inspect-saved-backups'],
      disconnect: ['disable automatic backup', 'Preserve remote history', 'sensitive-source preferences', 'no authentication or network access'],
    })) {
      const result = run(['backup', command, '--help']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      for (const detail of details) assert.include(result.stdout.replace(/\s+/gu, ' '), detail);
    }
    assert.isFalse(fs.existsSync(attemptsPath));
  });

  it('teaches prefix help and mentions the trailing flag once as an alternative', () => {
    const result = run(['help']);
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'ballin help [command...]');
    assert.include(result.stdout, 'Run `ballin help <command...>` for command or subcommand help.');
    assert.include(result.stdout, 'You can also append `--help` to a command.');
    assert.lengthOf([...result.stdout.matchAll(/--help/gu)], 1);
  });

  for (const columns of [40, 80, 120]) {
    for (const mode of [
      { name: 'styled TTY', HELP_TTY: '1', TERM: 'xterm', NO_COLOR: '' },
      { name: 'TERM=dumb', HELP_TTY: '1', TERM: 'dumb', NO_COLOR: '' },
      { name: 'NO_COLOR', HELP_TTY: '1', TERM: 'xterm', NO_COLOR: '1' },
      { name: 'redirected', HELP_TTY: '0', TERM: 'xterm', NO_COLOR: '' },
    ]) {
      for (const target of [[], ['setup'], ['backup'], ['backup', 'read'], ['backup', 'setup'], ['config']]) {
        it(`wraps ${['help', ...target].join(' ')} at ${columns} columns for ${mode.name} without side effects`, () => {
          const before = snapshot();
          const env = { ...mode, HELP_COLUMNS: String(columns) };
          const result = run(['help', ...target], env);
          const equivalent = run(target.length ? [...target, '--help'] : ['--help'], env);
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stderr, '');
          assert.equal(equivalent.status, 0, equivalent.stderr);
          assert.equal(equivalent.stderr, '');
          assert.equal(result.stdout, equivalent.stdout);
          const plain = result.stdout.replace(/\x1b\[[0-9;]*m/gu, '');
          const baseline = run(['help', ...target]).stdout;
          const content = (text: string) => text.replace(/`/gu, '').replace(/\s+/gu, ' ').trim();
          assert.equal(content(plain), content(baseline));
          assert.equal(result.stdout.includes('\x1b['), mode.name === 'styled TTY' && target.length === 0
            || mode.name === 'styled TTY' && target.join(' ') === 'backup');
          for (const line of plain.split('\n')) {
            // Usage is deliberately preformatted; indivisible URLs and syntax may overflow.
            if (line.trimStart().startsWith('ballin ') || line.length <= Math.min(columns, 80)) continue;
            assert.isTrue(line.trim().split(' ').some((word: string) => word.length > Math.min(columns, 80)), line);
          }
          for (const url of baseline.match(/https:\/\/\S+/gu) ?? []) assert.include(plain, url);
          assert.isFalse(fs.existsSync(attemptsPath));
          assert.deepEqual(snapshot(), before);
        });
      }
    }
  }

  for (const command of backupCommandNames) {
    it(`keeps ${command} help focused on operational syntax`, () => {
      const result = run(['help', 'backup', command]);
      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stdout, `ballin backup ${command}`);
      assert.notInclude(result.stdout, '--help');
    });
  }

  for (const { args, canonical, usage } of forms) {
    for (const config of ['missing', 'malformed', 'enabled']) {
      for (const identity of [undefined, 'invalid-id\n', '11111111-1111-4111-8111-111111111111\n']) {
        it(`keeps ${args.join(' ')} local with ${config} config and ${identity === undefined ? 'missing' : identity.trim()} identity`, () => {
          if (config !== 'missing') fs.writeFileSync(configPath, config === 'malformed'
            ? '{invalid' : '{"analytics":{"enabled":"true"}}');
          if (identity !== undefined) {
            fs.mkdirSync(path.join(root, '.analytics'));
            fs.writeFileSync(path.join(root, '.analytics', 'install-id'), identity);
          }
          const before = snapshot();
          const result = run(args);
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stderr, '');
          assert.include(result.stdout, usage);
          if (args.join(' ') !== canonical.join(' ')) {
            const equivalent = run(canonical);
            assert.equal(equivalent.status, 0, equivalent.stderr);
            assert.equal(equivalent.stderr, '');
            assert.equal(result.stdout, equivalent.stdout);
          }
          assert.isFalse(fs.existsSync(attemptsPath));
          assert.deepEqual(snapshot(), before);
        });
      }
    }
  }
});
