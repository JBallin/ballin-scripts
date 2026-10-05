const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  requiredCommandShims,
} = require('../commands/setup_readiness.ts');
const {
  analyticsCommandForBallinArgs,
} = require('../commands/ballin.ts');
const {
  topLevelCommandNames,
} = require('../commands/top_level_commands.ts');

const ballinPath = path.join(__dirname, '..', 'bin', 'ballin');
type StringSpawnResult = import('child_process').SpawnSyncReturns<string>;

describe('ballin', () => {
  let tempDir: string;
  let binDir: string;
  let configPath: string;
  let commandLogPath: string;

  const assertHelpOutput = (result: StringSpawnResult) => {
    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Ballin');
    assert.include(result.stdout, 'Back up your dotfiles and update your macOS development environment.');
    assert.include(result.stdout, 'Usage:');
    assert.include(result.stdout, 'ballin <command> [options]');
    const commandSection = result.stdout.split('Commands:\n\n')[1].split('\n\n')[0];
    const commandLines = commandSection.split('\n');
    assert.lengthOf(commandLines, topLevelCommandNames.length);
    const documentedCommands = commandLines.map((line: string) => {
      const match = /^ {4}([a-z][a-z-]*) {2,}([a-z].*)$/u.exec(line);
      assert.isNotNull(match, line);
      return match![1];
    });
    assert.sameMembers(documentedCommands, [...topLevelCommandNames]);
    assert.include(result.stdout, 'back up Ballin-managed environment state');
    assert.include(result.stdout, 'view or change Ballin configuration');
    assert.include(result.stdout, 'Run `ballin <command> --help` for command-specific help.');
    for (const detail of ['Examples:', '--verbose', 'backup.includeSensitive', 'configured backup',
      '[repository-name]', 'file name', '(ex:', 'local checkout', 'command shims']) {
      assert.notInclude(result.stdout, detail);
    }
    assert.equal(result.stderr, '');
  };

  const writeExecutable = (name: string, contents = '#!/bin/bash\nexit 0\n') => {
    fs.writeFileSync(path.join(binDir, name), contents, { mode: 0o755 });
  };

  const commandLog = (): string[] => {
    if (!fs.existsSync(commandLogPath)) {
      return [];
    }
    return fs.readFileSync(commandLogPath, 'utf8').trimEnd().split('\n').filter(Boolean);
  };

  const writeConfig = (config: unknown) => {
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  };

  const writeUpdateConfig = (overrides: Record<string, string> = {}) => {
    writeConfig({
      update: {
        cleanup: 'false',
        nvm: 'false',
        npm: 'false',
        softwareupdate: 'false',
        selfUpdate: 'false',
        backup: 'false',
        ...overrides,
      },
      backup: {
        repository: null,
        includeSensitive: 'false',
      },
      analytics: {
        enabled: 'false',
      },
    });
  };

  const runBallin = (
    args: string[] = [],
    env: NodeJS.ProcessEnv = {},
  ): StringSpawnResult => spawnSync(process.execPath, [
    ballinPath,
    ...args,
  ], {
    encoding: 'utf8',
    env: testChildEnvironment({
      HOME: tempDir,
      BALLIN_TEST_CONFIG_PATH: configPath,
      BALLIN_TEST_BALLIN_PATH: path.join(binDir, 'ballin'),
      FAKE_COMMAND_LOG: commandLogPath,
      PATH: binDir,
      ...env,
    }),
  });

  const interactiveEnv = (nonTTY?: 'stdin' | 'stdout' | 'stderr', columns = 80): NodeJS.ProcessEnv => {
    const preload = path.join(tempDir, 'interactive.cjs');
    fs.writeFileSync(preload, `
      const fs = require('fs');
      const write = fs.writeSync;
      const writes = [];
      fs.writeSync = (...args) => { writes.push(args[1]); return write(...args); };
      for (const name of ['stdin', 'stdout', 'stderr']) Object.defineProperty(process[name], 'isTTY', { value: name !== ${JSON.stringify(nonTTY ?? '')} });
      Object.defineProperty(process.stderr, 'columns', { value: ${columns} });
      const readiness = require(${JSON.stringify(require.resolve('../commands/setup_readiness.ts'))});
      const collect = readiness.collectSetupReadiness;
      readiness.collectSetupReadiness = (options) => {
        if (${JSON.stringify(!nonTTY && columns > 'Checking readiness...'.length)} && !process.env.NO_COLOR && process.env.TERM !== 'dumb' && writes[0] !== 'Checking readiness...') throw Error('progress did not precede readiness');
        return collect(options);
      };
    `);
    return { NODE_OPTIONS: `--require=${preload}`, TERM: 'xterm', NO_COLOR: '' };
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-doctor-'));
    binDir = path.join(tempDir, 'bin');
    configPath = path.join(tempDir, 'ballin.config.json');
    commandLogPath = path.join(tempDir, 'commands.log');

    fs.mkdirSync(binDir, { recursive: true });
    requiredCommandShims.forEach((command: string) => writeExecutable(command));
    writeConfig({
      update: {},
      backup: {
        repository: null,
        includeSensitive: 'false',
      },
      analytics: {
        enabled: 'false',
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('remains executable through its shebang', () => {
    assertHelpOutput(spawnSync(ballinPath, [], {
      encoding: 'utf8',
      env: testChildEnvironment(),
    }));
  });

  it('remains executable through the installed symlink model', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-bin-'));
    const symlinkPath = path.join(tempDir, 'ballin');

    try {
      fs.symlinkSync(ballinPath, symlinkPath);
      assertHelpOutput(spawnSync(symlinkPath, [], {
        encoding: 'utf8',
        env: testChildEnvironment(),
      }));
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('shows help through conventional help spellings', () => {
    assertHelpOutput(runBallin(['--help']));
    assertHelpOutput(runBallin(['help']));
  });

  [[], ['--help'], ['help']].forEach((args) => {
    ['missing', 'malformed', 'unreadable', 'enabled'].forEach((config) => {
      [undefined, 'invalid-id\n', '11111111-1111-4111-8111-111111111111\n'].forEach((identity) => {
        it(`keeps ${JSON.stringify(args)} offline with ${config} config and ${identity === undefined ? 'missing' : identity.trim()} identity`, () => {
          const expectedOutput = runBallin(args).stdout;
          const analyticsPath = path.join(tempDir, '.analytics');
          const attemptPath = path.join(tempDir, 'forbidden-actions.jsonl');
          const preloadPath = path.join(tempDir, 'reject-help-effects.cjs');
          fs.writeFileSync(preloadPath, `const fs = require('fs');
const path = require('path');
const append = fs.appendFileSync.bind(fs);
const reject = (action) => {
  append(${JSON.stringify(attemptPath)}, JSON.stringify(action) + '\\n');
  const error = new Error('Forbidden help action: ' + action);
  error.code = 'EACCES';
  throw error;
};
for (const name of ['readFileSync', 'writeFileSync', 'appendFileSync', 'openSync',
  'accessSync', 'existsSync', 'statSync', 'lstatSync', 'mkdirSync', 'readdirSync',
  'renameSync', 'linkSync', 'unlinkSync', 'rmSync']) {
  const original = fs[name];
  fs[name] = (...values) => {
    const targets = name === 'renameSync' || name === 'linkSync' ? values.slice(0, 2) : values.slice(0, 1);
    for (const target of targets) {
      if (typeof target !== 'string' && !Buffer.isBuffer(target)) continue;
      const resolved = path.resolve(String(target));
      if (resolved === ${JSON.stringify(configPath)}
        || resolved === ${JSON.stringify(path.join(__dirname, '..', 'config', '.defaultConfig.json'))}
        || resolved === ${JSON.stringify(analyticsPath)}
        || resolved.startsWith(${JSON.stringify(analyticsPath + path.sep)})) reject('fs.' + name);
    }
    return original(...values);
  };
}
for (const module of ['http', 'https']) {
  for (const name of ['request', 'get']) require(module)[name] = () => reject(module + '.' + name);
}
for (const name of ['connect', 'createConnection']) require('net')[name] = () => reject('net.' + name);
globalThis.fetch = () => reject('fetch');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  require('child_process')[name] = () => reject('child_process.' + name);
}
const analytics = require(${JSON.stringify(path.join(__dirname, '..', 'commands', 'analytics.ts'))});
analytics.ensureAnalyticsInstallId = () => reject('identity repair');
analytics.runWithCommandAnalytics = () => reject('command analytics');
`);
          fs.rmSync(configPath, { force: true });
          const contents = config === 'malformed' ? '{invalid' : '{"analytics":{"enabled":"true"}}';
          if (config !== 'missing') fs.writeFileSync(configPath, contents);
          // The preload rejects attempted reads with EACCES, including this readable sentinel.
          fs.rmSync(analyticsPath, { recursive: true, force: true });
          if (identity !== undefined) {
            fs.mkdirSync(analyticsPath);
            fs.writeFileSync(path.join(analyticsPath, 'install-id'), identity);
            fs.writeFileSync(path.join(analyticsPath, 'state-sentinel'), 'unchanged\n');
          }
          const result = runBallin(args, {
            NODE_ENV: 'production',
            BALLIN_NO_ANALYTICS: undefined,
            BALLIN_NO_COMMAND_ANALYTICS: undefined,
            NODE_OPTIONS: `--require=${preloadPath}`,
          });
          assertHelpOutput(result);
          assert.equal(result.stdout, expectedOutput);
          assert.isFalse(fs.existsSync(attemptPath), `${config}: ${identity}`);
          assert.deepEqual(commandLog(), []);
          if (config === 'missing') assert.isFalse(fs.existsSync(configPath));
          else assert.equal(fs.readFileSync(configPath, 'utf8'), contents);
          if (identity === undefined) assert.isFalse(fs.existsSync(analyticsPath));
          else {
            assert.deepEqual(fs.readdirSync(analyticsPath).sort(), ['install-id', 'state-sentinel']);
            assert.equal(fs.readFileSync(path.join(analyticsPath, 'install-id'), 'utf8'), identity);
            assert.equal(fs.readFileSync(path.join(analyticsPath, 'state-sentinel'), 'utf8'), 'unchanged\n');
          }
        });
      });
    });
  });

  it('preserves overview output and analytics eligibility with extra help arguments', () => {
    const expectedOutput = runBallin(['help']).stdout;
    for (const args of [['help', 'extra'], ['--help', 'extra']]) {
      writeConfig({ analytics: { enabled: 'true' } });
      const installIdPath = path.join(tempDir, '.analytics', 'install-id');
      fs.rmSync(path.dirname(installIdPath), { recursive: true, force: true });
      const result = runBallin(args, {
        BALLIN_NO_ANALYTICS: '',
        BALLIN_NO_COMMAND_ANALYTICS: '1',
      });
      assertHelpOutput(result);
      assert.equal(result.stdout, expectedOutput);
      assert.match(fs.readFileSync(installIdPath, 'utf8').trim(), /^[0-9a-f-]{36}$/);
      assert.deepEqual(commandLog(), []);
    }
  });

  topLevelCommandNames.forEach((command: string) => {
    it(`prints offline ${command} --help without config or workflow effects`, () => {
      const preloadPath = path.join(tempDir, 'reject-network.cjs');
      const networkMarker = path.join(tempDir, 'network-request');
      fs.writeFileSync(preloadPath, `require('https').request = () => {
  require('fs').writeFileSync(${JSON.stringify(networkMarker)}, 'attempted');
  throw new Error('network request attempted');
};`);
      for (const contents of [undefined, '{invalid', '{"analytics":{"enabled":"true"}}']) {
        if (contents === undefined) fs.rmSync(configPath);
        else fs.writeFileSync(configPath, contents);
        const result = runBallin([command, '--help'], {
          NODE_ENV: 'production',
          BALLIN_NO_ANALYTICS: '',
          NODE_OPTIONS: `--require=${preloadPath}`,
        });
        assert.equal(result.status, 0);
        assert.equal(result.stderr, '');
        assert.include(result.stdout, `ballin ${command} --help`);
        assert.notInclude(result.stdout, 'ballin config help');
        if (command === 'doctor') assert.include(result.stdout, 'ballin doctor [--verbose]');
        if (command === 'self-update') assert.include(result.stdout, 'local `ballin-scripts` checkout, command shims, and configuration');
        if (command === 'uninstall') assert.include(result.stdout, 'Remove Ballin-owned command links and the local `ballin-scripts` checkout.');
        if (command === 'update') assert.include(result.stdout, 'Use `ballin config get update` to inspect settings.\n');
        if (command === 'setup') assert.include(result.stdout, 'Use `ballin config get/set/reset` for direct configuration.\n');
        if (command === 'backup') {
          assert.include(result.stdout, '`setup` creates or reconnects to an optional backup; `open` opens it in a browser.\n');
          assert.include(result.stdout, '`list` finds saved snapshots; `read` prints one supported snapshot.\n');
          assert.include(result.stdout, 'Without a snapshot selector, `read` shows usage and lists saved options when readable.\n');
          assert.include(result.stdout, '`disconnect` stops local backups and clears comparison state.\n');
          ['setup [repository-name]', 'open', 'list', 'read <snapshot>', 'read <snapshot> --list', 'read <snapshot> --file <path>', 'disconnect'].forEach((usage) => {
            assert.include(result.stdout, `ballin backup ${usage}`);
          });
          assert.include(result.stdout, 'Repository backups include only locally approved sensitive sources; review them with `ballin setup`.');
        }
        assert.deepEqual(commandLog(), []);
        assert.isFalse(fs.existsSync(networkMarker));
        assert.isFalse(fs.existsSync(path.join(tempDir, '.analytics', 'install-id')));
        if (contents === undefined) assert.isFalse(fs.existsSync(configPath));
        else assert.equal(fs.readFileSync(configPath, 'utf8'), contents);
      }
    });
  });

  ['doctor', 'self-update', 'uninstall'].forEach((command) => {
    it(`rejects malformed ${command} help without running its workflow`, () => {
      for (const args of [['--help', 'extra'], ['extra', '--help'], ['help']]) {
        const result = runBallin([command, ...args]);
        assert.equal(result.status, 2);
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `Usage: ballin ${command}${command === 'doctor' ? ' [--verbose]' : ''}\n`);
        assert.deepEqual(commandLog(), []);
      }
    });

    it(`keeps ${command} help free of config, identity, analytics, and workflow attempts`, () => {
      const attemptPath = path.join(tempDir, 'forbidden-help-actions');
      const preloadPath = path.join(tempDir, 'reject-help-effects.cjs');
      const analyticsPath = path.join(tempDir, '.analytics');
      const checkoutPath = path.join(tempDir, '.ballin-scripts');
      fs.mkdirSync(checkoutPath);
      fs.writeFileSync(path.join(checkoutPath, 'sentinel'), 'retained');
      fs.mkdirSync(analyticsPath);
      fs.writeFileSync(path.join(analyticsPath, 'install-id'), 'invalid-id\n');
      fs.writeFileSync(preloadPath, `const fs = require('fs');
const path = require('path');
const append = fs.appendFileSync.bind(fs);
const reject = (action) => {
  append(${JSON.stringify(attemptPath)}, action + '\\n');
  const error = new Error('Forbidden help action: ' + action);
  error.code = 'EACCES';
  throw error;
};
for (const name of ['readFileSync', 'writeFileSync', 'appendFileSync', 'openSync',
  'accessSync', 'existsSync', 'statSync', 'lstatSync', 'mkdirSync', 'readdirSync',
  'renameSync', 'linkSync', 'unlinkSync', 'rmSync']) {
  const original = fs[name];
  fs[name] = (...values) => {
    const targets = name === 'renameSync' || name === 'linkSync' ? values.slice(0, 2) : values.slice(0, 1);
    for (const target of targets) {
      if (typeof target !== 'string' && !Buffer.isBuffer(target)) continue;
      const resolved = path.resolve(String(target));
      if (resolved === ${JSON.stringify(configPath)}
        || resolved === ${JSON.stringify(path.join(__dirname, '..', 'config', '.defaultConfig.json'))}
        || resolved === ${JSON.stringify(analyticsPath)}
        || resolved.startsWith(${JSON.stringify(analyticsPath + path.sep)})
        || resolved === ${JSON.stringify(checkoutPath)}
        || resolved.startsWith(${JSON.stringify(checkoutPath + path.sep)})) reject('fs.' + name);
    }
    return original(...values);
  };
}
for (const module of ['http', 'https']) {
  for (const name of ['request', 'get']) require(module)[name] = () => reject(module + '.' + name);
}
for (const name of ['connect', 'createConnection']) require('net')[name] = () => reject('net.' + name);
globalThis.fetch = () => reject('fetch');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  require('child_process')[name] = () => reject('child_process.' + name);
}
const analytics = require(${JSON.stringify(path.join(__dirname, '..', 'commands', 'analytics.ts'))});
analytics.ensureAnalyticsInstallId = () => reject('identity repair');
analytics.runWithCommandAnalytics = () => reject('command analytics');
`);
      for (const contents of [undefined, '{invalid', '{"analytics":{"enabled":"true"}}']) {
        fs.rmSync(configPath, { force: true });
        if (contents !== undefined) fs.writeFileSync(configPath, contents);
        const result = runBallin([command, '--help'], {
          NODE_ENV: 'production',
          BALLIN_NO_ANALYTICS: undefined,
          BALLIN_NO_COMMAND_ANALYTICS: undefined,
          NODE_OPTIONS: `--require=${preloadPath}`,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.include(result.stdout, `ballin ${command} --help`);
        assert.equal(result.stderr, '');
        assert.isFalse(fs.existsSync(attemptPath));
        assert.deepEqual(commandLog(), []);
        assert.equal(fs.readFileSync(path.join(analyticsPath, 'install-id'), 'utf8'), 'invalid-id\n');
        assert.equal(fs.readFileSync(path.join(checkoutPath, 'sentinel'), 'utf8'), 'retained');
        if (contents === undefined) assert.isFalse(fs.existsSync(configPath));
        else assert.equal(fs.readFileSync(configPath, 'utf8'), contents);
      }
    });
  });

  it('keeps top-level help aligned with the command catalog', () => {
    const result = runBallin(['--help']);
    const commandSection = result.stdout.split('Commands:\n\n')[1].split('\n\n')[0];
    const documentedCommands = [...commandSection.matchAll(/^ {4}([a-z][a-z-]*) {2,}/gmu)]
      .map((match) => match[1]);

    assert.sameMembers(documentedCommands, [...topLevelCommandNames]);
  });

  it('uses canonical subcommand names for analytics', () => {
    assert.equal(analyticsCommandForBallinArgs([]), 'ballin');
    assert.equal(analyticsCommandForBallinArgs(['--help']), 'ballin');
    assert.equal(analyticsCommandForBallinArgs(['help']), 'ballin');
    topLevelCommandNames.forEach((command: string) => {
      assert.equal(analyticsCommandForBallinArgs([command]), `ballin ${command}`);
    });
    assert.equal(analyticsCommandForBallinArgs(['backup', 'read', 'zshrc.sh']), 'ballin backup');
    assert.equal(analyticsCommandForBallinArgs(['upd']), 'ballin');
  });

  it('rejects unknown commands without running a workflow', () => {
    const result = runBallin(['upd']);

    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Unknown Ballin command: upd\nTry: `ballin --help`\n');
  });

  it('routes update through the update workflow and preserves its exit status', () => {
    writeUpdateConfig({ backup: 'true' });
    writeExecutable('ballin', `#!/bin/bash
if [ "$*" != 'backup' ]; then exit 2; fi
printf '%s\\n' 'ballin backup from ballin update'
printf '%s\\n' 'ballin-backup-called' >> "$FAKE_COMMAND_LOG"
exit 17
`);

    const result = runBallin(['update']);

    assert.equal(result.status, 17);
    assert.include(result.stdout, 'Backing up development environment');
    assert.include(result.stdout, 'ballin backup from ballin update');
    assert.deepEqual(commandLog(), ['ballin-backup-called']);
  });

  it('routes backup through the backup command implementation', () => {
    const result = runBallin(['backup', 'help']);

    assertHelpOutput(result);
  });

  it('routes config through the existing config command implementation', () => {
    const result = runBallin(['config', 'get', 'backup.includeSensitive']);

    assert.equal(result.status, 0);
    assert.equal(result.stdout, 'false\n');
    assert.equal(result.stderr, '');
  });

  it('initializes analytics after local enablement without recording the choice', () => {
    const requestMarker = path.join(tempDir, 'analytics-requested');
    const preloadPath = path.join(tempDir, 'reject-analytics-request.cjs');
    fs.writeFileSync(preloadPath, `require('https').request = () => {
  require('fs').writeFileSync(${JSON.stringify(requestMarker)}, 'attempted');
  throw new Error('analytics request attempted');
};\n`);
    const env = {
      BALLIN_NO_ANALYTICS: '',
      NODE_OPTIONS: `--require=${preloadPath}`,
    };

    const enabled = runBallin(['config', 'set', 'analytics.enabled', 'true'], env);

    assert.equal(enabled.status, 0, enabled.stderr);
    assert.equal(enabled.stdout, '"analytics.enabled" set to: "true"\n');
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).analytics.enabled, 'true');
    const installIdPath = path.join(tempDir, '.analytics', 'install-id');
    assert.match(fs.readFileSync(installIdPath, 'utf8').trim(), /^[0-9a-f-]{36}$/);
    assert.isFalse(fs.existsSync(requestMarker));

    const disabled = runBallin(['config', 'set', 'analytics.enabled', 'false'], env);

    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).analytics.enabled, 'false');
    assert.isFalse(fs.existsSync(requestMarker));
  });

  it('keeps local analytics enablement non-blocking when ID creation fails', () => {
    const analyticsPath = path.join(tempDir, '.analytics');
    fs.writeFileSync(analyticsPath, 'blocks analytics directory creation\n');

    const result = runBallin(['config', 'set', 'analytics.enabled', 'true'], {
      BALLIN_NO_ANALYTICS: '',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '"analytics.enabled" set to: "true"\n');
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).analytics.enabled, 'true');
    assert.isFalse(fs.existsSync(path.join(tempDir, '.analytics', 'install-id')));

    fs.rmSync(analyticsPath);
    const repaired = runBallin(['config', 'get', 'analytics.enabled'], {
      BALLIN_NO_ANALYTICS: '',
      BALLIN_NO_COMMAND_ANALYTICS: '1',
    });

    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(repaired.stdout, 'true\n');
    assert.match(fs.readFileSync(path.join(analyticsPath, 'install-id'), 'utf8').trim(), /^[0-9a-f-]{36}$/);
  });

  it('repairs suppressed local analytics enablement on a later eligible command', () => {
    const requestMarker = path.join(tempDir, 'analytics-requested');
    const versionMarker = path.join(tempDir, 'analytics-version-read.json');
    const preloadPath = path.join(tempDir, 'record-analytics-request.cjs');
    fs.writeFileSync(preloadPath, `require('os').platform = () => 'darwin';
require('child_process').spawnSync = (command, args, options) => {
  require('fs').writeFileSync(${JSON.stringify(versionMarker)}, JSON.stringify({
    command, args, timeout: options.timeout,
  }));
  return { status: 0, stdout: '26.6.2\\n', stderr: '' };
};
require('https').request = () => {
  require('fs').writeFileSync(${JSON.stringify(requestMarker)}, 'attempted');
  throw new Error('analytics request recorded');
};\n`);
    const suppressed = runBallin(['config', 'set', 'analytics.enabled', 'true'], {
      BALLIN_NO_ANALYTICS: '1',
      NODE_OPTIONS: `--require=${preloadPath}`,
    });

    assert.equal(suppressed.status, 0, suppressed.stderr);
    assert.equal(suppressed.stdout, '"analytics.enabled" set to: "true"\n');
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).analytics.enabled, 'true');
    const installIdPath = path.join(tempDir, '.analytics', 'install-id');
    assert.isFalse(fs.existsSync(installIdPath));
    assert.isFalse(fs.existsSync(requestMarker));
    assert.isFalse(fs.existsSync(versionMarker));

    const resumed = runBallin(['config', 'get', 'analytics.enabled'], {
      BALLIN_NO_ANALYTICS: '',
      NODE_OPTIONS: `--require=${preloadPath}`,
    });

    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(resumed.stdout, 'true\n');
    assert.match(fs.readFileSync(installIdPath, 'utf8').trim(), /^[0-9a-f-]{36}$/);
    assert.isTrue(fs.existsSync(requestMarker));
    assert.deepEqual(JSON.parse(fs.readFileSync(versionMarker, 'utf8')), {
      command: '/usr/bin/sw_vers',
      args: ['-productVersion'],
      timeout: 750,
    });
  });

  it('repairs an invalid analytics identity on a later eligible command', () => {
    const installIdPath = path.join(tempDir, '.analytics', 'install-id');
    writeConfig({ analytics: { enabled: 'true' } });
    fs.mkdirSync(path.dirname(installIdPath));
    fs.writeFileSync(installIdPath, 'not-an-install-id\n');

    const result = runBallin(['config', 'get', 'analytics.enabled'], {
      BALLIN_NO_ANALYTICS: '',
      BALLIN_NO_COMMAND_ANALYTICS: '1',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'true\n');
    assert.match(fs.readFileSync(installIdPath, 'utf8').trim(), /^[0-9a-f-]{36}$/);
  });

  it('does not repair analytics identity while disabled, malformed, or hard-suppressed', () => {
    const installIdPath = path.join(tempDir, '.analytics', 'install-id');

    const disabled = runBallin(['help'], { BALLIN_NO_ANALYTICS: '' });

    assertHelpOutput(disabled);
    assert.isFalse(fs.existsSync(installIdPath));

    writeConfig({ analytics: false });
    const malformed = runBallin(['help'], { BALLIN_NO_ANALYTICS: '' });

    assertHelpOutput(malformed);
    assert.isFalse(fs.existsSync(installIdPath));

    writeConfig({ analytics: { enabled: 'true' } });
    const environmentSuppressed = runBallin(['help'], { BALLIN_NO_ANALYTICS: '1' });
    const ciSuppressed = runBallin(['help'], { BALLIN_NO_ANALYTICS: '', CI: 'true' });

    assertHelpOutput(environmentSuppressed);
    assertHelpOutput(ciSuppressed);
    assert.isFalse(fs.existsSync(installIdPath));
  });

  it('rejects extra arguments for no-argument command aliases', () => {
    const update = runBallin(['update', 'extra']);
    const selfUpdate = runBallin(['self-update', 'extra']);
    const uninstall = runBallin(['uninstall', 'extra']);

    assert.equal(update.status, 2);
    assert.equal(update.stderr, 'Usage: ballin update\n');
    assert.equal(selfUpdate.status, 2);
    assert.equal(selfUpdate.stderr, 'Usage: ballin self-update\n');
    assert.equal(uninstall.status, 2);
    assert.equal(uninstall.stderr, 'Usage: ballin uninstall\n');
  });

  for (const args of [['doctor'], ['doctor', '--verbose']]) {
    for (const healthy of [true, false]) {
      it(`clears interactive ${args.join(' ')} feedback before a ${healthy ? 'healthy' : 'failed'} report`, () => {
        if (!healthy) fs.rmSync(path.join(binDir, 'ballin'));
        const ordinary = runBallin(args);
        const interactive = runBallin(args, interactiveEnv());
        assert.equal(interactive.status, healthy ? 0 : 1);
        assert.equal(interactive.stdout, ordinary.stdout);
        assert.equal(interactive.stderr, 'Checking readiness...\r\x1b[2K');
      });
    }
  }
  for (const mode of ['stdin', 'stdout', 'stderr', 'dumb', 'NO_COLOR', 'narrow'] as const) {
    it(`keeps doctor output unchanged in ${mode} mode`, () => {
      const ordinary = runBallin(['doctor']);
      const env = interactiveEnv(['stdin', 'stdout', 'stderr'].includes(mode) ? mode as 'stdin' | 'stdout' | 'stderr' : undefined, mode === 'narrow' ? 10 : 80);
      if (mode === 'dumb') env.TERM = 'dumb';
      if (mode === 'NO_COLOR') env.NO_COLOR = '1';
      const result = runBallin(['doctor'], env);
      assert.equal(result.status, ordinary.status);
      assert.equal(result.stdout, ordinary.stdout);
      assert.equal(result.stderr, ordinary.stderr);
    });
  }
  it('shows no readiness feedback for help or invalid doctor usage', () => {
    for (const args of [['doctor', '--help'], ['doctor', 'extra']]) {
      const ordinary = runBallin(args);
      const result = runBallin(args, interactiveEnv());
      assert.equal(result.status, ordinary.status);
      assert.equal(result.stdout, ordinary.stdout);
      assert.equal(result.stderr, ordinary.stderr);
    }
  });

  it('reports a concise healthy doctor result by default', () => {
    const result = runBallin(['doctor']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '😎 You\'re ballin.\n');
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), []);
  });

  it('reports full Ballin-managed environment checks through verbose doctor', () => {
    const result = runBallin(['doctor', '--verbose']);

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'Ballin doctor');
    assert.include(result.stdout, 'OK    Node.js runtime:');
    assert.include(result.stdout, 'OK    Command shims on PATH:');
    assert.include(result.stdout, 'OK    Config readability:');
    assert.include(result.stdout, 'INFO  Optional backup:');
    assert.include(result.stdout, 'Result: Ballin-managed environment health looks good.');
    assert.notInclude(result.stdout, '😎 You\'re ballin.');
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), []);
  });

  it('reports doctor warnings without failing the command', () => {
    writeConfig({
      update: {},
      backup: {
        repository: null,
        includeSensitive: 'false',
      },
    });

    const result = runBallin(['doctor']);

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'WARN  Config readability: Config is readable but missing sections: `analytics`.');
    assert.include(result.stdout, '\nNext: Run `ballin config reset` to recreate the config.');
    assert.notInclude(result.stdout, '      Next:');
    assert.notInclude(result.stdout, 'OK    Node.js runtime:');
    assert.notInclude(result.stdout, 'OK    Command shims on PATH:');
    assert.notInclude(result.stdout, 'OK    Gist host:');
    assert.notInclude(result.stdout, 'Result: Ballin-managed environment has warnings. Warnings do not fail this command.');
    assert.equal(result.stderr, '');

    const verboseResult = runBallin(['doctor', '--verbose']);

    assert.equal(verboseResult.status, 0, verboseResult.stderr);
    assert.include(verboseResult.stdout, 'OK    Node.js runtime:');
    assert.include(verboseResult.stdout, 'WARN  Config readability: Config is readable but missing sections: `analytics`.');
    assert.include(verboseResult.stdout, 'INFO  Optional backup:');
    assert.include(verboseResult.stdout, 'Result: Ballin-managed environment has warnings. Warnings do not fail this command.');
  });

  it('reports configured private repository readiness through doctor without publication', () => {
    const { fixtureDestination, fixtureState, installRepositoryFixture } = require('./helpers/repository.ts');
    const statePath = path.join(tempDir, 'repository.json');
    fs.writeFileSync(statePath, JSON.stringify(fixtureState()));
    installRepositoryFixture(binDir, statePath);
    writeConfig({ update: {}, backup: { repository: fixtureDestination, includeSensitive: 'false' }, analytics: {} });
    const result = runBallin(['doctor', '--verbose']);
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'OK    Private backup readiness:');
    assert.include(result.stdout, 'Write permission and current source coverage were not checked.');
    const requests = JSON.parse(fs.readFileSync(statePath, 'utf8')).requests;
    assert.isAbove(requests.length, 0);
    assert.isFalse(requests.some((request: { method: string; payload?: { query?: string } }) => (
      request.method !== 'GET' && !request.payload?.query?.trim().startsWith('query')
    )));
  });

  it('rejects stale Gist and malformed destinations without contacting GitHub', () => {
    for (const backup of [
      { id: 'legacy-fixture', host: 'example.test' },
      { id: 42 },
      { id: ['unexpected-id'] },
      { id: { value: 'unexpected-id' } },
    ]) {
      writeConfig({ update: {}, backup, analytics: {} });
      const result = runBallin(['doctor', '--verbose']);
      assert.equal(result.status, 1, result.stderr);
      assert.include(result.stdout, 'ERROR Backup config:');
      assert.include(result.stdout, 'ballin backup disconnect');
      assert.include(result.stdout, 'ballin backup setup');
      assert.notInclude(result.stdout, 'legacy-fixture');
      assert.deepEqual(commandLog(), []);
    }
  });

  it('fails doctor when a required health check fails', () => {
    fs.rmSync(path.join(binDir, 'ballin'));
    writeConfig({
      update: {},
      backup: {
        id: null,
        host: 'example.test',
      },
      analytics: {
        enabled: 'false',
      },
    });

    const missingShim = runBallin(['doctor']);

    assert.equal(missingShim.status, 1);
    assert.include(missingShim.stdout, 'ERROR Command shims on PATH: Missing command shims on PATH: `ballin`.');
    assert.include(missingShim.stdout, '\nNext: Run the installer again or add the Ballin command directory to PATH.');
    assert.notInclude(missingShim.stdout, 'Gist ID:');
    assert.notInclude(missingShim.stdout, 'GitHub CLI:');
    assert.notInclude(missingShim.stdout, '      Next:');
    assert.notInclude(missingShim.stdout, 'OK    Node.js runtime:');
    assert.notInclude(missingShim.stdout, 'OK    Config readability:');
    assert.notInclude(missingShim.stdout, 'INFO');
    assert.notInclude(missingShim.stdout, 'Result: Ballin-managed environment has errors.');

    fs.rmSync(configPath);
    const missingConfig = runBallin(['doctor']);

    assert.equal(missingConfig.status, 1);
    assert.include(missingConfig.stdout, 'ERROR Config readability: Unable to read');
    assert.include(missingConfig.stdout, 'Next: Run `ballin config reset` to recreate the config.');
  });

  it('rejects invalid doctor usage', () => {
    const result = runBallin(['doctor', 'extra']);
    const verboseWithExtra = runBallin(['doctor', '--verbose', 'extra']);

    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Usage: ballin doctor [--verbose]\n');
    assert.equal(verboseWithExtra.status, 2);
    assert.equal(verboseWithExtra.stdout, '');
    assert.equal(verboseWithExtra.stderr, 'Usage: ballin doctor [--verbose]\n');
  });
});
