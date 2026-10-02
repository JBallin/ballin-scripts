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
    assert.isUndefined(options.env?.GH_HOST);
    commandLog.push([command, ...args].join(' '));
    const status = 0;
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
        repository: null,
      },
      analytics: {},
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('checks coherent repository readability without collecting, probing writes, or repairing cache permissions', () => {
    const { fixtureDestination, fixtureState, requestFixture } = require('./helpers/repository.ts');
    const state = fixtureState(); state.faults.publish = 'denied';
    writeConfig({ backup: { repository: fixtureDestination, includeSensitive: 'false' } });
    const cache = path.join(repoDir, '.backup-cache'); fs.symlinkSync(binDir, cache);
    const report = collect({ runCommand: (_command, args, options) => ({ ...requestFixture(state, args, options), stderr: '' }) });
    assert.equal(checkById(report, 'backup.read').status, 'pass');
    assert.include(checkById(report, 'backup.read').summary, 'Write permission and current source coverage were not checked');
    assert.isTrue(fs.lstatSync(cache).isSymbolicLink());
    assert.isFalse(state.requests.some((r: { payload?: { query?: string } }) => r.payload?.query?.includes('BallinPublish')));
  });

  it('fails repository readiness for invalid consent, unavailable gh, invalid linkage, and incomplete reads', () => {
    const { fixtureDestination, fixtureState, requestFixture } = require('./helpers/repository.ts');
    const state = fixtureState(); state.faults.tree = { truncated: true };
    writeConfig({ backup: { repository: fixtureDestination, includeSensitive: 'invalid' } });
    const report = collect({ runCommand: (_command, args, options) => ({ ...requestFixture(state, args, options), stderr: '' }) });
    assert.equal(checkById(report, 'backup.consent').status, 'fail');
    assert.equal(checkById(report, 'backup.consent').summary, '`backup.includeSensitive` must be true or false; read-only recovery remains available.');
    assert.equal(checkById(report, 'backup.read').status, 'fail');
    fs.rmSync(path.join(binDir, 'gh')); assert.equal(checkById(collect(), 'backup.gh').status, 'fail');
    writeConfig({ backup: { repository: fixtureDestination, id: 'legacy' } });
    assert.equal(checkById(collect(), 'backup.config').status, 'fail');
    assert.equal(checkById(collect(), 'backup.config').summary, 'Invalid or conflicting backup destination. Run `ballin backup disconnect`, then `ballin backup setup` to select a private repository.');
    assert.deepEqual(commandLog, []);
  });

  it('reports supported and unsupported Node.js runtimes', () => {
    const supported = collect({ nodeVersion: '24.12.0', nodeEngine: '>=24.12' });
    const unsupported = collect({ nodeVersion: '24.11.9', nodeEngine: '>=24.12' });

    assert.equal(checkById(supported, 'runtime.node').status, 'pass');
    assert.equal(checkById(unsupported, 'runtime.node').status, 'fail');
    assert.equal(unsupported.status, 'fail');
  });

  it('warns when package engine metadata or runtime versions cannot be compared', () => {
    const invalidRuntime = collect({ nodeVersion: 'nightly', nodeEngine: '>=24' });
    const invalidEngine = collect({ nodeVersion: '24.12.0', nodeEngine: '24.x' });

    assert.equal(checkById(invalidRuntime, 'runtime.node').status, 'warn');
    assert.include(checkById(invalidRuntime, 'runtime.node').summary, 'Unable to compare');
    assert.equal(checkById(invalidEngine, 'runtime.node').status, 'warn');

    const packagePath = path.join(repoDir, 'package.json');
    [
      'null\n',
      '{}\n',
      '{"engines":{}}\n',
      '{"engines":{"node":24}}\n',
      '{not json\n',
    ].forEach((contents) => {
      fs.writeFileSync(packagePath, contents);
      const report = collect({ nodeVersion: '24.12.0' });
      assert.equal(checkById(report, 'runtime.node').status, 'warn');
      assert.include(checkById(report, 'runtime.node').summary, 'Unable to determine');
    });
  });

  it('reports missing and non-executable command shims on PATH', () => {
    fs.rmSync(path.join(binDir, 'ballin'));

    const report = collect();
    const commandCheck = checkById(report, 'commands.path');

    assert.equal(commandCheck.status, 'fail');
    assert.equal(commandCheck.summary, 'Missing command shims on PATH: `ballin`.');
    assert.deepEqual(commandCheck.data?.missing, ['ballin']);
  });

  it('reports config readability and top-level section availability', () => {
    const readableConfig = collect();
    fs.rmSync(configPath);
    assert.equal(checkById(collect(), 'config.read').status, 'fail');

    fs.writeFileSync(configPath, '{not json\n');
    assert.include(checkById(collect(), 'config.read').summary, 'not valid JSON');

    writeConfig([]);
    assert.include(checkById(collect(), 'config.read').summary, 'must contain a JSON object');

    writeConfig({ backup: { id: null, host: 'example.test' } });
    const sectionCheck = checkById(collect(), 'config.read');

    assert.equal(checkById(readableConfig, 'config.read').status, 'pass');
    assert.equal(sectionCheck.status, 'warn');
    assert.equal(sectionCheck.summary, 'Config is readable but missing sections: `update`, `analytics`.');
    assert.deepEqual(sectionCheck.data?.missingSections, ['update', 'analytics']);
  });

  it('fails structurally invalid config instead of treating it as maintenance-only', () => {
    writeConfig({
      update: {},
      backup: null,
      analytics: {},
    });

    const report = collect();

    assert.equal(report.status, 'fail');
    assert.equal(checkById(report, 'config.read').status, 'fail');
    assert.equal(checkById(report, 'config.read').summary, 'Config sections must be JSON objects: `backup`.');
    assert.equal(checkById(report, 'backup.config').status, 'info');
    assert.isUndefined(report.checks.find((check) => check.id === 'backup.optional'));
    assert.deepEqual(commandLog, []);
  });

  it('reports retired Gist linkage without invoking gh or changing config', () => {
    for (const id of ['legacy-id', '--help']) {
      writeConfig({ update: {}, backup: { id, host: 'example.test' }, analytics: {} });
      const beforeConfig = fs.readFileSync(configPath, 'utf8');
      const report = collect();
      assert.equal(report.status, 'fail');
      assert.equal(checkById(report, 'backup.config').summary,
        'Gist backups have been retired. Run `ballin backup disconnect`, then `ballin backup setup` to select a private repository. Existing Gists are preserved.');
      assert.deepEqual(report.checks.filter((check) => check.id.startsWith('backup.')).map((check) => check.id), ['backup.config']);
      assert.deepEqual(commandLog, []);
      assert.equal(fs.readFileSync(configPath, 'utf8'), beforeConfig);
    }
  });

  it('treats an unconfigured backup as an optional healthy capability without gh', () => {
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

    assert.equal(report.status, 'pass');
    assert.equal(checkById(report, 'backup.optional').status, 'info');
    assert.equal(checkById(report, 'backup.optional').summary, 'Backup is not configured. Maintenance-only Ballin is supported; run `ballin backup setup` to enable it.');
    assert.deepEqual(report.checks.filter((check) => check.id.startsWith('backup.')).map((check) => check.id), [
      'backup.optional',
    ]);
    assert.deepEqual(commandLog, []);
  });

  it('normalizes blank and legacy string null backup IDs as unconfigured', () => {
    ['', '   ', 'null'].forEach((id) => {
      commandLog = [];
      writeConfig({
        update: {},
        backup: {
          id,
          host: 'example.test',
        },
        analytics: {},
      });

      const report = collect();

      assert.equal(report.status, 'pass');
      assert.equal(checkById(report, 'backup.optional').status, 'info');
      assert.deepEqual(commandLog, []);
    });
  });

  it('rejects malformed legacy linkage without invoking gh', () => {
    [42, ['unexpected-id'], { value: 'unexpected-id' }].forEach((id) => {
      writeConfig({ update: {}, backup: { id }, analytics: {} });
      const report = collect();
      assert.equal(report.status, 'fail');
      assert.equal(checkById(report, 'backup.config').status, 'fail');
      assert.include(checkById(report, 'backup.config').summary, '`ballin backup disconnect`, then `ballin backup setup`');
      assert.deepEqual(commandLog, []);
    });
  });
});
