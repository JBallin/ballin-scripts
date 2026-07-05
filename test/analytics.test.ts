const { assert } = require('chai');
const { EventEmitter } = require('events');
const https = require('https');
const { fetchConfig, configPath, stringify } = require('../config/index.ts');
const {
  analyticsDisabledByEnv,
  durationBucketFromMs,
  recordAnalyticsEvent,
  rethrowCommandError,
  runWithCommandAnalytics,
  sendAnalyticsPayload,
} = require('../commands/analytics.ts');

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
  os: string;
  osVersion: string;
};

type SenderOptions = {
  endpoint?: string;
  ingestToken?: string;
  timeoutMs?: number;
};

const fs = require('fs');
const os = require('os');
const path = require('path');
const packageJson = require('../package.json');
const fixedInstallId = '826f9faa-9995-4f66-a01b-73b4f7aebdf1';
const fixedNow = new Date('2026-06-27T20:15:00.000Z');
const allowedPayloadKeys = [
  'schemaVersion',
  'installId',
  'dateBucket',
  'command',
  'status',
  'durationBucket',
  'appVersion',
  'nodeMajor',
  'os',
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
): Promise<{ payloads: AnalyticsPayload[]; notices: string[]; order: string[] }> => {
  const payloads: AnalyticsPayload[] = [];
  const notices: string[] = [];
  const order: string[] = [];

  return recordAnalyticsEvent(input, {
    endpoint: 'https://analytics.example.test/v1/events',
    ingestToken: 'test-token',
    env: {},
    installIdPath: testInstallIdPath,
    sender: async (payload: AnalyticsPayload) => {
      order.push('send');
      payloads.push(payload);
    },
    noticeWriter: (message: string) => {
      order.push('notice');
      notices.push(message);
    },
    ...runtime,
  }).then(() => {
    return { payloads, notices, order };
  });
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
    assert.isFalse(analyticsDisabledByEnv({ BALLIN_NO_ANALYTICS: '0' }));
  });

  it('does not send when analytics are disabled in config', async () => {
    setAnalyticsConfig({
      enabled: 'false',
    });
    writeInstallId();

    const { payloads, notices } = await recordWithSender({
      command: 'up',
      now: fixedNow,
    });

    assert.deepEqual(payloads, []);
    assert.deepEqual(notices, []);
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
        command: 'up',
        now: fixedNow,
      }, { env });

      assert.deepEqual(payloads, []);
    }
  });

  it('reads the local install ID and includes it in the payload', async () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();

    const { payloads, notices, order } = await recordWithSender({
      command: 'ballin',
      status: 'success',
      durationBucket: '<1s',
      now: fixedNow,
    });
    const updatedAnalytics = fetchConfig().configObj.analytics;

    assert.deepEqual(order, ['send']);
    assert.deepEqual(notices, []);
    assert.lengthOf(payloads, 1);
    assert.equal(payloads[0].installId, fixedInstallId);
    assert.deepEqual(updatedAnalytics, {
      enabled: 'true',
    });
  });

  it('uses production endpoint and token defaults when runtime overrides are absent', async () => {
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
      sender: async (_payload: AnalyticsPayload, options: SenderOptions) => {
        senderOptions.push(options);
      },
    });

    assert.deepInclude(senderOptions[0], {
      endpoint: 'https://ballin-scripts-analytics.jballin.workers.dev/v1/events',
      ingestToken: '6jC_OqsMynyQc3FKXgUN7aP3bbDQ_H_DMhGDrw7t6RE',
    });
  });

  it('skips sending when the local install ID is missing', async () => {
    setAnalyticsConfig({
      enabled: 'true',
    });

    const { payloads, notices } = await recordWithSender({
      command: 'up',
      now: fixedNow,
    });

    assert.deepEqual(payloads, []);
    assert.deepEqual(notices, []);
  });

  it('skips sending and does not rewrite an invalid local install ID', async () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeRawInstallId('not-a-uuid\n');

    const { payloads, notices } = await recordWithSender({
      command: 'up',
      now: fixedNow,
    });

    assert.deepEqual(payloads, []);
    assert.deepEqual(notices, []);
    assert.equal(fs.readFileSync(testInstallIdPath, 'utf8'), 'not-a-uuid\n');
  });

  it('never throws when analytics config or sender behavior fails', async () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();

    await recordAnalyticsEvent({
      command: 'up',
      now: fixedNow,
    }, {
      installIdPath: testInstallIdPath,
      sender: async () => {
        throw new Error('network unavailable');
      },
    });
  });

  it('sends only the allowlisted payload fields', async () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();

    const { payloads } = await recordWithSender({
      command: 'ballin_config',
      status: 'failure',
      durationBucket: '1-10s',
      args: ['get', 'gu.id'],
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
      command: 'ballin_config',
      status: 'failure',
      durationBucket: '1-10s',
    });
    assert.match(payload.appVersion, /^[0-9]+(?:\.[0-9]+){0,2}$/);
    assert.match(payload.nodeMajor, /^[0-9]+$/);
    assert.include(['darwin', 'linux', 'win32', 'unknown'], payload.os);
    assert.match(payload.osVersion, /^[0-9]+(?:\.[0-9]+)?$|^unknown$/);
  });

  it('skips unsupported commands and invalid enum values', async () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();

    const supportedCanonicalSubcommand = await recordWithSender({
      command: 'ballin update',
      now: fixedNow,
    });
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

    assert.deepEqual(supportedCanonicalSubcommand.payloads.map(({ command }) => command), ['ballin update']);
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
        ingestToken: 'test-token',
        env: {},
        installIdPath: testInstallIdPath,
        nowMs: () => currentNow,
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
        ingestToken: 'test-token',
        env: {},
        installIdPath: testInstallIdPath,
        nowMs: () => currentNow,
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
      ingestToken: 'test-token',
      env: {},
      installIdPath: testInstallIdPath,
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
      await runWithCommandAnalytics('ballin_update', () => {}, {
        endpoint: 'https://analytics.example.test/v1/events',
        ingestToken: 'test-token',
        env: {},
        installIdPath: testInstallIdPath,
        nowMs: () => 1000,
        sender: async (payload: AnalyticsPayload) => {
          payloads.push(payload);
        },
      });

      assert.isUndefined(process.exitCode);
    } finally {
      process.exitCode = previousExitCode;
    }

    assert.deepInclude(payloads[0], {
      command: 'ballin_update',
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
      ingestToken: 'test-token',
      env: {},
      installIdPath: testInstallIdPath,
      nowMs: () => currentNow,
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
        os: 'darwin',
        osVersion: '15',
      }, {
        endpoint: 'https://analytics.example.test/v1/events',
        ingestToken: 'test-token',
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
      'x-ballin-analytics-token': 'test-token',
    });
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
        command: 'up',
        status: 'success',
        durationBucket: '<1s',
        appVersion: '1.0.0',
        nodeMajor: '24',
        os: 'darwin',
        osVersion: '15',
      }, {
        endpoint: 'https://analytics.example.test/v1/events',
        ingestToken: 'test-token',
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
