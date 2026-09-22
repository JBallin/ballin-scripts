const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const https = require('https');
const { fetchConfig, configMessages, configPath, stringify } = require('../config/index.ts');
const { runConfigCli } = require('../config/cli.ts');
const {
  analyticsDisabledByEnv,
  buildAnalyticsPayload,
  coarseOsVersion,
  durationBucketFromMs,
  ensureAnalyticsInstallId,
  loadAppVersion,
  recordAnalyticsEvent,
  rethrowCommandError,
  runWithCommandAnalytics,
  sendAnalyticsPayload,
} = require('../commands/analytics.ts');
const {
  topLevelCommandNames,
} = require('../commands/top_level_commands.ts');

import type { ClientRequest, IncomingMessage } from 'http';
import type { RequestOptions } from 'https';

type AnalyticsPayload = {
  schemaVersion: 1;
  installId: string;
  dateBucket: string;
  command: string;
  status: string;
  durationBucket: string;
  appVersion: string;
  nodeMajor: string;
  osVersion: string;
};

type SenderOptions = {
  endpoint?: string;
  timeoutMs?: number;
};

const fs = require('fs');
const os = require('os');
const path = require('path');
const packageJson = require('../package.json');
const fixedInstallId = '826f9faa-9995-4f66-a01b-73b4f7aebdf1';
const alternateInstallId = '123e4567-e89b-42d3-a456-426614174000';
const fixedNow = new Date('2026-06-27T20:15:00.000Z');
const fixedOsVersionOptions = {
  platform: () => 'darwin',
  readCommandOutput: () => '26.6.2\n',
};
const allowedPayloadKeys = [
  'schemaVersion',
  'installId',
  'dateBucket',
  'command',
  'status',
  'durationBucket',
  'appVersion',
  'nodeMajor',
  'osVersion',
];

const fetchConfigJSON = () => fetchConfig().configJSON;
let testInstallIdPath = '';

const writeConfig = (configObj: Record<string, unknown>): void => {
  fs.writeFileSync(configPath, stringify(configObj), 'utf8');
};

const setAnalyticsConfig = (analytics: Record<string, unknown>): void => {
  const { configObj } = fetchConfig();
  configObj.analytics = analytics;
  writeConfig(configObj);
};

const writeInstallId = (installId = fixedInstallId): void => {
  fs.mkdirSync(path.dirname(testInstallIdPath), { recursive: true });
  fs.writeFileSync(testInstallIdPath, `${installId}\n`, 'utf8');
};

const writeRawInstallId = (installId: string): void => {
  fs.mkdirSync(path.dirname(testInstallIdPath), { recursive: true });
  fs.writeFileSync(testInstallIdPath, installId, 'utf8');
};

const recordWithSender = (
  input: Record<string, unknown>,
  runtime: Record<string, unknown> = {},
): Promise<{ payloads: AnalyticsPayload[]; order: string[] }> => {
  const payloads: AnalyticsPayload[] = [];
  const order: string[] = [];

  return recordAnalyticsEvent(input, {
    endpoint: 'https://analytics.example.test/v1/events',
    env: {},
    installIdPath: testInstallIdPath,
    osVersionOptions: fixedOsVersionOptions,
    sender: async (payload: AnalyticsPayload) => {
      order.push('send');
      payloads.push(payload);
    },
    ...runtime,
  }).then(() => {
    return { payloads, order };
  });
};

const runConfigWithAnalytics = async (
  args: string[],
  runtime: Record<string, unknown> = {},
) => {
  const payloads: AnalyticsPayload[] = [];
  let stdout = '';
  let stderr = '';
  const previousExitCode = process.exitCode;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  try {
    await runWithCommandAnalytics('ballin config', () => runConfigCli(args), {
      analyticsConfig: { enabled: 'true' },
      appVersion: packageJson.version,
      env: {},
      installId: fixedInstallId,
      nowMs: () => 1000,
      osVersionOptions: fixedOsVersionOptions,
      sender: async (payload: AnalyticsPayload) => {
        payloads.push(payload);
      },
      ...runtime,
    });
    return { payloads, stdout, stderr, exitCode: process.exitCode };
  } finally {
    process.exitCode = previousExitCode;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
};

describe('analytics client', () => {
  let savedConfig: string;
  let tempDir: string;

  beforeEach(() => {
    savedConfig = fetchConfigJSON();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-analytics-'));
    testInstallIdPath = path.join(tempDir, '.analytics', 'install-id');
  });

  afterEach(() => {
    fs.writeFileSync(configPath, savedConfig, 'utf8');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('treats BALLIN_NO_ANALYTICS and CI as hard opt-outs', () => {
    assert.isTrue(analyticsDisabledByEnv({ BALLIN_NO_ANALYTICS: '1' }));
    assert.isTrue(analyticsDisabledByEnv({ CI: 'true' }));
    assert.isTrue(analyticsDisabledByEnv({ CI: 'false' }));
    assert.isFalse(analyticsDisabledByEnv({ CI: '' }));
    assert.isFalse(analyticsDisabledByEnv({ BALLIN_NO_ANALYTICS: '0' }));
    assert.isFalse(analyticsDisabledByEnv({ BALLIN_NO_COMMAND_ANALYTICS: '1' }));
  });

  it('defaults to the harness opt-out even with enabled config and a valid install ID', async () => {
    setAnalyticsConfig({ enabled: 'true' });
    writeInstallId();

    const { payloads } = await recordWithSender({ command: 'ballin', now: fixedNow }, {
      env: undefined,
    });

    assert.isUndefined(process.env.CI);
    assert.equal(process.env.BALLIN_NO_ANALYTICS, '1');
    assert.deepEqual(payloads, []);

    fs.rmSync(testInstallIdPath);
    assert.isNull(ensureAnalyticsInstallId({
      analyticsConfig: { enabled: 'true' },
      installIdPath: testInstallIdPath,
    }));
    assert.isFalse(fs.existsSync(testInstallIdPath));
  });

  it('does not send when analytics are disabled in config', async () => {
    setAnalyticsConfig({
      enabled: 'false',
    });
    writeInstallId();

    const { payloads } = await recordWithSender({
      command: 'ballin update',
      now: fixedNow,
    });

    assert.deepEqual(payloads, []);
  });

  it('treats malformed analytics config as disabled', async () => {
    const { configObj } = fetchConfig();
    configObj.analytics = false;
    writeConfig(configObj);
    writeInstallId();

    const { payloads } = await recordWithSender({ command: 'ballin', now: fixedNow });

    assert.deepEqual(payloads, []);
  });

  it('does not send when environment opt-outs are set', async () => {
    const optOuts = [
      { BALLIN_NO_ANALYTICS: '1' },
      { CI: 'true' },
    ];

    for (const env of optOuts) {
      setAnalyticsConfig({
        enabled: 'true',
      });
      writeInstallId();

      const { payloads } = await recordWithSender({
        command: 'ballin update',
        now: fixedNow,
      }, { env });

      assert.deepEqual(payloads, []);
    }
  });

  it('keeps hard environment opt-outs from creating analytics install IDs', () => {
    for (const env of [{ BALLIN_NO_ANALYTICS: '1' }, { CI: 'true' }]) {
      const installId = ensureAnalyticsInstallId({
        analyticsConfig: { enabled: 'true' },
        env,
        generateInstallId: () => fixedInstallId,
        installIdPath: testInstallIdPath,
      });

      assert.isNull(installId);
      assert.isFalse(fs.existsSync(testInstallIdPath));
    }
  });

  it('suppresses command events without blocking analytics install ID repair', async () => {
    const commandOnlyEnv = { BALLIN_NO_COMMAND_ANALYTICS: '1' };
    writeRawInstallId('not-a-uuid\n');

    const installId = ensureAnalyticsInstallId({
      analyticsConfig: { enabled: 'true' },
      env: commandOnlyEnv,
      generateInstallId: () => fixedInstallId,
      installIdPath: testInstallIdPath,
    });
    const { payloads } = await recordWithSender({
      command: 'ballin update',
      now: fixedNow,
    }, {
      env: commandOnlyEnv,
    });

    assert.equal(installId, fixedInstallId);
    assert.equal(fs.readFileSync(testInstallIdPath, 'utf8'), `${fixedInstallId}\n`);
    assert.deepEqual(payloads, []);
  });

  it('makes concurrent missing install ID repairs converge on one identity', async function () {
    this.timeout(5000);
    const releasePath = path.join(tempDir, 'release-install-id-repair');
    const analyticsModulePath = path.join(__dirname, '..', 'commands', 'analytics.ts');
    const childScript = `
const fs = require('fs');
const { ensureAnalyticsInstallId } = require(${JSON.stringify(analyticsModulePath)});
const waitState = new Int32Array(new SharedArrayBuffer(4));
const result = ensureAnalyticsInstallId({
  analyticsConfig: { enabled: 'true' },
  env: {},
  generateInstallId: () => {
    fs.writeFileSync(process.env.ANALYTICS_TEST_READY_PATH, 'ready');
    while (!fs.existsSync(process.env.ANALYTICS_TEST_RELEASE_PATH)) {
      Atomics.wait(waitState, 0, 0, 5);
    }
    return process.env.ANALYTICS_TEST_CANDIDATE;
  },
  installIdPath: process.env.ANALYTICS_TEST_INSTALL_ID_PATH,
});
process.stdout.write(JSON.stringify({ result }));
`;
    const candidates = [fixedInstallId, alternateInstallId];
    const children = candidates.map((candidate, index) => {
      const readyPath = path.join(tempDir, `install-id-ready-${index}`);
      const child = spawn(process.execPath, ['-e', childScript], {
        env: {
          ...process.env,
          ANALYTICS_TEST_CANDIDATE: candidate,
          ANALYTICS_TEST_INSTALL_ID_PATH: testInstallIdPath,
          ANALYTICS_TEST_READY_PATH: readyPath,
          ANALYTICS_TEST_RELEASE_PATH: releasePath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      const completed = new Promise<string>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code: number | null) => {
          if (code !== 0) {
            reject(new Error(`analytics repair child exited ${code}: ${stderr}`));
            return;
          }
          resolve(JSON.parse(stdout).result);
        });
      });
      return { completed, readyPath };
    });

    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (children.every(({ readyPath }) => fs.existsSync(readyPath))) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const bothReady = children.every(({ readyPath }) => fs.existsSync(readyPath));
    fs.writeFileSync(releasePath, 'release');

    const results = await Promise.all(children.map(({ completed }) => completed));
    assert.isTrue(bothReady, 'both repairs reached the barrier');
    const persistedInstallId = fs.readFileSync(testInstallIdPath, 'utf8').trim();
    assert.include(candidates, persistedInstallId);
    assert.deepEqual(results, [persistedInstallId, persistedInstallId]);

    const laterResult = ensureAnalyticsInstallId({
      analyticsConfig: { enabled: 'true' },
      env: {},
      generateInstallId: () => 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      installIdPath: testInstallIdPath,
    });
    assert.equal(laterResult, persistedInstallId);
    assert.equal(fs.readFileSync(testInstallIdPath, 'utf8'), `${persistedInstallId}\n`);
  });

  it('uses the valid winner when an invalid-ID repair loses its lock race', () => {
    writeRawInstallId('not-a-uuid\n');
    const originalLink = fs.linkSync;
    fs.linkSync = ((source: string, destination: string) => {
      const result = originalLink(source, destination);
      if (destination === `${testInstallIdPath}.lock`) {
        fs.writeFileSync(testInstallIdPath, `${fixedInstallId}\n`, 'utf8');
      }
      return result;
    }) as typeof fs.linkSync;

    try {
      const result = ensureAnalyticsInstallId({
        analyticsConfig: { enabled: 'true' },
        env: {},
        generateInstallId: () => alternateInstallId,
        installIdPath: testInstallIdPath,
      });

      assert.equal(result, fixedInstallId);
      assert.equal(fs.readFileSync(testInstallIdPath, 'utf8'), `${fixedInstallId}\n`);
    } finally {
      fs.linkSync = originalLink;
    }
  });

  it('uses the valid winner when it appears before invalid-ID promotion commits', () => {
    writeRawInstallId('not-a-uuid\n');
    const originalLink = fs.linkSync;
    fs.linkSync = ((source: string, destination: string) => {
      const result = originalLink(source, destination);
      if (destination.endsWith('.promotion')) {
        fs.writeFileSync(testInstallIdPath, `${fixedInstallId}\n`, 'utf8');
      }
      return result;
    }) as typeof fs.linkSync;

    try {
      const result = ensureAnalyticsInstallId({
        analyticsConfig: { enabled: 'true' },
        env: {},
        generateInstallId: () => alternateInstallId,
        installIdPath: testInstallIdPath,
      });

      assert.equal(result, fixedInstallId);
      assert.equal(fs.readFileSync(testInstallIdPath, 'utf8'), `${fixedInstallId}\n`);
    } finally {
      fs.linkSync = originalLink;
    }
  });

  it('discards an invalid stale repair claim without changing the invalid ID', () => {
    writeRawInstallId('not-a-uuid\n');
    fs.writeFileSync(`${testInstallIdPath}.lock`, 'also-not-a-uuid\n', { mode: 0o600 });

    const result = ensureAnalyticsInstallId({
      analyticsConfig: { enabled: 'true' },
      env: {},
      generateInstallId: () => fixedInstallId,
      installIdPath: testInstallIdPath,
    });

    assert.isNull(result);
    assert.equal(fs.readFileSync(testInstallIdPath, 'utf8'), 'not-a-uuid\n');
    assert.isFalse(fs.existsSync(`${testInstallIdPath}.lock`));
  });

  it('keeps install ID claim and repair filesystem failures non-blocking', () => {
    const originalLink = fs.linkSync;
    fs.linkSync = (() => {
      throw Object.assign(new Error('simulated install ID claim failure'), { code: 'EACCES' });
    }) as typeof fs.linkSync;
    try {
      assert.isNull(ensureAnalyticsInstallId({
        analyticsConfig: { enabled: 'true' },
        env: {},
        generateInstallId: () => fixedInstallId,
        installIdPath: testInstallIdPath,
      }));
    } finally {
      fs.linkSync = originalLink;
    }

    writeRawInstallId('not-a-uuid\n');
    fs.linkSync = ((source: string, destination: string) => {
      if (destination === `${testInstallIdPath}.lock`) {
        throw Object.assign(new Error('simulated install ID lock failure'), { code: 'EACCES' });
      }
      return originalLink(source, destination);
    }) as typeof fs.linkSync;
    try {
      assert.isNull(ensureAnalyticsInstallId({
        analyticsConfig: { enabled: 'true' },
        env: {},
        generateInstallId: () => fixedInstallId,
        installIdPath: testInstallIdPath,
      }));
    } finally {
      fs.linkSync = originalLink;
    }

    const originalRename = fs.renameSync;
    fs.renameSync = (() => {
      throw Object.assign(new Error('simulated install ID commit failure'), { code: 'EIO' });
    }) as typeof fs.renameSync;
    try {
      assert.isNull(ensureAnalyticsInstallId({
        analyticsConfig: { enabled: 'true' },
        env: {},
        generateInstallId: () => fixedInstallId,
        installIdPath: testInstallIdPath,
      }));
    } finally {
      fs.renameSync = originalRename;
    }

    assert.equal(fs.readFileSync(testInstallIdPath, 'utf8'), 'not-a-uuid\n');
    assert.isFalse(fs.existsSync(`${testInstallIdPath}.lock`));
  });

  it('keeps failed invalid-ID repair non-blocking when promotion cleanup also fails', () => {
    writeRawInstallId('not-a-uuid\n');
    const originalRename = fs.renameSync;
    const originalRemove = fs.rmSync;
    let promotionCleanupAttempted = false;
    fs.renameSync = (() => {
      throw Object.assign(new Error('simulated install ID commit failure'), { code: 'EIO' });
    }) as typeof fs.renameSync;
    fs.rmSync = ((entry: string, ...args: unknown[]) => {
      const result = Reflect.apply(originalRemove, fs, [entry, ...args]);
      if (entry.endsWith('.promotion')) {
        promotionCleanupAttempted = true;
        throw Object.assign(new Error('simulated promotion cleanup failure'), { code: 'EIO' });
      }
      return result;
    }) as typeof fs.rmSync;

    try {
      const result = ensureAnalyticsInstallId({
        analyticsConfig: { enabled: 'true' },
        env: {},
        generateInstallId: () => fixedInstallId,
        installIdPath: testInstallIdPath,
      });

      assert.isNull(result);
      assert.isTrue(promotionCleanupAttempted);
      assert.equal(fs.readFileSync(testInstallIdPath, 'utf8'), 'not-a-uuid\n');
      assert.isFalse(fs.existsSync(`${testInstallIdPath}.lock`));
      assert.deepEqual(
        fs.readdirSync(path.dirname(testInstallIdPath))
          .filter((entry: string) => entry.endsWith('.tmp') || entry.endsWith('.promotion')),
        [],
      );
    } finally {
      fs.renameSync = originalRename;
      fs.rmSync = originalRemove;
    }
  });

  it('keeps install ID repair successful when private cleanup reports failures', () => {
    writeRawInstallId('not-a-uuid\n');
    const lockPath = `${testInstallIdPath}.lock`;
    const originalRemove = fs.rmSync;
    fs.rmSync = ((entry: string, ...args: unknown[]) => {
      const result = Reflect.apply(originalRemove, fs, [entry, ...args]);
      if (entry === lockPath || entry.endsWith('.tmp')) {
        throw Object.assign(new Error('simulated private cleanup failure'), { code: 'EIO' });
      }
      return result;
    }) as typeof fs.rmSync;

    try {
      const result = ensureAnalyticsInstallId({
        analyticsConfig: { enabled: 'true' },
        env: {},
        generateInstallId: () => fixedInstallId,
        installIdPath: testInstallIdPath,
      });

      assert.equal(result, fixedInstallId);
      assert.equal(fs.readFileSync(testInstallIdPath, 'utf8'), `${fixedInstallId}\n`);
      assert.isFalse(fs.existsSync(lockPath));
    } finally {
      fs.rmSync = originalRemove;
    }
  });

  it('finishes a valid claimed invalid-ID repair left by another process', () => {
    writeRawInstallId('not-a-uuid\n');
    fs.writeFileSync(`${testInstallIdPath}.lock`, `${alternateInstallId}\n`, { mode: 0o600 });

    const result = ensureAnalyticsInstallId({
      analyticsConfig: { enabled: 'true' },
      env: {},
      generateInstallId: () => fixedInstallId,
      installIdPath: testInstallIdPath,
    });

    assert.equal(result, alternateInstallId);
    assert.equal(fs.readFileSync(testInstallIdPath, 'utf8'), `${alternateInstallId}\n`);
    assert.isFalse(fs.existsSync(`${testInstallIdPath}.lock`));
  });

  it('reads the local install ID and includes it in the payload', async () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();

    const { payloads, order } = await recordWithSender({
      command: 'ballin',
      status: 'success',
      durationBucket: '<1s',
      now: fixedNow,
    });
    const updatedAnalytics = fetchConfig().configObj.analytics;

    assert.deepEqual(order, ['send']);
    assert.lengthOf(payloads, 1);
    assert.equal(payloads[0].installId, fixedInstallId);
    assert.deepEqual(updatedAnalytics, {
      enabled: 'true',
    });
  });

  it('uses the production endpoint default without a bundled ingest token', async () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();
    const senderOptions: SenderOptions[] = [];

    await recordAnalyticsEvent({
      command: 'ballin',
      now: fixedNow,
    }, {
      env: {},
      installIdPath: testInstallIdPath,
      osVersionOptions: fixedOsVersionOptions,
      sender: async (_payload: AnalyticsPayload, options: SenderOptions) => {
        senderOptions.push(options);
      },
    });

    assert.deepInclude(senderOptions[0], {
      endpoint: 'https://ballin-scripts-analytics.jballin.workers.dev/v1/events',
    });
    assert.notProperty(senderOptions[0], 'ingestToken');
  });

  it('skips sending when the local install ID is missing', async () => {
    setAnalyticsConfig({
      enabled: 'true',
    });

    const { payloads } = await recordWithSender({
      command: 'ballin update',
      now: fixedNow,
    });

    assert.deepEqual(payloads, []);
  });

  it('skips sending and does not rewrite an invalid local install ID', async () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeRawInstallId('not-a-uuid\n');

    const { payloads } = await recordWithSender({
      command: 'ballin update',
      now: fixedNow,
    });

    assert.deepEqual(payloads, []);
    assert.equal(fs.readFileSync(testInstallIdPath, 'utf8'), 'not-a-uuid\n');
  });

  it('returns no install ID when local analytics state cannot be written', () => {
    const blockedParent = path.join(tempDir, 'blocked-parent');
    fs.writeFileSync(blockedParent, 'not a directory\n');
    const installId = ensureAnalyticsInstallId({
      analyticsConfig: { enabled: 'true' },
      env: {},
      generateInstallId: () => fixedInstallId,
      installIdPath: path.join(blockedParent, 'install-id'),
    });

    assert.isNull(installId);
    assert.isFalse(fs.existsSync(path.join(blockedParent, 'install-id')));
  });

  it('uses unknown outside macOS without reading a product version', () => {
    let versionRead = false;
    const payload = buildAnalyticsPayload({
      command: 'ballin',
      durationBucket: '<1s',
      now: fixedNow,
      status: 'success',
    }, fixedInstallId, '2.0.0', {
      platform: () => 'freebsd',
      readCommandOutput: () => {
        versionRead = true;
        return '26.6.2';
      },
    });

    assert.equal(payload.osVersion, 'unknown');
    assert.isFalse(versionRead);
  });

  it('reads a coarse macOS product version without patch detail', () => {
    let call: { command: string; args?: string[]; timeout?: number } | undefined;

    const version = coarseOsVersion({
      platform: () => 'darwin',
      readCommandOutput: (command: string, args?: string[], options?: { timeout?: number }) => {
        call = { command, args, timeout: options?.timeout };
        return '26.6.2\n';
      },
    });

    assert.equal(version, '26.6');
    assert.deepEqual(call, {
      command: '/usr/bin/sw_vers',
      args: ['-productVersion'],
      timeout: 750,
    });
  });

  it('accepts a major-only macOS product version', () => {
    assert.equal(coarseOsVersion({
      platform: () => 'darwin',
      readCommandOutput: () => '26\n',
    }), '26');
  });

  it('uses the default platform collector without reading real version state', () => {
    const originalPlatform = os.platform;
    os.platform = () => 'linux';

    try {
      const payload = buildAnalyticsPayload({
        command: 'ballin',
        durationBucket: '<1s',
        now: fixedNow,
        status: 'success',
      }, fixedInstallId, '2.0.0');

      assert.equal(payload.osVersion, 'unknown');
    } finally {
      os.platform = originalPlatform;
    }
  });

  it('falls back to unknown when macOS product-version collection fails', () => {
    const failures = [
      { name: 'missing command', read: () => null },
      { name: 'failed command', read: () => null },
      { name: 'timed-out command', read: () => null },
      { name: 'empty output', read: () => '\n' },
      { name: 'malformed output', read: () => 'release-candidate' },
      { name: 'malformed minor version', read: () => '26.release' },
    ];

    for (const { name, read } of failures) {
      assert.equal(coarseOsVersion({
        platform: () => 'darwin',
        readCommandOutput: read,
      }), 'unknown', name);
    }
  });

  it('preserves command behavior when macOS product-version collection throws', async () => {
    const payloads: AnalyticsPayload[] = [];
    const previousExitCode = process.exitCode;
    let commandRan = false;

    try {
      await runWithCommandAnalytics('ballin', () => {
        commandRan = true;
        process.exitCode = 23;
      }, {
        analyticsConfig: { enabled: 'true' },
        env: {},
        installId: fixedInstallId,
        osVersionOptions: {
          platform: () => 'darwin',
          readCommandOutput: () => {
            throw new Error('unexpected version lookup failure');
          },
        },
        sender: async (payload: AnalyticsPayload) => {
          payloads.push(payload);
        },
      });

      assert.isTrue(commandRan);
      assert.equal(process.exitCode, 23);
      assert.deepInclude(payloads[0], {
        osVersion: 'unknown',
        status: 'failure',
      });
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('falls back safely when application version metadata is malformed or missing', () => {
    const malformedPackagePath = path.join(tempDir, 'malformed-package.json');
    const invalidVersionPackagePath = path.join(tempDir, 'invalid-version-package.json');
    fs.writeFileSync(malformedPackagePath, '{not json', 'utf8');
    fs.writeFileSync(invalidVersionPackagePath, JSON.stringify({ version: 2 }), 'utf8');

    assert.equal(loadAppVersion(malformedPackagePath), '0.0.0');
    assert.equal(loadAppVersion(invalidVersionPackagePath), '0.0.0');
    assert.equal(loadAppVersion(path.join(tempDir, 'missing-package.json')), '0.0.0');
  });

  it('never throws when analytics config or sender behavior fails', async () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();
    let senderCalled = false;

    await recordAnalyticsEvent({
      command: 'ballin update',
      now: fixedNow,
    }, {
      env: {},
      installIdPath: testInstallIdPath,
      osVersionOptions: fixedOsVersionOptions,
      sender: async () => {
        senderCalled = true;
        throw new Error('network unavailable');
      },
    });

    assert.isTrue(senderCalled);
  });

  it('sends only the allowlisted payload fields', async () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();

    const { payloads } = await recordWithSender({
      command: 'ballin config',
      status: 'failure',
      durationBucket: '1-10s',
      args: ['get', 'backup.id'],
      path: '/Users/example',
      rawError: 'secret',
      now: fixedNow,
    });
    const payload = payloads[0];

    assert.sameMembers(Object.keys(payload), allowedPayloadKeys);
    assert.deepInclude(payload, {
      schemaVersion: 1,
      installId: fixedInstallId,
      dateBucket: '2026-06-27',
      command: 'ballin config',
      status: 'failure',
      durationBucket: '1-10s',
    });
    assert.match(payload.appVersion, /^[0-9]+(?:\.[0-9]+){0,2}$/);
    assert.match(payload.nodeMajor, /^[0-9]+$/);
    assert.match(payload.osVersion, /^[0-9]+(?:\.[0-9]+)?$|^unknown$/);
  });

  it('skips unsupported commands and invalid enum values', async () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();

    const supportedCommands: string[] = [];
    for (const command of topLevelCommandNames) {
      const result = await recordWithSender({
        command: `ballin ${command}`,
        now: fixedNow,
      });
      supportedCommands.push(...result.payloads.map(({ command: recordedCommand }) => recordedCommand));
    }
    const unsupportedCommand = await recordWithSender({
      command: 'git',
      now: fixedNow,
    });
    const unsupportedStatus = await recordWithSender({
      command: 'ballin update',
      status: 'maybe',
      now: fixedNow,
    });
    const unsupportedDuration = await recordWithSender({
      command: 'ballin update',
      durationBucket: '42s',
      now: fixedNow,
    });

    assert.deepEqual(supportedCommands, topLevelCommandNames.map((command: string) => `ballin ${command}`));
    assert.deepEqual(unsupportedCommand.payloads, []);
    assert.deepEqual(unsupportedStatus.payloads, []);
    assert.deepEqual(unsupportedDuration.payloads, []);
  });

  it('buckets command durations coarsely', () => {
    assert.equal(durationBucketFromMs(0), '<1s');
    assert.equal(durationBucketFromMs(999), '<1s');
    assert.equal(durationBucketFromMs(1000), '1-10s');
    assert.equal(durationBucketFromMs(9999), '1-10s');
    assert.equal(durationBucketFromMs(10_000), '10-60s');
    assert.equal(durationBucketFromMs(59_999), '10-60s');
    assert.equal(durationBucketFromMs(60_000), '1-10m');
    assert.equal(durationBucketFromMs(599_999), '1-10m');
    assert.equal(durationBucketFromMs(600_000), '10m+');
  });

  it('records one command-level success event after the command finishes and flushes', async () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();
    const events: string[] = [];
    const payloads: AnalyticsPayload[] = [];
    let currentNow = 10_000;
    let releaseSender = () => {};
    let analyticsSettled = false;
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      const analyticsDone = runWithCommandAnalytics('ballin', () => {
        events.push('command');
        currentNow = 10_800;
      }, {
        endpoint: 'https://analytics.example.test/v1/events',
        env: {},
        installIdPath: testInstallIdPath,
        nowMs: () => currentNow,
        osVersionOptions: fixedOsVersionOptions,
        sender: (payload: AnalyticsPayload) => new Promise<void>((resolve) => {
          events.push('send-start');
          payloads.push(payload);
          releaseSender = () => resolve();
        }),
      });

      void analyticsDone.then(() => {
        analyticsSettled = true;
      });

      assert.deepEqual(events, ['command', 'send-start']);
      await Promise.resolve();
      assert.isFalse(analyticsSettled);
      releaseSender();
      await analyticsDone;
      assert.isTrue(analyticsSettled);
    } finally {
      process.exitCode = previousExitCode;
    }

    assert.deepEqual(events, ['command', 'send-start']);
    assert.deepInclude(payloads[0], {
      command: 'ballin',
      status: 'success',
      durationBucket: '<1s',
    });
  });

  it('records direct backup and self-update commands normally', async () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();
    const payloads: AnalyticsPayload[] = [];

    for (const command of ['ballin backup', 'ballin self-update']) {
      await runWithCommandAnalytics(command, () => {}, {
        analyticsConfig: { enabled: 'true' },
        env: {},
        installIdPath: testInstallIdPath,
        osVersionOptions: fixedOsVersionOptions,
        sender: async (payload: AnalyticsPayload) => {
          payloads.push(payload);
        },
      });
    }

    assert.deepEqual(payloads.map(({ command, status }) => ({ command, status })), [
      { command: 'ballin backup', status: 'success' },
      { command: 'ballin self-update', status: 'success' },
    ]);
  });

  it('records command-level failures from exitCode without changing it', async () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();
    const payloads: AnalyticsPayload[] = [];
    let currentNow = 1000;
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      await runWithCommandAnalytics('ballin', () => {
        currentNow = 13_000;
        process.exitCode = 17;
      }, {
        endpoint: 'https://analytics.example.test/v1/events',
        env: {},
        installIdPath: testInstallIdPath,
        nowMs: () => currentNow,
        osVersionOptions: fixedOsVersionOptions,
        sender: async (payload: AnalyticsPayload) => {
          payloads.push(payload);
        },
      });

      assert.equal(process.exitCode, 17);
    } finally {
      process.exitCode = previousExitCode;
    }

    assert.deepInclude(payloads[0], {
      command: 'ballin',
      status: 'failure',
      durationBucket: '10-60s',
    });
  });

  [
    { args: ['get', 'backup.id'], exitCode: 0, status: 'success' },
    { args: ['get', 'missing-key'], exitCode: 1, status: 'failure' },
    { args: ['wrong'], exitCode: 2, status: 'failure' },
    { args: ['set', 'backup.id'], exitCode: 2, status: 'failure' },
  ].forEach(({ args, exitCode, status }) => {
    it(`records the actual config command status for ${JSON.stringify(args)}`, async () => {
      const result = await runConfigWithAnalytics(args);

      assert.equal(result.exitCode, exitCode);
      assert.lengthOf(result.payloads, 1);
      assert.deepInclude(result.payloads[0], {
        command: 'ballin config',
        status,
        durationBucket: '<1s',
      });
      if (exitCode === 0) {
        assert.equal(result.stdout, 'null\n');
        assert.equal(result.stderr, '');
      } else {
        assert.equal(result.stdout, '');
        assert.isNotEmpty(result.stderr);
      }
    });
  });

  it('preserves a config failure diagnostic and exit status when the analytics sender rejects', async () => {
    const sentPayloads: AnalyticsPayload[] = [];
    const result = await runConfigWithAnalytics(['get', 'missing-key'], {
      sender: async (payload: AnalyticsPayload) => {
        sentPayloads.push(payload);
        throw new Error('network unavailable');
      },
    });

    assert.lengthOf(sentPayloads, 1);
    assert.equal(sentPayloads[0].status, 'failure');
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `ballin config: ${configMessages.getKeysDneErr('missing-key')}\n`);
  });

  it('preserves a malformed-config failure when analytics cannot read consent', async () => {
    fs.writeFileSync(configPath, '{not json\n', 'utf8');

    const result = await runConfigWithAnalytics(['get'], { analyticsConfig: undefined });

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.include(result.stderr, 'Config is not valid JSON.');
    assert.include(result.stderr, 'ballin config reset');
    assert.notInclude(result.stderr, configPath);
    assert.notInclude(result.stderr, 'SyntaxError');
    assert.deepEqual(result.payloads, []);
  });

  it('can preserve local analytics state before a command removes it', async () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();
    const payloads: AnalyticsPayload[] = [];

    await runWithCommandAnalytics('ballin uninstall', () => {
      setAnalyticsConfig({
        enabled: 'false',
      });
      fs.rmSync(testInstallIdPath, { force: true });
    }, {
      endpoint: 'https://analytics.example.test/v1/events',
      env: {},
      installIdPath: testInstallIdPath,
      osVersionOptions: fixedOsVersionOptions,
      preserveLocalState: true,
      sender: async (payload: AnalyticsPayload) => {
        payloads.push(payload);
      },
    });

    assert.deepInclude(payloads[0], {
      command: 'ballin uninstall',
      appVersion: packageJson.version,
      installId: fixedInstallId,
      status: 'success',
    });
  });

  it('isolates command-level status from a stale process exitCode', async () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();
    const payloads: AnalyticsPayload[] = [];
    const previousExitCode = process.exitCode;
    process.exitCode = 17;

    try {
      await runWithCommandAnalytics('ballin self-update', () => {}, {
        endpoint: 'https://analytics.example.test/v1/events',
        env: {},
        installIdPath: testInstallIdPath,
        nowMs: () => 1000,
        osVersionOptions: fixedOsVersionOptions,
        sender: async (payload: AnalyticsPayload) => {
          payloads.push(payload);
        },
      });

      assert.isUndefined(process.exitCode);
    } finally {
      process.exitCode = previousExitCode;
    }

    assert.deepInclude(payloads[0], {
      command: 'ballin self-update',
      status: 'success',
      durationBucket: '<1s',
    });
  });

  it('records command-level failures when the command throws and rejects after flushing', async () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();
    const payloads: AnalyticsPayload[] = [];
    let currentNow = 0;
    let releaseSender = () => {};
    let analyticsSettled = false;
    let rejection: Error | undefined;

    const analyticsDone = runWithCommandAnalytics('ballin', () => {
      currentNow = 60_000;
      throw new Error('simulated command failure');
    }, {
      endpoint: 'https://analytics.example.test/v1/events',
      env: {},
      installIdPath: testInstallIdPath,
      nowMs: () => currentNow,
      osVersionOptions: fixedOsVersionOptions,
      sender: (payload: AnalyticsPayload) => new Promise<void>((resolve) => {
        payloads.push(payload);
        releaseSender = () => resolve();
      }),
    });

    void analyticsDone
      .then(() => {
        analyticsSettled = true;
      })
      .catch((error: Error) => {
        analyticsSettled = true;
        rejection = error;
      });

    await Promise.resolve();
    assert.isFalse(analyticsSettled);
    assert.deepInclude(payloads[0], {
      command: 'ballin',
      status: 'failure',
      durationBucket: '1-10m',
    });
    releaseSender();
    await analyticsDone.catch(() => {});

    assert.isTrue(analyticsSettled);
    assert.equal(rejection?.message, 'simulated command failure');
  });

  it('rethrows command errors through the event loop', () => {
    const originalSetImmediate = global.setImmediate;
    let scheduled: (() => void) | undefined;
    const error = new Error('simulated command failure');

    global.setImmediate = ((callback: () => void) => {
      scheduled = callback;
      return {} as NodeJS.Immediate;
    }) as typeof setImmediate;

    try {
      rethrowCommandError(error);
      assert.isFunction(scheduled);
      assert.throws(() => {
        scheduled?.();
      }, 'simulated command failure');
    } finally {
      global.setImmediate = originalSetImmediate;
    }
  });

  it('sends through https and resolves after the response ends', async () => {
    const originalRequest = https.request;
    let capturedOptions: RequestOptions | null = null;
    let capturedBody = '';
    let timeoutMs = 0;

    https.request = (options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest => {
      capturedOptions = options;
      const request = new EventEmitter() as ClientRequest;
      const response = new EventEmitter() as IncomingMessage;
      response.resume = () => response;
      callback(response);

      request.setTimeout = (milliseconds: number, handler?: () => void) => {
        timeoutMs = milliseconds;
        assert.isFunction(handler);
        return request;
      };
      request.end = ((body?: unknown) => {
        capturedBody = typeof body === 'string' || Buffer.isBuffer(body) ? body.toString() : '';
        response.emit('end');
        return request;
      }) as ClientRequest['end'];
      request.destroy = () => {
        return request;
      };
      return request;
    };

    try {
      await sendAnalyticsPayload({
        schemaVersion: 1,
        installId: fixedInstallId,
        dateBucket: '2026-06-27',
        command: 'ballin',
        status: 'success',
        durationBucket: '<1s',
        appVersion: '1.0.0',
        nodeMajor: '24',
        osVersion: '15',
      }, {
        endpoint: 'https://analytics.example.test/v1/events',
        timeoutMs: 25,
      });
    } finally {
      https.request = originalRequest;
    }

    assert.equal(timeoutMs, 25);
    assert.include(capturedBody, '"command":"ballin"');
    assert.isNotNull(capturedOptions);
    const options = capturedOptions as unknown as RequestOptions;
    assert.deepInclude(options, {
      method: 'POST',
      protocol: 'https:',
      hostname: 'analytics.example.test',
      path: '/v1/events',
    });
    assert.deepInclude(options.headers, {
      'content-type': 'application/json',
    });
    assert.notProperty(options.headers, 'x-ballin-analytics-token');
  });

  it('returns immediately when no analytics endpoint is configured', async () => {
    const originalRequest = https.request;
    let requestCalled = false;
    https.request = (() => {
      requestCalled = true;
      throw new Error('request should not run');
    }) as typeof https.request;
    try {
      await sendAnalyticsPayload({
        schemaVersion: 1,
        installId: fixedInstallId,
        dateBucket: '2026-06-27',
        command: 'ballin',
        status: 'success',
        durationBucket: '<1s',
        appVersion: '1.0.0',
        nodeMajor: '24',
        osVersion: '15',
      }, {});
    } finally {
      https.request = originalRequest;
    }
    assert.isFalse(requestCalled);
  });

  it('swallows synchronous HTTPS request setup failures', async () => {
    const originalRequest = https.request;
    https.request = (() => {
      throw new Error('synchronous TLS setup failure');
    }) as typeof https.request;
    try {
      await sendAnalyticsPayload({
        schemaVersion: 1,
        installId: fixedInstallId,
        dateBucket: '2026-06-27',
        command: 'ballin',
        status: 'success',
        durationBucket: '<1s',
        appVersion: '1.0.0',
        nodeMajor: '24',
        osVersion: '15',
      }, { endpoint: 'https://analytics.example.test/v1/events' });
    } finally {
      https.request = originalRequest;
    }
  });

  it('destroys and settles the request when the socket timeout fires', async () => {
    const originalRequest = https.request;
    let socketTimeout: (() => void) | undefined;
    let destroyed = false;
    https.request = (): ClientRequest => {
      const request = new EventEmitter() as ClientRequest;
      request.setTimeout = (_milliseconds: number, handler?: () => void) => {
        socketTimeout = handler;
        return request;
      };
      request.end = (() => request) as ClientRequest['end'];
      request.destroy = () => {
        destroyed = true;
        return request;
      };
      return request;
    };
    try {
      const done = sendAnalyticsPayload({
        schemaVersion: 1,
        installId: fixedInstallId,
        dateBucket: '2026-06-27',
        command: 'ballin',
        status: 'success',
        durationBucket: '<1s',
        appVersion: '1.0.0',
        nodeMajor: '24',
        osVersion: '15',
      }, { endpoint: 'https://analytics.example.test/v1/events', timeoutMs: 100 });
      assert.isFunction(socketTimeout);
      socketTimeout?.();
      await done;
    } finally {
      https.request = originalRequest;
    }
    assert.isTrue(destroyed);
  });

  it('bounds https sends with a wall-clock timeout and swallows request failures', async () => {
    const originalRequest = https.request;
    let destroyed = false;
    let socketTimeoutRegistered = false;

    https.request = (): ClientRequest => {
      const request = new EventEmitter() as ClientRequest;

      request.setTimeout = (_milliseconds: number, handler?: () => void) => {
        socketTimeoutRegistered = Boolean(handler);
        return request;
      };
      request.end = (() => request) as ClientRequest['end'];
      request.destroy = () => {
        destroyed = true;
        request.emit('error', new Error('simulated request failure'));
        return request;
      };
      return request;
    };

    try {
      const analyticsDone = sendAnalyticsPayload({
        schemaVersion: 1,
        installId: fixedInstallId,
        dateBucket: '2026-06-27',
        command: 'ballin update',
        status: 'success',
        durationBucket: '<1s',
        appVersion: '1.0.0',
        nodeMajor: '24',
        osVersion: '15',
      }, {
        endpoint: 'https://analytics.example.test/v1/events',
        timeoutMs: 1,
      });
      await analyticsDone;
    } finally {
      https.request = originalRequest;
    }

    assert.isTrue(socketTimeoutRegistered);
    assert.isTrue(destroyed);
  });
});
