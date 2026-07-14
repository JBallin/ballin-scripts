const { assert } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  collectSetupReadiness,
  requiredCommandShims,
} = require('../commands/setup_readiness.ts');

type ReadinessCheck = {
  id: string;
  status: string;
  summary: string;
  data?: Record<string, unknown>;
};
type ReadinessReport = {
  status: string;
  checks: ReadinessCheck[];
};
type FakeRunResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

describe('setup readiness', () => {
  let tempDir: string;
  let repoDir: string;
  let binDir: string;
  let configPath: string;
  let commandLog: string[];
  let commandHosts: (string | undefined)[];
  let authStatus: number;
  let gistReadStatus: number;

  const writeExecutable = (name: string, contents = '#!/usr/bin/env bash\nexit 0\n') => {
    fs.writeFileSync(path.join(binDir, name), contents, { mode: 0o755 });
  };

  const writeConfig = (config: unknown) => {
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  };

  const checkById = (report: ReadinessReport, id: string): ReadinessCheck => {
    const check = report.checks.find((candidate) => candidate.id === id);
    assert.exists(check, `expected readiness check ${id}`);
    return check as ReadinessCheck;
  };

  const fakeRunCommand = (
    command: string,
    args: string[] = [],
    options: { env?: NodeJS.ProcessEnv } = {},
  ): FakeRunResult => {
    commandLog.push([command, ...args].join(' '));
    commandHosts.push(options.env?.GH_HOST);
    const status = args[0] === 'gist' ? gistReadStatus : authStatus;
    return {
      status,
      signal: null,
      stdout: '',
      stderr: status === 0 ? '' : 'simulated gh failure\n',
    };
  };

  const collect = (options: {
    nodeVersion?: string;
    nodeEngine?: string;
    runCommand?: typeof fakeRunCommand;
  } = {}): ReadinessReport => collectSetupReadiness({
    repoDir,
    configPath,
    env: {
      PATH: binDir,
    },
    runCommand: options.runCommand ?? fakeRunCommand,
    nodeVersion: options.nodeVersion,
    nodeEngine: options.nodeEngine,
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-readiness-'));
    repoDir = path.join(tempDir, 'repo');
    binDir = path.join(tempDir, 'bin');
    configPath = path.join(repoDir, 'ballin.config.json');
    commandLog = [];
    commandHosts = [];
    authStatus = 0;
    gistReadStatus = 0;

    fs.mkdirSync(repoDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({
      engines: {
        node: '>=24.12',
      },
    }));
    requiredCommandShims.forEach((command: string) => writeExecutable(command));
    writeExecutable('gh');
    writeConfig({
      update: {},
      backup: {
        id: 'test-gist-id',
        host: 'example.test',
      },
      analytics: {},
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports supported and unsupported Node.js runtimes', () => {
    const supported = collect({ nodeVersion: '24.12.0', nodeEngine: '>=24.12' });
    const unsupported = collect({ nodeVersion: '24.11.9', nodeEngine: '>=24.12' });

    assert.equal(checkById(supported, 'runtime.node').status, 'pass');
    assert.equal(checkById(unsupported, 'runtime.node').status, 'fail');
    assert.equal(unsupported.status, 'fail');
  });

  it('reports missing and non-executable command shims on PATH', () => {
    fs.rmSync(path.join(binDir, 'ballin'));

    const report = collect();
    const commandCheck = checkById(report, 'commands.path');

    assert.equal(commandCheck.status, 'fail');
    assert.deepEqual(commandCheck.data?.missing, ['ballin']);
  });

  it('reports config readability and top-level section availability', () => {
    const readableConfig = collect();
    fs.rmSync(configPath);
    assert.equal(checkById(collect(), 'config.read').status, 'fail');

    fs.writeFileSync(configPath, '{not json\n');
    assert.include(checkById(collect(), 'config.read').summary, 'not valid JSON');

    writeConfig({ backup: { id: null, host: 'example.test' } });
    const sectionCheck = checkById(collect(), 'config.read');

    assert.equal(checkById(readableConfig, 'config.read').status, 'pass');
    assert.equal(sectionCheck.status, 'warn');
    assert.deepEqual(sectionCheck.data?.missingSections, ['update', 'analytics']);
  });

  it('reports successful Gist readiness signals without mutating anything', () => {
    const beforeConfig = fs.readFileSync(configPath, 'utf8');

    const report = collect();

    assert.equal(report.status, 'pass');
    assert.equal(checkById(report, 'backup.host').status, 'pass');
    assert.equal(checkById(report, 'backup.gist').status, 'pass');
    assert.equal(checkById(report, 'backup.gh').status, 'pass');
    assert.equal(checkById(report, 'backup.auth').status, 'pass');
    assert.equal(checkById(report, 'backup.read').status, 'pass');
    assert.equal(
      checkById(report, 'backup.read').summary,
      'The configured backup Gist exists and is readable. Write permission was not checked.',
    );
    assert.deepEqual(commandLog, [
      'gh auth status --hostname example.test',
      'gh gist view test-gist-id --files',
    ]);
    assert.deepEqual(commandHosts, ['example.test', 'example.test']);
    assert.equal(fs.readFileSync(configPath, 'utf8'), beforeConfig);
    assert.notInclude(commandLog.join('\n'), 'gist create');
    assert.notInclude(commandLog.join('\n'), 'gist edit');
    assert.notInclude(commandLog.join('\n'), 'ballin config set');
  });

  it('reports unconfigured Gist ID and missing gh as failures', () => {
    fs.rmSync(path.join(binDir, 'gh'));
    writeConfig({
      update: {},
      backup: {
        id: null,
        host: 'example.test',
      },
      analytics: {},
    });

    const report = collect();

    assert.equal(report.status, 'fail');
    assert.equal(checkById(report, 'backup.gist').status, 'fail');
    assert.equal(checkById(report, 'backup.gh').status, 'fail');
    assert.equal(checkById(report, 'backup.auth').status, 'info');
    assert.equal(checkById(report, 'backup.read').status, 'info');
    assert.deepEqual(commandLog, []);
  });

  it('authenticates but skips Gist readability when the Gist ID is missing', () => {
    writeConfig({
      update: {},
      backup: {
        id: null,
        host: 'example.test',
      },
      analytics: {},
    });

    const report = collect();

    assert.equal(report.status, 'fail');
    assert.equal(checkById(report, 'backup.gist').status, 'fail');
    assert.equal(checkById(report, 'backup.auth').status, 'pass');
    assert.equal(checkById(report, 'backup.read').status, 'info');
    assert.include(checkById(report, 'backup.read').summary, 'until a backup Gist ID is configured');
    assert.deepEqual(commandLog, ['gh auth status --hostname example.test']);
  });

  it('reports missing Gist host and failed gh auth', () => {
    writeConfig({
      update: {},
      backup: {
        id: 'test-gist-id',
      },
      analytics: {},
    });

    const missingHost = collect();
    assert.equal(checkById(missingHost, 'backup.host').status, 'fail');
    assert.equal(checkById(missingHost, 'backup.auth').status, 'info');
    assert.equal(checkById(missingHost, 'backup.read').status, 'info');
    assert.deepEqual(commandLog, []);

    writeConfig({
      update: {},
      backup: {
        id: 'test-gist-id',
        host: 'example.test',
      },
      analytics: {},
    });
    authStatus = 4;
    const authFailed = collect();

    assert.equal(checkById(authFailed, 'backup.auth').status, 'fail');
    assert.equal(checkById(authFailed, 'backup.read').status, 'info');
    assert.equal(authFailed.status, 'fail');
    assert.deepEqual(commandLog, ['gh auth status --hostname example.test']);
  });

  it('fails when the configured Gist cannot be read', () => {
    gistReadStatus = 4;

    const report = collect();
    const readCheck = checkById(report, 'backup.read');

    assert.equal(report.status, 'fail');
    assert.equal(readCheck.status, 'fail');
    assert.equal(readCheck.summary, 'The configured backup Gist could not be read.');
    assert.deepEqual(commandLog, [
      'gh auth status --hostname example.test',
      'gh gist view test-gist-id --files',
    ]);
    assert.deepEqual(commandHosts, ['example.test', 'example.test']);
  });
});
