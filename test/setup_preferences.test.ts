const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const { createAnalyticsCapture } = require('./helpers/analytics.ts');

const ballinPath = path.join(__dirname, '..', 'bin', 'ballin');
const preferencesPath = path.join(__dirname, '..', 'commands', 'backup_preferences.ts');

describe('guided preference setup', () => {
  let root: string;
  let configPath: string;
  let guardPath: string;
  let callsPath: string;
  let capture: ReturnType<typeof createAnalyticsCapture>;

  const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const writeConfig = (config: unknown) => fs.writeFileSync(configPath, JSON.stringify(config));
  const configFor = (kind = 'repository', enabled = false) => ({
    backup: {
      id: kind === 'legacy-gist' ? 'fixture-gist' : null,
      repository: kind === 'repository' ? { id: '1', ownerId: '2', name: 'fixture-backup', branch: 'main' } : null,
      includeSensitive: String(enabled),
      custom: { retained: true },
    },
    update: { backup: String(enabled), npm: 'false', custom: 'retained' },
    analytics: { enabled: String(enabled), custom: 'retained' },
    custom: { retained: true },
  });
  const run = (input = '', args = ['setup'], env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [ballinPath, ...args], {
    input,
    encoding: 'utf8',
    env: testChildEnvironment({
      HOME: root,
      PATH: root,
      BALLIN_TEST_CONFIG_PATH: configPath,
      NODE_OPTIONS: `--require ${JSON.stringify(guardPath)}`,
      ...env,
    }),
  });
  const assertNoCalls = () => assert.isFalse(fs.existsSync(callsPath), 'no child workflows or raw source reads');

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-preferences-')));
    configPath = path.join(root, 'ballin.config.json');
    callsPath = path.join(root, 'calls');
    guardPath = path.join(root, 'guard.cjs');
    capture = createAnalyticsCapture(root);
    fs.writeFileSync(guardPath, `
const fs = require('fs');
const cp = require('child_process');
cp.spawnSync = (...args) => { fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + '\\n'); throw new Error('No child workflows allowed'); };
const read = fs.readFileSync;
fs.readFileSync = (file, ...args) => {
  if (typeof file === 'string' && (file === ${JSON.stringify(path.join(root, '.zshrc'))} || file.startsWith(${JSON.stringify(path.join(root, '.codex') + path.sep)}))) {
    fs.appendFileSync(${JSON.stringify(callsPath)}, 'raw source read\\n'); throw new Error('No source content reads allowed');
  }
  return read(file, ...args);
};
`);
    // Availability inspection is permitted; running pipx to collect metadata is forbidden.
    fs.writeFileSync(path.join(root, 'pipx'), '#!/bin/sh\nexit 91\n', { mode: 0o755 });
    writeConfig(configFor());
  });
  afterEach(() => {
    assertNoCalls();
    fs.rmSync(root, { recursive: true, force: true });
  });

  [false, true].forEach((enabled) => {
    it(`accepts current ${enabled} defaults and preserves custom settings`, () => {
      const initial = configFor('repository', enabled);
      writeConfig(initial);
      fs.writeFileSync(path.join(root, '.zshrc'), 'fixture private content');
      const result = run('\ny\n\n\n');
      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stdout, `metadata)? ${enabled ? '[Y/n]' : '[y/N]'}`);
      assert.include(result.stdout, `update? ${enabled ? '[Y/n]' : '[y/N]'}`);
      assert.include(result.stdout, `Usage analytics are currently ${enabled ? 'enabled' : 'disabled'}.`);
      assert.include(result.stdout, `Share usage analytics to help improve Ballin? ${enabled ? '[Y/n]' : '[y/N]'}`);
      assert.deepEqual(readConfig(), { ...initial, backup: { ...initial.backup, sensitiveSourcesVersion: 2 } });
      assert.include(result.stdout, 'preference review complete');
      if (enabled) {
        assert.include(result.stdout, 'pipx: available');
        assert.include(result.stdout, JSON.stringify(path.join(root, '.zshrc')));
      } else assert.notInclude(result.stdout, 'pipx:');
    });
    it(`changes all ${enabled} choices through the existing owners`, () => {
      writeConfig(configFor('repository', enabled));
      const answer = enabled ? 'n' : 'y';
      const result = run(`${answer}\ny\n${answer}\n${answer}\n`);
      assert.equal(result.status, 0, result.stderr);
      const config = readConfig();
      assert.equal(config.backup.includeSensitive, String(!enabled));
      assert.equal(config.backup.sensitiveSourcesVersion, 2);
      assert.equal(config.update.backup, String(!enabled));
      assert.equal(config.analytics.enabled, String(!enabled));
      assert.include(result.stdout, `"backup.includeSensitive" set to: "${!enabled}"`);
    });
  });

  ['unconfigured', 'legacy-gist'].forEach((kind) => {
    it(`reviews only applicable choices for ${kind}`, () => {
      const initial = configFor(kind);
      writeConfig(initial);
      const result = run(kind === 'legacy-gist' ? 'y\ny\n' : 'y\n');
      assert.equal(result.status, 0, result.stderr);
      assert.notInclude(result.stdout, 'Also include sensitive sources');
      assert.equal(readConfig().backup.includeSensitive, initial.backup.includeSensitive);
      assert.equal(readConfig().analytics.enabled, 'true');
      if (kind === 'legacy-gist') {
        assert.include(result.stdout, 'Legacy Gist backups retain their original sources');
        assert.equal(readConfig().update.backup, 'true');
      } else {
        assert.notInclude(result.stdout, 'Automatically run');
        assert.include(result.stdout, 'Run `ballin backup setup`');
        assert.equal(readConfig().update.backup, 'false');
      }
    });
  });

  ['', 'y', 'y\n', 'y\ny', 'y\nn\n'].forEach((input) => {
    it(`leaves unconfirmed sensitive choice unchanged on ${JSON.stringify(input)}`, () => {
      const before = fs.readFileSync(configPath, 'utf8');
      const result = run(input);
      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stdout, 'Preference review cancelled');
      assert.equal(fs.readFileSync(configPath, 'utf8'), before);
      assert.notInclude(result.stdout, 'Automatically run');
      assert.notInclude(result.stdout, 'Share usage analytics to help improve Ballin?');
    });
  });

  ['n\ny\n', 'n\ny\nn', 'n\ny\nn\n', 'n\ny\nn\nn'].forEach((input) => {
    it(`stops at EOF and retains only confirmed choices: ${JSON.stringify(input)}`, () => {
      writeConfig(configFor('repository', true));
      const result = run(input);
      assert.equal(result.status, 0, result.stderr);
      const config = readConfig();
      assert.equal(config.backup.includeSensitive, 'false');
      assert.equal(config.update.backup, input.startsWith('n\ny\nn\n') ? 'false' : 'true');
      assert.equal(config.analytics.enabled, 'true');
      assert.include(result.stdout, 'Earlier confirmed choices remain saved');
      if (!input.startsWith('n\ny\nn\n')) assert.notInclude(result.stdout, 'Share usage analytics to help improve Ballin?');
    });
  });

  ['\n', 'n\n', 'y\n', 'Y\n', '', 'y'].forEach((input) => {
    it(`uses the fresh automatic-backup default without running a backup: ${JSON.stringify(input)}`, () => {
      writeConfig(configFor('legacy-gist', true));
      const result = spawnSync(process.execPath, ['-e', `process.exitCode = require(${JSON.stringify(preferencesPath)}).offerAutomaticUpdateBackup(process.env.BALLIN_TEST_CONFIG_PATH) ? 0 : 1`], {
        input, encoding: 'utf8', env: testChildEnvironment({ HOME: root, PATH: root, BALLIN_TEST_CONFIG_PATH: configPath, NODE_OPTIONS: `--require ${JSON.stringify(guardPath)}` }),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stdout, 'Automatically run ballin backup after ballin update? [y/N]');
      assert.equal(readConfig().update.backup, ['y\n', 'Y\n', 'y'].includes(input) ? 'true' : 'false');
    });
  });

  it('preserves the pending automatic choice on EOF while onboarding still saves false', () => {
    writeConfig(configFor('legacy-gist', true));
    assert.equal(run().status, 0);
    assert.equal(readConfig().update.backup, 'true');
    const result = spawnSync(process.execPath, ['-e', `process.exitCode = require(${JSON.stringify(preferencesPath)}).offerAutomaticUpdateBackup(process.env.BALLIN_TEST_CONFIG_PATH) ? 0 : 1`], {
      input: '', encoding: 'utf8', env: testChildEnvironment({ HOME: root, BALLIN_TEST_CONFIG_PATH: configPath }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readConfig().update.backup, 'false');
  });

  ['sensitive', 'automatic'].forEach((choice) => {
    it(`preserves the pending ${choice} choice on SIGINT`, async () => {
      writeConfig(configFor('repository', true));
      const child = spawn(process.execPath, [ballinPath, 'setup'], {
        env: testChildEnvironment({ HOME: root, PATH: root, BALLIN_TEST_CONFIG_PATH: configPath, NODE_OPTIONS: `--require ${JSON.stringify(guardPath)}` }),
      });
      let output = '';
      let signalled = false;
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const prompt = choice === 'sensitive' ? 'Also include sensitive sources' : 'Automatically run';
        if (!signalled && output.includes(prompt)) { signalled = true; child.kill('SIGINT'); }
      });
      if (choice === 'automatic') child.stdin.write('n\ny\n');
      const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture prompt timeout')); }, 3000);
        child.once('error', (error: Error) => { clearTimeout(timer); reject(error); });
        child.once('exit', (code: number | null, signal: string | null) => { clearTimeout(timer); resolve({ code, signal }); });
      });
      assert.equal(result.signal, 'SIGINT');
      assert.equal(readConfig().backup.includeSensitive, choice === 'sensitive' ? 'true' : 'false');
      assert.equal(readConfig().update.backup, 'true');
      assert.equal(readConfig().analytics.enabled, 'true');
    });
  });

  it('accepts native boolean choices', () => {
    const config = configFor('repository');
    writeConfig({ ...config, backup: { ...config.backup, includeSensitive: true }, update: { backup: false }, analytics: { enabled: true } });
    const result = run('\ny\n\n\n');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readConfig().backup.includeSensitive, 'true');
    assert.equal(readConfig().update.backup, 'false');
    assert.equal(readConfig().analytics.enabled, 'true');
  });

  it('stops on sensitive inspection failure without saving', () => {
    fs.writeFileSync(path.join(root, '.zshrc'), 'fixture content');
    fs.appendFileSync(guardPath, `const realpath = fs.realpathSync; fs.realpathSync = (file, ...args) => {
      if (file === ${JSON.stringify(path.join(root, '.zshrc'))}) throw new Error('fixture resolution failure');
      return realpath(file, ...args);
    };\n`);
    const before = fs.readFileSync(configPath, 'utf8');
    const result = run('y\ny\ny\ny\n');
    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Unable to review');
    assert.equal(fs.readFileSync(configPath, 'utf8'), before);
    assert.notInclude(result.stdout, 'Automatically run');
  });

  it('reviews recursive Codex directories with metadata without collecting their contents', () => {
    const skills = path.join(root, '.codex', 'skills');
    fs.mkdirSync(path.join(skills, 'synthetic'), { recursive: true });
    fs.writeFileSync(path.join(skills, 'synthetic', 'SKILL.md'), 'SYNTHETIC_PRIVATE_CONTENT');
    const result = run('y\ny\nn\nn\n');
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'codex_skills.json:');
    assert.include(result.stdout, JSON.stringify(skills));
    assert.notInclude(result.stdout, 'SYNTHETIC_PRIVATE_CONTENT');
    assert.equal(readConfig().backup.sensitiveSourcesVersion, 2);
  });

  it('preserves an existing consent revision when final confirmation is cancelled', () => {
    const initial = configFor('repository', true);
    writeConfig({ ...initial, backup: { ...initial.backup, sensitiveSourcesVersion: 1 } });
    const before = fs.readFileSync(configPath, 'utf8');
    const result = run('y\nn\n');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  });

  it('reports prompt input failure without changing pending choices', () => {
    fs.appendFileSync(guardPath, `const readSync = fs.readSync; fs.readSync = (fd, ...args) => {
      if (fd === 0) throw new Error('fixture input failure');
      return readSync(fd, ...args);
    };\n`);
    const before = fs.readFileSync(configPath, 'utf8');
    const result = run();
    assert.equal(result.status, 1);
    assert.include(result.stderr, 'Unable to complete preference review');
    assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  });

  it('requires HOME only for opted-in sensitive review', () => {
    const result = run('y\n', ['setup'], { HOME: undefined });
    assert.equal(result.status, 1);
    assert.include(result.stdout, 'HOME is required');
  });

  ['sensitive', 'automatic'].forEach((choice) => {
    it(`stops on ${choice} preference persistence failure`, () => {
      if (choice === 'automatic') writeConfig(configFor('legacy-gist'));
      const result = run('y\ny\n', ['setup'], { BALLIN_TEST_FAIL_FINAL_CONFIG_COMMIT: '1' });
      assert.equal(result.status, 1);
      if (choice === 'automatic') assert.include(result.stdout, 'Unable to save the automatic-backup preference');
      assert.equal(readConfig().backup.includeSensitive, 'false');
      assert.equal(readConfig().update.backup, 'false');
    });
  });

  it('reports analytics persistence failure and preserves its choice', () => {
    writeConfig(configFor('unconfigured'));
    fs.appendFileSync(guardPath, `fs.renameSync = () => { throw new Error('fixture write failure'); };\n`);
    const result = run('y\n');
    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Unable to save the analytics preference');
    assert.equal(readConfig().analytics.enabled, 'false');
  });

  const invalids: [string, (config: ReturnType<typeof configFor>) => unknown][] = [
    ['JSON', () => '{'],
    ['root', () => []],
    ['section', (config) => ({ ...config, update: [] })],
    ['destination', (config) => ({ ...config, backup: { repository: { id: '1' } } })],
    ['sensitive', (config) => ({ ...config, backup: { ...config.backup, includeSensitive: 'invalid' } })],
    ['automatic', (config) => ({ ...config, update: { backup: 'invalid' } })],
    ['analytics', (config) => ({ ...config, analytics: { enabled: 'invalid' } })],
    ['missing analytics', (config) => ({ ...config, analytics: {} })],
  ];
  invalids.forEach(([name, invalid]) => {
    it(`rejects invalid ${name} before any prompt or repair`, () => {
      const value = invalid(configFor());
      if (name === 'JSON') fs.writeFileSync(configPath, value); else writeConfig(value);
      const before = fs.readFileSync(configPath, 'utf8');
      const result = run('y\ny\ny\ny\n');
      assert.equal(result.status, 1);
      const key = ({ sensitive: 'backup.includeSensitive', automatic: 'update.backup', analytics: 'analytics.enabled', 'missing analytics': 'analytics.enabled' } as Record<string, string>)[name];
      if (key) assert.equal(result.stderr, `ballin setup: Invalid \`${key}\`; expected true or false.\nRepair the local configuration before retrying. Use \`ballin config get\` to inspect it or \`ballin config reset\` to restore defaults.\n`);
      assert.include(result.stderr, 'Repair the local configuration');
      assert.notInclude(result.stdout, 'Review your Ballin');
      assert.equal(fs.readFileSync(configPath, 'utf8'), before);
    });
  });
  it('does not create missing config', () => {
    fs.rmSync(configPath);
    const result = run('y\n');
    assert.equal(result.status, 1);
    assert.equal(result.stderr, 'ballin setup: Local config is missing.\nRepair the local configuration before retrying. Use `ballin config get` to inspect it or `ballin config reset` to restore defaults.\n');
    assert.isFalse(fs.existsSync(configPath));
  });

  ['missing', 'malformed', 'enabled'].forEach((state) => {
    it(`provides offline setup help with ${state} config`, () => {
      if (state === 'missing') fs.rmSync(configPath);
      else if (state === 'malformed') fs.writeFileSync(configPath, '{');
      else writeConfig(configFor('repository', true));
      fs.appendFileSync(guardPath, `const originalRead = fs.readFileSync; fs.readFileSync = (file, ...args) => {
        if (file === ${JSON.stringify(configPath)}) throw new Error('Help must not read config');
        return originalRead(file, ...args);
      };\n`);
      const result = run('', ['setup', '--help'], {
        ...capture.env,
        NODE_OPTIONS: `${capture.env.NODE_OPTIONS} --require ${JSON.stringify(guardPath)}`,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.include(result.stdout, 'ballin setup --help');
      assert.notInclude(result.stdout, 'Review your Ballin');
      assert.deepEqual(capture.readEvents(), []);
    });
  });
  it('rejects unsupported setup arguments without running preference prompts', () => {
    const result = run('y\n', ['setup', 'extra']);
    assert.equal(result.status, 2);
    assert.include(result.stderr, 'Usage: ballin setup');
    assert.notInclude(result.stdout, 'Review your Ballin');
  });
  it('uses the existing identity owner when guided review enables analytics', () => {
    writeConfig(configFor('unconfigured'));
    fs.rmSync(capture.installIdPath);
    const result = run('y\n', ['setup'], {
      ...capture.env,
      NODE_OPTIONS: `${capture.env.NODE_OPTIONS} --require ${JSON.stringify(guardPath)}`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(capture.installIdPath, 'utf8').trim(), /^[0-9a-f-]{36}$/);
    assert.deepEqual(capture.readEvents().map((event: { command: string }) => event.command), ['ballin setup']);
  });

  it('uses only the existing top-level analytics event', () => {
    writeConfig(configFor('unconfigured', true));
    const result = run('\n', ['setup'], {
      ...capture.env,
      NODE_OPTIONS: `${capture.env.NODE_OPTIONS} --require ${JSON.stringify(guardPath)}`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(capture.readEvents().map((event: { command: string; schemaVersion: number }) => [event.command, event.schemaVersion]), [['ballin setup', 1]]);
  });
});
