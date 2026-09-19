const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAnalyticsCapture } = require('./helpers/analytics.ts');
const { fixtureDestination, fixtureState, installRepositoryFixture } = require('./helpers/repository.ts');
import type { CapturedAnalyticsEvent } from './helpers/analytics.ts';
const {
  requiredCommandShims,
} = require('../commands/setup_readiness.ts');
const {
  resolveUpdateSettings,
} = require('../commands/update.ts');

const ballinPath = path.join(__dirname, '..', 'bin', 'ballin');
type InstallCommandStubOptions = {
  output?: string;
  status?: number;
  directory?: string;
};

describe('ballin update', () => {
  let tempDir: string;
  let binDir: string;
  let configPath: string;
  let logPath: string;

  const writeTestExecutable = (name: string, contents: string, directory = binDir) => {
    fs.writeFileSync(path.join(directory, name), contents, { mode: 0o755 });
  };

  const installCommandStub = (
    name: string,
    { output = '', status = 0, directory = binDir }: InstallCommandStubOptions = {},
  ) => {
    fs.writeFileSync(path.join(directory, name), `#!/usr/bin/env bash
printf '%s|%s|%s\\n' "${name}" "$HOMEBREW_NO_ENV_HINTS,$HOMEBREW_NO_ASK" "$*" >> "$UPDATE_TEST_LOG"
${output ? `printf '%s\\n' '${output}'` : ''}
exit ${status}
`, { mode: 0o755 });
  };

  const writeConfig = (config: unknown) => {
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  };

  const installHealthyReadinessCommands = () => {
    requiredCommandShims.forEach((command: string) => {
      if (!fs.existsSync(path.join(binDir, command))) {
        installCommandStub(command);
      }
    });
    installCommandStub('gh');
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-update-'));
    binDir = path.join(tempDir, 'bin');
    configPath = path.join(tempDir, 'ballin.config.json');
    logPath = path.join(tempDir, 'commands.log');
    fs.mkdirSync(binDir);
    fs.symlinkSync('/bin/bash', path.join(binDir, 'bash'));
    fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
    writeConfig({
      update: {
        cleanup: 'false',
        nvm: 'true',
        npm: 'false',
        softwareupdate: 'false',
        selfUpdate: 'false',
        backup: 'false',
      },
      backup: {
        id: 'test-gist-id',
        host: 'example.test',
      },
      analytics: {
        enabled: 'false',
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const writeUpdateConfig = (env: NodeJS.ProcessEnv = {}) => {
    writeConfig({
      update: {
        cleanup: env.TEST_UPDATE_CLEANUP ?? 'false',
        nvm: env.TEST_UPDATE_NVM ?? 'true',
        npm: env.TEST_UPDATE_NPM ?? 'false',
        softwareupdate: env.TEST_UPDATE_SOFTWAREUPDATE ?? 'false',
        selfUpdate: env.TEST_UPDATE_BALLIN ?? 'false',
        backup: env.TEST_UPDATE_BACKUP ?? 'false',
      },
      backup: {
        id: 'test-gist-id',
        host: 'example.test',
      },
      analytics: {
        enabled: 'false',
      },
    });
  };

  const spawnUpdate = (env: NodeJS.ProcessEnv = {}) => spawnSync(ballinPath, ['update'], {
      encoding: 'utf8',
      env: {
        HOME: tempDir,
        PATH: binDir,
        NVM_TEST_LOG: logPath,
        UPDATE_TEST_LOG: logPath,
        BALLIN_NO_ANALYTICS: '1',
        BALLIN_TEST_CONFIG_PATH: configPath,
        BALLIN_TEST_BALLIN_PATH: path.join(binDir, 'ballin'),
        ...env,
      },
    });

  const runUpdate = (env: NodeJS.ProcessEnv = {}) => {
    writeUpdateConfig(env);
    return spawnUpdate(env);
  };

  const runUpdateWithAnalytics = (env: NodeJS.ProcessEnv = {}) => {
    const capture = createAnalyticsCapture(tempDir);
    writeUpdateConfig({ TEST_UPDATE_NVM: 'false', ...env });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.analytics.enabled = 'true';
    writeConfig(config);
    const result = spawnUpdate({ ...capture.env, BALLIN_NO_ANALYTICS: '0', ...env });
    const events = capture.readEvents() as CapturedAnalyticsEvent[];
    return { result, events, outcomes: events.filter(({ schemaVersion }) => schemaVersion === 2) };
  };

  const installNvmStub = (nvmDir: string) => {
    fs.mkdirSync(nvmDir, { recursive: true });
    fs.writeFileSync(
      path.join(nvmDir, 'nvm.sh'),
      `nvm() {
  printf '%s\\n' "$*" >> "$NVM_TEST_LOG"
}
`,
    );
  };

  const installPathUpdatingNvmStub = (nvmDir: string, nvmBinDir: string) => {
    fs.mkdirSync(nvmDir, { recursive: true });
    fs.writeFileSync(
      path.join(nvmDir, 'nvm.sh'),
      `nvm() {
  printf '%s\\n' "$*" >> "$NVM_TEST_LOG"
  export PATH="${nvmBinDir}:$PATH"
}
`,
    );
  };

  const commandLog = () => (
    fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n') : []
  );

  it('remains executable through the installed symlink model', () => {
    const installBinDir = path.join(tempDir, 'installed-bin');
    const symlinkPath = path.join(installBinDir, 'ballin');
    fs.mkdirSync(installBinDir);
    fs.symlinkSync(ballinPath, symlinkPath);
    writeUpdateConfig({ TEST_UPDATE_NVM: 'false' });

    const result = spawnSync(symlinkPath, ['update'], {
      encoding: 'utf8',
      env: {
        HOME: tempDir,
        PATH: binDir,
        BALLIN_NO_ANALYTICS: '1',
        BALLIN_TEST_CONFIG_PATH: configPath,
        UPDATE_TEST_LOG: logPath,
      },
    });

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), []);
  });

  it('preserves the Homebrew environment and runs refresh, upgrade, cleanup, and doctor in order', () => {
    writeTestExecutable('brew', `#!/usr/bin/env bash
printf 'brew|%s|%s|%s|%s\n' "$HOMEBREW_NO_ENV_HINTS,$HOMEBREW_NO_ASK" "$HOMEBREW_NO_AUTO_UPDATE" "$UPDATE_CALLER_MARKER" "$*" >> "$UPDATE_TEST_LOG"
printf '%s\n' 'visible Homebrew output'
exit 0
`);

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_CLEANUP: 'true',
      HOMEBREW_NO_AUTO_UPDATE: '1',
      UPDATE_CALLER_MARKER: 'caller-value',
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'visible Homebrew output');
    [
      'Updating Homebrew',
      'Updating Homebrew packages',
      'Cleaning up Homebrew packages',
      'Checking Homebrew installation',
    ].reduce((previousIndex, stage) => {
      const stageIndex = result.stdout.indexOf(`==> ${stage}`);
      assert.isAbove(stageIndex, previousIndex);
      return stageIndex;
    }, -1);
    assert.deepEqual(commandLog(), [
      'brew|1,1|1|caller-value|update',
      'brew|1,1|1|caller-value|upgrade',
      'brew|1,1|1|caller-value|cleanup',
      'brew|1,1|1|caller-value|doctor',
    ]);
  });

  it('skips package upgrade after a failed Homebrew refresh and continues later stages', () => {
    writeTestExecutable('brew', `#!/usr/bin/env bash
printf 'brew|%s|%s\n' "$HOMEBREW_NO_ENV_HINTS,$HOMEBREW_NO_ASK" "$*" >> "$UPDATE_TEST_LOG"
if [ "$1" = 'update' ]; then
  printf '%s\n' 'simulated refresh failure'
  exit 42
fi
exit 0
`);
    installCommandStub('npm');

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_CLEANUP: 'true',
      TEST_UPDATE_NPM: 'true',
    });

    assert.equal(result.status, 42);
    assert.include(result.stdout, 'simulated refresh failure');
    assert.include(result.stdout, 'Updating Homebrew');
    assert.notInclude(result.stdout, 'Updating Homebrew packages');
    assert.include(result.stdout, 'Cleaning up Homebrew packages');
    assert.include(result.stdout, 'Checking Homebrew installation');
    assert.include(result.stdout, 'Updating global npm packages');
    assert.deepEqual(commandLog(), [
      'brew|1,1|update',
      'brew|1,1|cleanup',
      'brew|1,1|doctor',
      'npm|1,1|update -g',
    ]);
  });

  it('reports a Homebrew substep failure after running later integrations', () => {
    writeTestExecutable('brew', `#!/usr/bin/env bash
printf 'brew|%s|%s\\n' "$HOMEBREW_NO_ENV_HINTS,$HOMEBREW_NO_ASK" "$*" >> "$UPDATE_TEST_LOG"
if [ "$1" = 'cleanup' ]; then
  printf '%s\\n' 'simulated cleanup failure'
  exit 42
fi
exit 0
`);
    installCommandStub('ballin');
    installHealthyReadinessCommands();

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_CLEANUP: 'true',
      TEST_UPDATE_BALLIN: 'true',
    });

    assert.equal(result.status, 42);
    assert.include(result.stdout, 'simulated cleanup failure');
    assert.include(result.stdout, 'Checking Homebrew installation');
    assert.include(result.stdout, 'Updating ballin-scripts');
    assert.include(result.stdout, '😎 You\'re ballin.');
    assert.deepEqual(commandLog(), [
      'brew|1,1|update',
      'brew|1,1|upgrade',
      'brew|1,1|cleanup',
      'brew|1,1|doctor',
      'ballin|1,1|self-update',
      'gh|1,1|auth status --active --hostname example.test',
      'gh|1,1|gist view --files -- test-gist-id',
    ]);
  });

  it('passes exported Homebrew flags to later integrations', () => {
    installCommandStub('brew');
    installCommandStub('ballin');
    installHealthyReadinessCommands();

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_BALLIN: 'true',
    });

    assert.equal(result.status, 0);
    assert.deepEqual(commandLog(), [
      'brew|1,1|update',
      'brew|1,1|upgrade',
      'brew|1,1|doctor',
      'ballin|1,1|self-update',
      'gh|1,1|auth status --active --hostname example.test',
      'gh|1,1|gist view --files -- test-gist-id',
    ]);
  });

  it('skips cleanup when disabled while preserving upgrade and doctor output', () => {
    installCommandStub('brew', { output: 'brew command output' });

    const result = runUpdate({ TEST_UPDATE_NVM: 'false' });

    assert.equal(result.status, 0);
    assert.notInclude(result.stdout, 'Cleaning up Homebrew packages');
    assert.deepEqual(commandLog(), [
      'brew|1,1|update',
      'brew|1,1|upgrade',
      'brew|1,1|doctor',
    ]);
    assert.equal(result.stdout.match(/brew command output/g).length, 3);
  });

  it('runs enabled npm, macOS update, ballin update, and backup integrations', function test() {
    this.timeout(5000);
    ['npm', 'softwareupdate'].forEach((command) => {
      installCommandStub(command);
    });
    installCommandStub('ballin');
    installHealthyReadinessCommands();

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_NPM: 'true',
      TEST_UPDATE_SOFTWAREUPDATE: 'true',
      TEST_UPDATE_BALLIN: 'true',
      TEST_UPDATE_BACKUP: 'true',
    });

    assert.equal(result.status, 0);
    assert.deepEqual(commandLog(), [
      'npm|,|update -g',
      'softwareupdate|,|-ia',
      'ballin|,|self-update',
      'gh|,|auth status --active --hostname example.test',
      'gh|,|gist view --files -- test-gist-id',
      'ballin|,|backup',
    ]);
  });

  it('preserves top-level command analytics and the nested child environment alongside behavioral outcomes', function test() {
    this.timeout(5000);
    const analyticsPath = path.join(__dirname, '..', 'commands', 'analytics.ts');
    const selfUpdatePath = path.join(__dirname, '..', 'commands', 'self_update.ts');
    const updatePath = path.join(__dirname, '..', 'commands', 'update.ts');
    const analyticsLogPath = path.join(tempDir, 'analytics.log');
    const capture = createAnalyticsCapture(tempDir);
    const analyticsInstallIdPath = capture.installIdPath;
    const harnessPath = path.join(tempDir, 'run-update.ts');
    const installedCommandsDir = path.join(tempDir, '.ballin-scripts', 'commands');
    const nvmDir = path.join(tempDir, 'custom-nvm');
    const nvmBinDir = path.join(tempDir, 'nvm-bin');
    const nestedBallinPath = path.join(binDir, 'ballin');
    const installId = '826f9faa-9995-4f66-a01b-73b4f7aebdf1';

    fs.mkdirSync(installedCommandsDir, { recursive: true });
    fs.mkdirSync(nvmDir);
    fs.mkdirSync(nvmBinDir);
    fs.mkdirSync(path.dirname(analyticsInstallIdPath), { recursive: true });
    fs.writeFileSync(analyticsInstallIdPath, 'not-a-uuid\n');
    fs.writeFileSync(path.join(nvmDir, 'nvm.sh'), `nvm() {
  export PATH="${nvmBinDir}:$PATH"
  export BALLIN_NVM_TEST_MARKER='captured-after-nvm'
}
`);
    fs.symlinkSync(process.execPath, path.join(nvmBinDir, 'node'));
    fs.writeFileSync(path.join(nvmBinDir, 'npm'), `#!${process.execPath}
const fs = require('fs');
fs.appendFileSync(process.env.ANALYTICS_TEST_LOG, JSON.stringify({
  type: 'integration',
  command: 'npm',
  hardOptOut: process.env.BALLIN_NO_ANALYTICS ?? null,
  commandOptOut: process.env.BALLIN_NO_COMMAND_ANALYTICS ?? null,
  nvmMarker: process.env.BALLIN_NVM_TEST_MARKER ?? null,
}) + '\\n');
`, { mode: 0o755 });
    fs.writeFileSync(path.join(nvmBinDir, 'git'), `#!${process.execPath}
process.exit(0);
`, { mode: 0o755 });
    fs.writeFileSync(path.join(installedCommandsDir, 'install_setup.ts'), `const {
  ensureAnalyticsInstallId,
} = require(${JSON.stringify(analyticsPath)});

const installId = ensureAnalyticsInstallId({
  analyticsConfig: { enabled: 'true' },
  env: process.env,
  generateInstallId: () => ${JSON.stringify(installId)},
  installIdPath: process.env.ANALYTICS_TEST_INSTALL_ID_PATH,
});
if (!installId) {
  process.exitCode = 1;
}
`);
    fs.writeFileSync(nestedBallinPath, `#!${process.execPath}
const fs = require('fs');
const { runWithCommandAnalytics } = require(${JSON.stringify(analyticsPath)});
const { runSelfUpdateCommand } = require(${JSON.stringify(selfUpdatePath)});

const commandName = process.argv[2];
const command = 'ballin ' + commandName;
fs.appendFileSync(process.env.ANALYTICS_TEST_LOG, JSON.stringify({
  type: 'nested',
  command,
  hardOptOut: process.env.BALLIN_NO_ANALYTICS ?? null,
  commandOptOut: process.env.BALLIN_NO_COMMAND_ANALYTICS ?? null,
  nvmMarker: process.env.BALLIN_NVM_TEST_MARKER ?? null,
  path: process.env.PATH,
}) + '\\n');

(async () => {
  await runWithCommandAnalytics(
    command,
    commandName === 'self-update' ? runSelfUpdateCommand : () => {},
    {
    analyticsConfig: { enabled: 'true' },
    appVersion: '2.0.0',
    env: process.env,
    installIdPath: process.env.ANALYTICS_TEST_INSTALL_ID_PATH,
    nowMs: () => 0,
    sender: async (payload) => {
      fs.appendFileSync(process.env.ANALYTICS_TEST_LOG, JSON.stringify({
        type: 'event',
        command: payload.command,
        event: payload.event,
        status: payload.status,
        installId: payload.installId,
      }) + '\\n');
    },
  });
})().catch((error) => {
  process.stderr.write(String(error) + '\\n');
  process.exitCode = 1;
});
`, { mode: 0o755 });
    installCommandStub('gh');
    writeConfig({
      update: {
        cleanup: 'false',
        nvm: 'true',
        npm: 'true',
        softwareupdate: 'false',
        selfUpdate: 'true',
        backup: 'true',
      },
      backup: {
        id: 'test-gist-id',
        host: 'example.test',
      },
      analytics: {
        enabled: 'true',
      },
    });
    fs.writeFileSync(harnessPath, `const fs = require('fs');
const { runWithCommandAnalytics } = require(${JSON.stringify(analyticsPath)});
const { runUpdateCommand } = require(${JSON.stringify(updatePath)});

(async () => {
  await runWithCommandAnalytics('ballin update', runUpdateCommand, {
    analyticsConfig: { enabled: 'true' },
    appVersion: '2.0.0',
    env: process.env,
    installIdPath: process.env.ANALYTICS_TEST_INSTALL_ID_PATH,
    nowMs: () => 0,
    osVersionOptions: {
      platform: () => 'darwin',
      readCommandOutput: () => '26.6.2\\n',
    },
    sender: async (payload) => {
      fs.appendFileSync(process.env.ANALYTICS_TEST_LOG, JSON.stringify({
        type: 'event',
        command: payload.command,
        event: payload.event,
        status: payload.status,
        installId: payload.installId,
        osVersion: payload.osVersion,
      }) + '\\n');
    },
  });
})().catch((error) => {
  process.stderr.write(String(error) + '\\n');
  process.exitCode = 1;
});
`);

    const result = spawnSync(process.execPath, [harnessPath], {
      encoding: 'utf8',
      env: {
        ...capture.env,
        HOME: tempDir,
        PATH: binDir,
        NVM_DIR: nvmDir,
        ANALYTICS_TEST_LOG: analyticsLogPath,
        ANALYTICS_TEST_INSTALL_ID_PATH: analyticsInstallIdPath,
        BALLIN_NO_ANALYTICS: '0',
        BALLIN_TEST_BALLIN_PATH: nestedBallinPath,
        BALLIN_TEST_CONFIG_PATH: configPath,
        UPDATE_TEST_LOG: logPath,
      },
    });
    const analyticsLog = fs.readFileSync(analyticsLogPath, 'utf8')
      .trim()
      .split('\n')
      .map((line: string) => JSON.parse(line));
    const events = analyticsLog.filter(({ type }: { type: string }) => type === 'event');
    const nested = analyticsLog.filter(({ type }: { type: string }) => type === 'nested');
    const integrations = analyticsLog.filter(({ type }: { type: string }) => type === 'integration');

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(capture.readEvents(), [], 'the injected sender must receive both payload schemas');
    assert.equal(fs.readFileSync(analyticsInstallIdPath, 'utf8'), `${installId}\n`);
    assert.deepEqual(events.filter((event: { command?: string }) => event.command), [{
      type: 'event',
      command: 'ballin update',
      status: 'success',
      installId,
      osVersion: '26.6',
    }]);
    assert.deepEqual(events.filter((event: { event?: string }) => event.event), [
      { type: 'event', event: 'update.self-update', status: 'success', installId },
      { type: 'event', event: 'update.backup', status: 'success', installId },
    ]);
    assert.deepEqual(nested.map(({ command, hardOptOut, commandOptOut, nvmMarker, path: childPath }: {
      command: string;
      hardOptOut: string;
      commandOptOut: string;
      nvmMarker: string;
      path: string;
    }) => ({ command, hardOptOut, commandOptOut, nvmMarker, path: childPath })), [
      {
        command: 'ballin self-update',
        hardOptOut: '0',
        commandOptOut: '1',
        nvmMarker: 'captured-after-nvm',
        path: `${nvmBinDir}:${binDir}`,
      },
      {
        command: 'ballin backup',
        hardOptOut: '0',
        commandOptOut: '1',
        nvmMarker: 'captured-after-nvm',
        path: `${nvmBinDir}:${binDir}`,
      },
    ]);
    assert.deepEqual(integrations, [{
      type: 'integration',
      command: 'npm',
      hardOptOut: '0',
      commandOptOut: null,
      nvmMarker: 'captured-after-nvm',
    }]);
  });

  it('records the real automatic backup and parent outcome without a nested command event', () => {
    const capture = createAnalyticsCapture(tempDir);
    const checkout = path.join(tempDir, '.ballin-scripts');
    fs.mkdirSync(checkout);
    fs.symlinkSync('/bin/cat', path.join(binDir, 'cat'));
    fs.writeFileSync(path.join(tempDir, '.zshrc'), 'fixture shell settings\n');
    const statePath = path.join(tempDir, 'repository.json');
    fs.writeFileSync(statePath, JSON.stringify(fixtureState()));
    installRepositoryFixture(binDir, statePath);
    writeUpdateConfig({ TEST_UPDATE_NVM: 'false', TEST_UPDATE_BACKUP: 'true' });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.analytics.enabled = 'true';
    config.backup = { repository: fixtureDestination, id: null, host: 'github.com', includeSensitive: 'true' };
    writeConfig(config);

    const result = spawnUpdate({
      ...capture.env, BALLIN_NO_ANALYTICS: '0', BALLIN_TEST_BALLIN_PATH: ballinPath,
      BALLIN_TEST_REPO_DIR: checkout,
    });
    assert.equal(result.status, 0, result.stderr);
    const events = capture.readEvents() as CapturedAnalyticsEvent[];
    assert.deepEqual(events.filter(({ schemaVersion }) => schemaVersion === 1).map(({ command, status }) => ({ command, status })), [
      { command: 'ballin update', status: 'success' },
    ]);
    assert.deepEqual(events.filter(({ schemaVersion }) => schemaVersion === 2).map(({ event, status }) => ({ event, status })), [
      { event: 'backup.run', status: 'success' },
      { event: 'update.backup', status: 'success' },
    ]);
    const remoteState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.isString(remoteState.commits[remoteState.head].files['zshrc.sh']);
  });

  for (const stage of [
    { event: 'update.self-update', setting: 'TEST_UPDATE_BALLIN' },
    { event: 'update.backup', setting: 'TEST_UPDATE_BACKUP' },
  ]) {
    for (const mode of ['success', 'nonzero', 'launch', 'signal']) {
      it(`records ${stage.event} from its ${mode} child result`, () => {
        installHealthyReadinessCommands();
        installCommandStub('ballin', { status: mode === 'nonzero' ? 23 : 0, output: 'fixture stage result' });
        if (mode === 'signal') writeTestExecutable('ballin', '#!/usr/bin/env bash\nkill -TERM "$$"\n');
        const { result, outcomes } = runUpdateWithAnalytics({
          [stage.setting]: 'true',
          ...(mode === 'launch' ? { BALLIN_TEST_BALLIN_PATH: path.join(binDir, 'missing-ballin') } : {}),
        });
        assert.equal(result.status, { success: 0, nonzero: 23, launch: 127, signal: 143 }[mode], result.stderr);
        assert.deepEqual(outcomes.map(({ event, status }) => ({ event, status })), [
          { event: stage.event, status: mode === 'success' ? 'success' : 'failure' },
        ]);
      });
    }
  }

  it('keeps successful stage outcomes separate from earlier integration and later readiness failures', () => {
    installHealthyReadinessCommands();
    installCommandStub('npm', { status: 23 });
    installCommandStub('ballin');
    const child = path.join(tempDir, 'stage-child');
    fs.copyFileSync(path.join(binDir, 'ballin'), child);
    fs.rmSync(path.join(binDir, 'ballin'));
    const { result, events, outcomes } = runUpdateWithAnalytics({
      TEST_UPDATE_NPM: 'true', TEST_UPDATE_BALLIN: 'true', TEST_UPDATE_BACKUP: 'true',
      BALLIN_TEST_BALLIN_PATH: child,
    });
    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Missing command shims on PATH: ballin');
    assert.deepEqual(outcomes.map(({ event, status }) => ({ event, status })), [
      { event: 'update.self-update', status: 'success' },
      { event: 'update.backup', status: 'success' },
    ]);
    assert.deepEqual(events.filter(({ schemaVersion }) => schemaVersion === 1).map(({ command, status }) => ({ command, status })), [
      { command: 'ballin update', status: 'failure' },
    ]);
    assert.include(commandLog().join('\n'), 'ballin|,|backup');
  });

  it('emits no behavioral outcomes for disabled or unreached update stages', () => {
    installCommandStub('ballin');
    const { outcomes } = runUpdateWithAnalytics();
    assert.deepEqual(outcomes, []);
    const capture = createAnalyticsCapture(tempDir);
    capture.clear();
    writeConfig({ update: { selfUpdate: 'invalid' }, analytics: { enabled: 'true' } });
    const result = spawnUpdate({ ...capture.env, BALLIN_NO_ANALYTICS: '0' });
    assert.equal(result.status, 1);
    assert.deepEqual(capture.readEvents().filter(({ schemaVersion }: CapturedAnalyticsEvent) => schemaVersion === 2), []);
    assert.deepEqual(commandLog(), []);
  });

  for (const recorderThrows of [false, true]) {
    it(`preserves an original stage exception when terminal recording ${recorderThrows ? 'throws' : 'succeeds'}`, () => {
      const capture = createAnalyticsCapture(tempDir);
      const preload = path.join(tempDir, 'stage-exception.cjs');
      fs.writeFileSync(preload, `
const helpers = require(${JSON.stringify(path.join(__dirname, '..', 'commands', 'commandHelpers.ts'))});
helpers.runVisibleCommand = () => { throw new Error('fixture original stage exception'); };
${recorderThrows ? `require(${JSON.stringify(path.join(__dirname, '..', 'commands', 'analytics.ts'))}).recordBehavioralAnalyticsEvent = () => { throw new Error('fixture recorder exception'); };` : ''}
`);
      const { result, outcomes } = runUpdateWithAnalytics({
        TEST_UPDATE_BALLIN: 'true', TEST_UPDATE_BACKUP: 'true',
        NODE_OPTIONS: `${capture.env.NODE_OPTIONS} --require ${JSON.stringify(preload)}`,
      });
      assert.equal(result.status, 1);
      assert.include(result.stderr, 'fixture original stage exception');
      assert.notInclude(result.stderr, 'fixture recorder exception');
      assert.notInclude(result.stdout, 'Backing up development environment');
      assert.deepEqual(outcomes.map(({ event, status }) => ({ event, status })), recorderThrows ? [] : [
        { event: 'update.self-update', status: 'failure' },
      ]);
    });
  }

  it('continues later stages when the terminal recorder throws synchronously', () => {
    installHealthyReadinessCommands();
    installCommandStub('ballin');
    const capture = createAnalyticsCapture(tempDir);
    const preload = path.join(tempDir, 'recorder-exception.cjs');
    fs.writeFileSync(preload, `require(${JSON.stringify(path.join(__dirname, '..', 'commands', 'analytics.ts'))}).recordBehavioralAnalyticsEvent = () => { throw new Error('fixture recorder exception'); };`);
    const { result, outcomes } = runUpdateWithAnalytics({
      TEST_UPDATE_BALLIN: 'true', TEST_UPDATE_BACKUP: 'true',
      NODE_OPTIONS: `${capture.env.NODE_OPTIONS} --require ${JSON.stringify(preload)}`,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(outcomes, []);
    assert.equal(commandLog().at(-1), 'ballin|,|backup');
  });

  for (const mode of ['throw', 'error', 'hang']) {
    it(`preserves later stages, output and exit status when the analytics sender ${mode}s`, function test() {
      this.timeout(5000);
      installHealthyReadinessCommands();
      installCommandStub('ballin', { output: 'fixture stage output' });
      const settings = { TEST_UPDATE_NVM: 'false', TEST_UPDATE_BALLIN: 'true', TEST_UPDATE_BACKUP: 'true' };
      const expected = runUpdate(settings);
      fs.rmSync(logPath);
      const { result } = runUpdateWithAnalytics({ ...settings, BALLIN_TEST_ANALYTICS_MODE: mode });
      assert.equal(result.status, expected.status);
      assert.equal(result.stdout, expected.stdout);
      assert.equal(result.stderr, expected.stderr);
      assert.equal(commandLog().at(-1), 'ballin|,|backup');
    });
  }

  it('updates App Store apps when mas is available without requiring a setting', () => {
    installCommandStub('mas');

    const result = runUpdate({ TEST_UPDATE_NVM: 'false' });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Updating App Store apps');
    assert.deepEqual(commandLog(), ['mas|,|upgrade']);
  });

  it('checks Ballin readiness after a successful ballin update', () => {
    installCommandStub('ballin', { output: 'updated ballin-scripts' });
    installHealthyReadinessCommands();

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_BALLIN: 'true',
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Updating ballin-scripts');
    assert.include(result.stdout, 'updated ballin-scripts');
    assert.include(result.stdout, 'Checking Ballin readiness');
    assert.include(result.stdout, '😎 You\'re ballin.');
    assert.deepEqual(commandLog(), [
      'ballin|,|self-update',
      'gh|,|auth status --active --hostname example.test',
      'gh|,|gist view --files -- test-gist-id',
    ]);
  });

  it('keeps maintenance-only Ballin healthy after self-update without using gh', () => {
    installCommandStub('ballin', { output: 'updated maintenance-only Ballin' });
    requiredCommandShims.forEach((command: string) => {
      if (!fs.existsSync(path.join(binDir, command))) {
        installCommandStub(command);
      }
    });
    writeConfig({
      update: {
        cleanup: 'false',
        nvm: 'false',
        npm: 'false',
        softwareupdate: 'false',
        selfUpdate: 'true',
        backup: 'false',
      },
      backup: {
        id: null,
        host: 'example.test',
      },
      analytics: { enabled: 'false' },
    });

    const result = spawnUpdate();

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, 'updated maintenance-only Ballin');
    assert.include(result.stdout, '😎 You\'re ballin.');
    assert.deepEqual(commandLog(), ['ballin|,|self-update']);
  });

  it('fails an explicitly enabled backup stage with setup guidance when unconfigured', () => {
    fs.symlinkSync(ballinPath, path.join(binDir, 'ballin'));
    writeConfig({
      update: {
        cleanup: 'false',
        nvm: 'false',
        npm: 'false',
        softwareupdate: 'false',
        selfUpdate: 'false',
        backup: 'true',
      },
      backup: {
        id: null,
        host: 'example.test',
      },
      analytics: { enabled: 'false' },
    });

    const result = spawnUpdate();

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Backing up development environment');
    assert.include(result.stderr, "run 'ballin backup setup' to enable it");
    assert.deepEqual(commandLog(), []);
  });

  it('uses raw destination types when an enabled backup stage validates config', () => {
    fs.symlinkSync(ballinPath, path.join(binDir, 'ballin'));
    const update = {
      cleanup: 'false',
      nvm: 'false',
      npm: 'false',
      softwareupdate: 'false',
      selfUpdate: 'false',
      backup: 'true',
    };

    [42, ['unexpected-id'], { value: 'unexpected-id' }].forEach((id) => {
      writeConfig({
        update,
        backup: { id, host: 'example.test' },
        analytics: { enabled: 'false' },
      });

      const result = spawnUpdate();

      assert.equal(result.status, 1);
      assert.include(result.stderr, 'invalid config value backup.id; expected null or a non-empty string');
      assert.include(result.stderr, 'run ballin config reset to restore valid defaults');
    });

    writeConfig({
      update,
      backup: { id: 'test-gist-id', host: { value: 'unexpected-host' } },
      analytics: { enabled: 'false' },
    });

    const malformedHost = spawnUpdate();

    assert.equal(malformedHost.status, 1);
    assert.include(malformedHost.stderr, 'run ballin backup setup to repair it');
    assert.deepEqual(commandLog(), []);
  });

  it('checks Ballin readiness with the Node.js runtime from the updated nvm PATH', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    const nvmBinDir = path.join(tempDir, 'nvm-bin');
    fs.mkdirSync(nvmBinDir);
    installPathUpdatingNvmStub(nvmDir, nvmBinDir);
    writeTestExecutable('node', `#!/usr/bin/env bash
printf 'node|%s|%s\\n' "$HOMEBREW_NO_ENV_HINTS,$HOMEBREW_NO_ASK" "$*" >> "$UPDATE_TEST_LOG"
if [ "$*" = '-p process.versions.node' ]; then
  printf '%s\\n' '99.0.0'
  exit 0
fi
if [ "$1" = '-e' ]; then
  ${JSON.stringify(process.execPath)} -e "$2"
  exit "$?"
fi
exit 2
`, nvmBinDir);
    installHealthyReadinessCommands();

    const result = runUpdate({
      NVM_DIR: nvmDir,
      TEST_UPDATE_BALLIN: 'true',
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Checking Ballin readiness');
    assert.include(result.stdout, '😎 You\'re ballin.');
    assert.deepEqual(commandLog().slice(1), [
      'node|,|-e process.stdout.write(JSON.stringify(process.env))',
      'ballin|,|self-update',
      'node|,|-p process.versions.node',
      'gh|,|auth status --active --hostname example.test',
      'gh|,|gist view --files -- test-gist-id',
    ]);
  });

  it('records Ballin readiness failures and still runs configured backup', () => {
    const selfUpdatePath = path.join(tempDir, 'self-update-ballin');
    fs.writeFileSync(selfUpdatePath, `#!/usr/bin/env bash
printf '%s|%s|%s\\n' "ballin" "$HOMEBREW_NO_ENV_HINTS,$HOMEBREW_NO_ASK" "$*" >> "$UPDATE_TEST_LOG"
exit 0
`, { mode: 0o755 });
    installHealthyReadinessCommands();
    fs.rmSync(path.join(binDir, 'ballin'));

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_BALLIN: 'true',
      TEST_UPDATE_BACKUP: 'true',
      BALLIN_TEST_BALLIN_PATH: selfUpdatePath,
    });

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Checking Ballin readiness');
    assert.include(result.stdout, 'ERROR Command shims on PATH: Missing command shims on PATH: ballin.');
    assert.include(result.stdout, 'Next: Run the installer again or add the Ballin command directory to PATH.');
    assert.notInclude(result.stdout, '😎 You\'re ballin.');
    assert.deepEqual(commandLog(), [
      'ballin|,|self-update',
      'gh|,|auth status --active --hostname example.test',
      'gh|,|gist view --files -- test-gist-id',
      'ballin|,|backup',
    ]);
  });

  it('skips Ballin readiness when ballin update fails', () => {
    installCommandStub('ballin', { output: 'simulated update failure', status: 23 });
    installHealthyReadinessCommands();

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_BALLIN: 'true',
    });

    assert.equal(result.status, 23);
    assert.include(result.stdout, 'simulated update failure');
    assert.notInclude(result.stdout, 'Checking Ballin readiness');
    assert.notInclude(result.stdout, '😎 You\'re ballin.');
    assert.deepEqual(commandLog(), [
      'ballin|,|self-update',
    ]);
  });

  it('does not run disabled optional integrations even when commands exist', () => {
    ['npm', 'softwareupdate', 'ballin'].forEach((command) => {
      installCommandStub(command);
    });

    const result = runUpdate({ TEST_UPDATE_NVM: 'false' });

    assert.equal(result.status, 0);
    assert.deepEqual(commandLog(), []);
    assert.notInclude(result.stdout, 'Updating global npm packages');
    assert.notInclude(result.stdout, 'Installing macOS updates');
    assert.notInclude(result.stdout, 'Updating ballin-scripts');
    assert.notInclude(result.stdout, 'Backing up development environment');
  });

  it('keeps later integrations isolated when an optional command fails', () => {
    installCommandStub('npm', { output: 'simulated npm failure', status: 23 });
    installCommandStub('ballin');
    installCommandStub('ballin');
    installHealthyReadinessCommands();

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_NPM: 'true',
      TEST_UPDATE_BALLIN: 'true',
      TEST_UPDATE_BACKUP: 'true',
    });

    assert.equal(result.status, 23);
    assert.include(result.stdout, 'simulated npm failure');
    assert.deepEqual(commandLog(), [
      'npm|,|update -g',
      'ballin|,|self-update',
      'gh|,|auth status --active --hostname example.test',
      'gh|,|gist view --files -- test-gist-id',
      'ballin|,|backup',
    ]);
  });

  it('still uses final backup status after Ballin readiness', () => {
    writeTestExecutable('ballin', `#!/usr/bin/env bash
printf '%s|%s|%s\\n' "ballin" "$HOMEBREW_NO_ENV_HINTS,$HOMEBREW_NO_ASK" "$*" >> "$UPDATE_TEST_LOG"
if [ "$1" = 'backup' ]; then
  printf '%s\\n' 'simulated backup failure'
  exit 17
fi
exit 0
`);
    installHealthyReadinessCommands();

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_BALLIN: 'true',
      TEST_UPDATE_BACKUP: 'true',
    });

    assert.equal(result.status, 17);
    assert.include(result.stdout, '😎 You\'re ballin.');
    assert.include(result.stdout, 'simulated backup failure');
    assert.deepEqual(commandLog(), [
      'ballin|,|self-update',
      'gh|,|auth status --active --hostname example.test',
      'gh|,|gist view --files -- test-gist-id',
      'ballin|,|backup',
    ]);
  });

  it('uses backup as the final exit status when backup is enabled', () => {
    installCommandStub('ballin', { output: 'simulated backup failure', status: 17 });

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_BACKUP: 'true',
    });

    assert.equal(result.status, 17);
    assert.include(result.stdout, 'simulated backup failure');
    assert.deepEqual(commandLog(), [
      'ballin|,|backup',
    ]);
  });

  it('uses a shell-style signal exit status for final backup', () => {
    writeTestExecutable('ballin', `#!/usr/bin/env bash
kill -TERM "$$"
`);

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_BACKUP: 'true',
    });

    assert.equal(result.status, 143);
    assert.include(result.stdout, 'Backing up development environment');
  });

  it('loads nvm from NVM_DIR and updates Node.js LTS', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    installNvmStub(nvmDir);

    const result = runUpdate({ NVM_DIR: nvmDir });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Updating Node.js LTS');
    assert.equal(fs.readFileSync(logPath, 'utf8'), 'install --lts\n');
  });

  it('reports unexpected bash spawn failures and continues to backup', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    installNvmStub(nvmDir);
    fs.rmSync(path.join(binDir, 'bash'));
    fs.symlinkSync('bash', path.join(binDir, 'bash'));
    writeTestExecutable('ballin', '#!/bin/sh\nexit 0\n');

    const result = runUpdate({
      NVM_DIR: nvmDir,
      TEST_UPDATE_BACKUP: 'true',
    });

    assert.equal(result.status, 1);
    assert.include(result.stderr, 'ELOOP');
    assert.include(result.stdout, 'Backing up development environment');
  });

  it('falls back to the running Node version when updated-node lookup fails', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    const nvmBinDir = path.join(tempDir, 'nvm-bin');
    fs.mkdirSync(nvmBinDir);
    installPathUpdatingNvmStub(nvmDir, nvmBinDir);
    writeTestExecutable('node', `#!/bin/sh
printf 'node|,|%s\n' "$*" >> "$UPDATE_TEST_LOG"
if [ "$1" = '-e' ]; then exec ${JSON.stringify(process.execPath)} "$@"; fi
if [ "$1" = '-p' ]; then exit 31; fi
exit 2
`, nvmBinDir);
    installCommandStub('ballin');
    installHealthyReadinessCommands();

    const result = runUpdate({
      NVM_DIR: nvmDir,
      TEST_UPDATE_BALLIN: 'true',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "😎 You're ballin.");
    assert.include(commandLog(), 'node|,|-p process.versions.node');
  });

  it('reports nvm install failures after running later integrations', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    fs.mkdirSync(nvmDir, { recursive: true });
    fs.writeFileSync(
      path.join(nvmDir, 'nvm.sh'),
      `nvm() {
  printf '%s\\n' "$*" >> "$NVM_TEST_LOG"
  return 24
}
`,
    );
    writeTestExecutable('ballin', `#!/usr/bin/env bash
printf '%s\\n' 'backup still ran' >> "$UPDATE_TEST_LOG"
`);

    const result = runUpdate({
      NVM_DIR: nvmDir,
      TEST_UPDATE_BACKUP: 'true',
    });

    assert.equal(result.status, 24);
    assert.include(result.stdout, 'Updating Node.js LTS');
    assert.deepEqual(commandLog().slice(1), [
      'backup still ran',
    ]);
  });

  it('keeps nvm PATH changes for the npm update', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    const nvmBinDir = path.join(tempDir, 'nvm-bin');
    fs.mkdirSync(nvmBinDir);
    installPathUpdatingNvmStub(nvmDir, nvmBinDir);
    installCommandStub('npm', { directory: nvmBinDir });

    const result = runUpdate({
      NVM_DIR: nvmDir,
      TEST_UPDATE_NPM: 'true',
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Updating Node.js LTS');
    assert.include(result.stdout, 'Updating global npm packages');
    assert.equal(fs.readFileSync(logPath, 'utf8').split('\n')[0], 'install --lts');
    assert.deepEqual(commandLog().slice(1), [
      'npm|,|update -g',
    ]);
  });

  it('keeps nvm PATH changes for later backups', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    const nvmBinDir = path.join(tempDir, 'nvm-bin');
    const nvmNpmPath = path.join(nvmBinDir, 'npm');
    fs.mkdirSync(nvmBinDir);
    installPathUpdatingNvmStub(nvmDir, nvmBinDir);
    installCommandStub('npm', { directory: nvmBinDir });
    writeTestExecutable('ballin', `#!/usr/bin/env bash
if [ "$*" != 'backup' ]; then exit 2; fi
printf 'backup-npm|%s\\n' "$(command -v npm)" >> "$UPDATE_TEST_LOG"
`);

    const result = runUpdate({
      NVM_DIR: nvmDir,
      TEST_UPDATE_BACKUP: 'true',
    });

    assert.equal(result.status, 0);
    assert.include(result.stdout, 'Updating Node.js LTS');
    assert.deepEqual(commandLog().slice(1), [
      `backup-npm|${nvmNpmPath}`,
    ]);
  });

  it('records a failure and keeps running later integrations when nvm env capture fails', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    const brokenNodeDir = path.join(tempDir, 'broken-node');
    fs.mkdirSync(brokenNodeDir);
    installPathUpdatingNvmStub(nvmDir, brokenNodeDir);
    fs.writeFileSync(path.join(brokenNodeDir, 'node'), `#!/usr/bin/env bash
exit 42
`, { mode: 0o755 });
    writeTestExecutable('ballin', `#!/usr/bin/env bash
printf '%s\\n' 'backup still ran' >> "$UPDATE_TEST_LOG"
`);

    const result = runUpdate({
      NVM_DIR: nvmDir,
      TEST_UPDATE_BACKUP: 'true',
    });

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Updating Node.js LTS');
    assert.include(result.stderr, 'Unable to capture the updated Node.js environment');
    assert.deepEqual(commandLog().slice(1), [
      'backup still ran',
    ]);
  });

  it('rejects malformed updated Node environment data and keeps running later integrations', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    const malformedNodeDir = path.join(tempDir, 'malformed-node');
    fs.mkdirSync(malformedNodeDir);
    installPathUpdatingNvmStub(nvmDir, malformedNodeDir);
    fs.writeFileSync(path.join(malformedNodeDir, 'node'), `#!/usr/bin/env bash
printf '%s\\n' 'not-json'
`, { mode: 0o755 });
    writeTestExecutable('ballin', `#!/usr/bin/env bash
printf '%s\\n' 'backup still ran' >> "$UPDATE_TEST_LOG"
`);

    const result = runUpdate({
      NVM_DIR: nvmDir,
      TEST_UPDATE_BACKUP: 'true',
    });

    assert.equal(result.status, 1);
    assert.include(result.stderr, 'Unable to capture the updated Node.js environment');
    assert.deepEqual(commandLog().slice(1), ['backup still ran']);
  });

  it('fails when nvm is enabled but cannot be loaded', () => {
    const result = runUpdate();

    assert.equal(result.status, 1);
    assert.include(result.stdout, 'Updating Node.js LTS');
    assert.include(result.stderr, 'unable to load nvm');
    assert.include(result.stderr, 'Set NVM_DIR');
    assert.include(result.stderr, 'ballin config set update.nvm false');
    assert.isFalse(fs.existsSync(logPath));
  });

  it('does not load nvm when the integration is disabled', () => {
    const nvmDir = path.join(tempDir, 'custom-nvm');
    installNvmStub(nvmDir);

    const result = runUpdate({ NVM_DIR: nvmDir, TEST_UPDATE_NVM: 'false' });

    assert.equal(result.status, 0);
    assert.notInclude(result.stdout, 'Updating Node.js LTS');
    assert.notInclude(result.stderr, 'unable to load nvm');
    assert.isFalse(fs.existsSync(logPath));
  });

  it('exits successfully when a valid configuration has no applicable work', () => {
    writeConfig({
      update: {
        cleanup: false,
        nvm: false,
        npm: false,
        softwareupdate: false,
        selfUpdate: false,
        backup: false,
        unknownFutureSetting: 'ignored',
      },
    });

    const result = spawnUpdate();

    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.deepEqual(commandLog(), []);
  });

  it('uses bundled update defaults in memory when the update section is missing', () => {
    writeConfig({
      backup: {
        id: 'test-gist-id',
        host: 'example.test',
      },
      analytics: {},
    });
    installCommandStub('softwareupdate');
    installHealthyReadinessCommands();
    const beforeConfig = fs.readFileSync(configPath, 'utf8');

    const result = spawnUpdate();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stderr,
      'Warning: using bundled defaults for missing settings: update.cleanup, update.nvm, update.npm, update.softwareupdate, update.selfUpdate, update.backup.\n',
    );
    assert.deepEqual(commandLog(), [
      'softwareupdate|,|-ia',
      'ballin|,|self-update',
      'gh|,|auth status --active --hostname example.test',
      'gh|,|gist view --files -- test-gist-id',
    ]);
    assert.equal(fs.readFileSync(configPath, 'utf8'), beforeConfig);
  });

  it('uses a missing setting default without persisting when self-update is disabled', () => {
    writeConfig({
      update: {
        cleanup: false,
        nvm: false,
        npm: false,
        softwareupdate: false,
        selfUpdate: false,
      },
    });
    const beforeConfig = fs.readFileSync(configPath, 'utf8');

    const result = spawnUpdate();

    assert.equal(result.status, 0);
    assert.equal(
      result.stderr,
      'Warning: using bundled defaults for missing settings: update.backup.\n',
    );
    assert.deepEqual(commandLog(), []);
    assert.equal(fs.readFileSync(configPath, 'utf8'), beforeConfig);
  });

  it('keeps in-memory defaults authoritative when a defaulted self-update is unavailable', () => {
    writeConfig({
      update: {
        cleanup: false,
        nvm: false,
        npm: false,
        softwareupdate: false,
        backup: false,
      },
    });
    const beforeConfig = fs.readFileSync(configPath, 'utf8');

    const result = spawnUpdate();

    assert.equal(result.status, 127);
    assert.include(result.stderr, 'using bundled defaults for missing settings: update.selfUpdate.');
    assert.include(result.stderr, 'ballin: command not found');
    assert.include(result.stdout, 'Updating ballin-scripts');
    assert.equal(fs.readFileSync(configPath, 'utf8'), beforeConfig);
  });

  it('keeps in-memory defaults authoritative when a defaulted self-update fails', () => {
    writeConfig({
      update: {
        cleanup: false,
        nvm: false,
        npm: false,
        softwareupdate: false,
        backup: false,
      },
    });
    installCommandStub('ballin', { status: 23 });
    const beforeConfig = fs.readFileSync(configPath, 'utf8');

    const result = spawnUpdate();

    assert.equal(result.status, 23);
    assert.include(result.stderr, 'using bundled defaults for missing settings: update.selfUpdate.');
    assert.deepEqual(commandLog(), ['ballin|,|self-update']);
    assert.equal(fs.readFileSync(configPath, 'utf8'), beforeConfig);
  });

  [
    {
      name: 'nvm',
      env: { TEST_UPDATE_NVM: 'true' },
      diagnostic: 'unable to load nvm',
    },
    {
      name: 'npm',
      env: { TEST_UPDATE_NVM: 'false', TEST_UPDATE_NPM: 'true' },
      diagnostic: 'npm is not available on PATH',
    },
    {
      name: 'softwareupdate',
      env: { TEST_UPDATE_NVM: 'false', TEST_UPDATE_SOFTWAREUPDATE: 'true' },
      diagnostic: 'softwareupdate is not available on PATH',
    },
  ].forEach(({ name, env, diagnostic }) => {
    it(`records enabled but unavailable ${name} as a failure and continues through backup`, () => {
      installCommandStub('ballin');

      const result = runUpdate({ ...env, TEST_UPDATE_BACKUP: 'true' });

      assert.equal(result.status, 1);
      assert.include(result.stderr, diagnostic);
      assert.deepEqual(commandLog(), ['ballin|,|backup']);
    });
  });

  it('returns the last nonzero status after multiple independent failures', () => {
    installCommandStub('npm', { output: 'simulated npm failure', status: 23 });
    writeTestExecutable('ballin', `#!/usr/bin/env bash
printf '%s|%s|%s\\n' "ballin" "$HOMEBREW_NO_ENV_HINTS,$HOMEBREW_NO_ASK" "$*" >> "$UPDATE_TEST_LOG"
printf '%s\\n' 'simulated backup failure'
exit 17
`);

    const result = runUpdate({
      TEST_UPDATE_NVM: 'false',
      TEST_UPDATE_NPM: 'true',
      TEST_UPDATE_BACKUP: 'true',
    });

    assert.equal(result.status, 17);
    assert.include(result.stdout, 'simulated npm failure');
    assert.include(result.stdout, 'simulated backup failure');
    assert.deepEqual(commandLog(), [
      'npm|,|update -g',
      'ballin|,|backup',
    ]);
  });

  it('rejects non-object configuration structures before running integrations', () => {
    writeConfig([]);
    const arrayResult = spawnUpdate();
    assert.equal(arrayResult.status, 1);
    assert.include(arrayResult.stderr, 'Ballin config must contain a JSON object.');

    writeConfig({ update: null });
    const updateResult = spawnUpdate();
    assert.equal(updateResult.status, 1);
    assert.include(updateResult.stderr, 'Ballin config update section must contain a JSON object.');
    assert.deepEqual(commandLog(), []);
  });

  it('rejects malformed bundled update defaults before reading user settings', () => {
    const defaultPath = path.join(tempDir, 'defaults.json');
    const baseDefaults = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'config', '.defaultConfig.json'),
      'utf8',
    ));

    fs.writeFileSync(defaultPath, JSON.stringify({ ...baseDefaults, update: null }));
    assert.throws(() => resolveUpdateSettings(defaultPath, configPath), 'Bundled default config must contain an update object.');

    const missingSetting = JSON.parse(JSON.stringify(baseDefaults));
    delete missingSetting.update.backup;
    fs.writeFileSync(defaultPath, JSON.stringify(missingSetting));
    assert.throws(() => resolveUpdateSettings(defaultPath, configPath), 'Bundled default config is missing update.backup.');

    const invalidSetting = JSON.parse(JSON.stringify(baseDefaults));
    invalidSetting.update.cleanup = 'sometimes';
    fs.writeFileSync(defaultPath, JSON.stringify(invalidSetting));
    assert.throws(() => resolveUpdateSettings(defaultPath, configPath), 'Bundled default update.cleanup must be true or false.');

    fs.rmSync(defaultPath);
    assert.throws(() => resolveUpdateSettings(defaultPath, configPath), 'Unable to read bundled default config');
    assert.deepEqual(commandLog(), []);
  });

  it('rejects invalid known update booleans before running integrations', () => {
    writeConfig({
      update: {
        cleanup: 'yes',
      },
    });

    const result = spawnUpdate();

    assert.equal(result.status, 1);
    assert.include(result.stderr, 'Ballin config update.cleanup must be true or false.');
    assert.deepEqual(commandLog(), []);
  });

  it('surfaces config read failures', () => {
    fs.writeFileSync(configPath, '{not json\n');

    const result = spawnSync(ballinPath, ['update'], {
      encoding: 'utf8',
      env: {
        HOME: tempDir,
        PATH: binDir,
        BALLIN_NO_ANALYTICS: '1',
        BALLIN_TEST_CONFIG_PATH: configPath,
      },
    });

    assert.equal(result.status, 1);
    assert.include(result.stderr, 'Ballin config is not valid JSON.');
    assert.deepEqual(commandLog(), []);
  });

  it('reports unreadable config before running integrations', () => {
    fs.rmSync(configPath);
    fs.symlinkSync(path.join(tempDir, 'missing-config-target'), configPath);

    const result = spawnUpdate();

    assert.equal(result.status, 1);
    assert.include(result.stderr, 'Unable to read Ballin config');
    assert.deepEqual(commandLog(), []);
  });

  it('reports missing config reads', () => {
    fs.rmSync(configPath);

    const result = spawnSync(ballinPath, ['update'], {
      encoding: 'utf8',
      env: {
        HOME: tempDir,
        PATH: binDir,
        BALLIN_NO_ANALYTICS: '1',
        BALLIN_TEST_CONFIG_PATH: configPath,
      },
    });

    assert.equal(result.status, 1);
    assert.include(result.stderr, 'Unable to read Ballin config');
    assert.deepEqual(commandLog(), []);
  });
});
