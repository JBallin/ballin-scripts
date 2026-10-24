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
    { args: [command, '--help'], canonical: [command, '--help'], usage: `ballin ${command} --help` },
    { args: ['help', command], canonical: [command, '--help'], usage: `ballin ${command} --help` },
  ]),
  ...backupCommandNames.map((command: string) => ({
    args: ['backup', command, '--help'], canonical: ['backup', command, '--help'],
    usage: `ballin backup ${command} --help`,
  })),
  { args: ['backup', 'help'], canonical: ['--help'], usage: 'ballin <command> [options]' },
  { args: ['config', 'help'], canonical: ['config', '--help'], usage: 'ballin config --help' },
];

describe('offline command and backup subcommand help', () => {
  let root: string;
  let configPath: string;
  let preloadPath: string;
  let attemptsPath: string;

  const run = (args: string[]) => spawnSync(process.execPath, [path.join(repoRoot, 'bin', 'ballin'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 3000,
    env: testChildEnvironment({
      HOME: root, PATH: root, TMPDIR: root,
      BALLIN_TEST_REPO_DIR: root, BALLIN_TEST_CONFIG_PATH: configPath,
      NODE_ENV: 'production', BALLIN_NO_ANALYTICS: undefined, BALLIN_NO_COMMAND_ANALYTICS: undefined,
      NODE_OPTIONS: `--require=${preloadPath}`,
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
      open: ['Open the configured backup in your browser', 'authentication and remote access'],
      list: ['List supported snapshots', 'remote read access', 'does not collect local backup sources'],
      read: ['read <snapshot> --list', 'read <snapshot> --file <path>', 'original bytes', 'Without a snapshot selector', '#inspect-saved-backups'],
      disconnect: ['disable automatic backup', 'Preserve remote history', 'sensitive-source preferences', 'no authentication or network access'],
    })) {
      const result = run(['backup', command, '--help']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      for (const detail of details) assert.include(result.stdout, detail);
    }
    assert.isFalse(fs.existsSync(attemptsPath));
  });

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
