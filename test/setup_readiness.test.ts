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
  let authStatus: number;

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
  ): FakeRunResult => {
    commandLog.push([command, ...args].join(' '));
    return {
      status: authStatus,
      signal: null,
      stdout: '',
      stderr: authStatus === 0 ? '' : 'simulated auth failure\n',
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
    authStatus = 0;

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
      up: {},
      gu: {
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
    fs.rmSync(path.join(binDir, 'up'));
    fs.writeFileSync(path.join(binDir, 'gu'), 'not executable\n', { mode: 0o644 });
    fs.chmodSync(path.join(binDir, 'gu'), 0o644);

    const report = collect();
    const commandCheck = checkById(report, 'commands.path');

    assert.equal(commandCheck.status, 'fail');
    assert.deepEqual(commandCheck.data?.missing, ['gu', 'up']);
  });

  it('reports config readability and top-level section availability', () => {
    const readableConfig = collect();
    fs.rmSync(configPath);
    assert.equal(checkById(collect(), 'config.read').status, 'fail');

    fs.writeFileSync(configPath, '{not json\n');
    assert.include(checkById(collect(), 'config.read').summary, 'not valid JSON');

    writeConfig({ gu: { id: null, host: 'example.test' } });
    const sectionCheck = checkById(collect(), 'config.read');

    assert.equal(checkById(readableConfig, 'config.read').status, 'pass');
    assert.equal(sectionCheck.status, 'warn');
    assert.deepEqual(sectionCheck.data?.missingSections, ['up', 'analytics']);
  });

  it('reports successful Gist readiness signals without mutating anything', () => {
    const beforeConfig = fs.readFileSync(configPath, 'utf8');

    const report = collect();

    assert.equal(report.status, 'pass');
    assert.equal(checkById(report, 'gu.host').status, 'pass');
    assert.equal(checkById(report, 'gu.gist').status, 'pass');
    assert.equal(checkById(report, 'gu.gh').status, 'pass');
    assert.equal(checkById(report, 'gu.auth').status, 'pass');
    assert.deepEqual(commandLog, ['gh auth status --hostname example.test']);
    assert.equal(fs.readFileSync(configPath, 'utf8'), beforeConfig);
    assert.notInclude(commandLog.join('\n'), 'gist create');
    assert.notInclude(commandLog.join('\n'), 'gist edit');
    assert.notInclude(commandLog.join('\n'), 'ballin_config set');
  });

  it('reports unconfigured Gist ID and missing gh as non-mutating warnings', () => {
    fs.rmSync(path.join(binDir, 'gh'));
    writeConfig({
      up: {},
      gu: {
        id: null,
        host: 'example.test',
      },
      analytics: {},
    });

    const report = collect();

    assert.equal(report.status, 'warn');
    assert.equal(checkById(report, 'gu.gist').status, 'warn');
    assert.equal(checkById(report, 'gu.gh').status, 'warn');
    assert.equal(checkById(report, 'gu.auth').status, 'info');
    assert.deepEqual(commandLog, []);
  });

  it('reports missing Gist host and failed gh auth', () => {
    writeConfig({
      up: {},
      gu: {
        id: 'test-gist-id',
      },
      analytics: {},
    });

    const missingHost = collect();
    assert.equal(checkById(missingHost, 'gu.host').status, 'fail');
    assert.equal(checkById(missingHost, 'gu.auth').status, 'info');
    assert.deepEqual(commandLog, []);

    writeConfig({
      up: {},
      gu: {
        id: 'test-gist-id',
        host: 'example.test',
      },
      analytics: {},
    });
    authStatus = 4;
    const authFailed = collect();

    assert.equal(checkById(authFailed, 'gu.auth').status, 'warn');
    assert.equal(authFailed.status, 'warn');
    assert.deepEqual(commandLog, ['gh auth status --hostname example.test']);
  });
});
