const { assert } = require('chai');
const { EventEmitter } = require('events');
const https = require('https');
const { fetchConfig, configPath, stringify } = require('../config/index.ts');
const {
  analyticsDisabledByEnv,
  durationBucketFromMs,
  recordAnalyticsEvent,
  runWithCommandAnalytics,
  sendAnalyticsPayload,
} = require('../commands/analytics.ts');

import type { ClientRequest, IncomingMessage } from 'http';
import type { RequestOptions } from 'https';
import type { Socket } from 'net';

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

const fs = require('fs');
const os = require('os');
const path = require('path');
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
): { payloads: AnalyticsPayload[]; notices: string[]; order: string[] } => {
  const payloads: AnalyticsPayload[] = [];
  const notices: string[] = [];
  const order: string[] = [];

  recordAnalyticsEvent(input, {
    endpoint: 'https://analytics.example.test/v1/events',
    ingestToken: 'test-token',
    env: {},
    installIdPath: testInstallIdPath,
    sender: (payload: AnalyticsPayload) => {
      order.push('send');
      payloads.push(payload);
    },
    noticeWriter: (message: string) => {
      order.push('notice');
      notices.push(message);
    },
    ...runtime,
  });

  return { payloads, notices, order };
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

  it('does not send when analytics are disabled in config', () => {
    setAnalyticsConfig({
      enabled: 'false',
    });
    writeInstallId();

    const { payloads, notices } = recordWithSender({
      command: 'up',
      now: fixedNow,
    });

    assert.deepEqual(payloads, []);
    assert.deepEqual(notices, []);
  });

  it('does not send when environment opt-outs are set', () => {
    const optOuts = [
      { BALLIN_NO_ANALYTICS: '1' },
      { CI: 'true' },
    ];

    optOuts.forEach((env) => {
      setAnalyticsConfig({
        enabled: 'true',
      });
      writeInstallId();

      const { payloads } = recordWithSender({
        command: 'up',
        now: fixedNow,
      }, { env });

      assert.deepEqual(payloads, []);
    });
  });

  it('reads the local install ID and includes it in the payload', () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();

    const { payloads, notices, order } = recordWithSender({
      command: 'up',
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

  it('skips sending when the local install ID is missing', () => {
    setAnalyticsConfig({
      enabled: 'true',
    });

    const { payloads, notices } = recordWithSender({
      command: 'up',
      now: fixedNow,
    });

    assert.deepEqual(payloads, []);
    assert.deepEqual(notices, []);
  });

  it('skips sending and does not rewrite an invalid local install ID', () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeRawInstallId('not-a-uuid\n');

    const { payloads, notices } = recordWithSender({
      command: 'up',
      now: fixedNow,
    });

    assert.deepEqual(payloads, []);
    assert.deepEqual(notices, []);
    assert.equal(fs.readFileSync(testInstallIdPath, 'utf8'), 'not-a-uuid\n');
  });

  it('never throws when analytics config or sender behavior fails', () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();

    assert.doesNotThrow(() => {
      recordAnalyticsEvent({
        command: 'up',
        now: fixedNow,
      }, {
        installIdPath: testInstallIdPath,
        sender: () => {
          throw new Error('network unavailable');
        },
      });
    });
  });

  it('sends only the allowlisted payload fields', () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();

    const { payloads } = recordWithSender({
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

  it('skips unsupported commands and invalid enum values', () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();

    const unsupportedCommand = recordWithSender({
      command: 'git',
      now: fixedNow,
    });
    const unsupportedStatus = recordWithSender({
      command: 'up',
      status: 'maybe',
      now: fixedNow,
    });
    const unsupportedDuration = recordWithSender({
      command: 'up',
      durationBucket: '42s',
      now: fixedNow,
    });

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

  it('records one command-level success event after the command finishes', () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();
    const events: string[] = [];
    const payloads: AnalyticsPayload[] = [];
    let currentNow = 10_000;
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      runWithCommandAnalytics('ballin', () => {
        events.push('command');
        currentNow = 10_800;
      }, {
        endpoint: 'https://analytics.example.test/v1/events',
        ingestToken: 'test-token',
        env: {},
        installIdPath: testInstallIdPath,
        nowMs: () => currentNow,
        sender: (payload: AnalyticsPayload) => {
          events.push('send');
          payloads.push(payload);
        },
      });
    } finally {
      process.exitCode = previousExitCode;
    }

    assert.deepEqual(events, ['command', 'send']);
    assert.deepInclude(payloads[0], {
      command: 'ballin',
      status: 'success',
      durationBucket: '<1s',
    });
  });

  it('records command-level failures from exitCode without changing it', () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();
    const payloads: AnalyticsPayload[] = [];
    let currentNow = 1000;
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      runWithCommandAnalytics('gu', () => {
        currentNow = 13_000;
        process.exitCode = 17;
      }, {
        endpoint: 'https://analytics.example.test/v1/events',
        ingestToken: 'test-token',
        env: {},
        installIdPath: testInstallIdPath,
        nowMs: () => currentNow,
        sender: (payload: AnalyticsPayload) => {
          payloads.push(payload);
        },
      });

      assert.equal(process.exitCode, 17);
    } finally {
      process.exitCode = previousExitCode;
    }

    assert.deepInclude(payloads[0], {
      command: 'gu',
      status: 'failure',
      durationBucket: '10-60s',
    });
  });

  it('isolates command-level status from a stale process exitCode', () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();
    const payloads: AnalyticsPayload[] = [];
    const previousExitCode = process.exitCode;
    process.exitCode = 17;

    try {
      runWithCommandAnalytics('ballin_update', () => {}, {
        endpoint: 'https://analytics.example.test/v1/events',
        ingestToken: 'test-token',
        env: {},
        installIdPath: testInstallIdPath,
        nowMs: () => 1000,
        sender: (payload: AnalyticsPayload) => {
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

  it('records command-level failures when the command throws and rethrows', () => {
    setAnalyticsConfig({
      enabled: 'true',
    });
    writeInstallId();
    const payloads: AnalyticsPayload[] = [];
    let currentNow = 0;

    assert.throws(() => {
      runWithCommandAnalytics('up', () => {
        currentNow = 60_000;
        throw new Error('simulated command failure');
      }, {
        endpoint: 'https://analytics.example.test/v1/events',
        ingestToken: 'test-token',
        env: {},
        installIdPath: testInstallIdPath,
        nowMs: () => currentNow,
        sender: (payload: AnalyticsPayload) => {
          payloads.push(payload);
        },
      });
    }, 'simulated command failure');

    assert.deepInclude(payloads[0], {
      command: 'up',
      status: 'failure',
      durationBucket: '1-10m',
    });
  });

  it('sends through https with a short timeout and swallows request failures', () => {
    const originalRequest = https.request;
    let capturedOptions: RequestOptions | null = null;
    let capturedBody = '';
    let timeoutMs = 0;
    const timeoutHandler: { current?: () => void } = {};
    let destroyed = false;
    let socketUnrefCalled = false;

    https.request = (options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest => {
      capturedOptions = options;
      const response = new EventEmitter() as IncomingMessage;
      response.resume = () => response;
      callback(response);

      const request = new EventEmitter() as ClientRequest;
      request.setTimeout = (milliseconds: number, handler?: () => void) => {
        timeoutMs = milliseconds;
        timeoutHandler.current = handler;
        return request;
      };
      request.end = ((body?: unknown) => {
        capturedBody = typeof body === 'string' || Buffer.isBuffer(body) ? body.toString() : '';
        const socket = {
          unref: () => {
            socketUnrefCalled = true;
            return socket;
          },
        } as Socket;
        request.emit('socket', socket);
        return request;
      }) as ClientRequest['end'];
      request.destroy = () => {
        destroyed = true;
        return request;
      };
      return request;
    };

    try {
      sendAnalyticsPayload({
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
        timeoutMs: 25,
      });
      if (timeoutHandler.current) {
        timeoutHandler.current();
      }
    } finally {
      https.request = originalRequest;
    }

    assert.equal(timeoutMs, 25);
    assert.isTrue(destroyed);
    assert.isTrue(socketUnrefCalled);
    assert.include(capturedBody, '"command":"up"');
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
});
