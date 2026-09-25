const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');
const { configPath } = require('../config/index.ts');
const {
  flushPendingAnalytics,
  recordBehavioralAnalyticsEvent,
  runWithCommandAnalytics,
} = require('../commands/analytics.ts');

const installId = '826f9faa-9995-4f66-a01b-73b4f7aebdf1';
const terminalDate = new Date('2026-09-18T23:59:59.999Z');
const input = { event: 'backup.run', status: 'success', now: terminalDate };
type Payload = Record<string, unknown>;

describe('behavioral analytics client', () => {
  let directory: string;
  let idPath: string;
  let originalConfig: Buffer;
  let originalRequest: typeof https.request;
  let previousExitCode: typeof process.exitCode;
  let payloads: Payload[];
  let networkCalls: number;

  const runtime = (overrides: Record<string, unknown> = {}) => ({
    env: {},
    installIdPath: idPath,
    osVersionOptions: { platform: () => 'linux' },
    sender: async (payload: Payload) => { payloads.push(payload); },
    ...overrides,
  });

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-behavioral-'));
    idPath = path.join(directory, 'install-id');
    fs.writeFileSync(idPath, `${installId}\n`);
    originalConfig = fs.readFileSync(configPath);
    fs.writeFileSync(configPath, JSON.stringify({ analytics: { enabled: 'true' } }));
    previousExitCode = process.exitCode;
    payloads = [];
    networkCalls = 0;
    originalRequest = https.request;
    https.request = () => {
      networkCalls += 1;
      throw new Error('Unexpected default analytics sender');
    };
  });

  afterEach(async () => {
    await flushPendingAnalytics();
    https.request = originalRequest;
    process.exitCode = previousExitCode;
    fs.writeFileSync(configPath, originalConfig);
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(networkCalls, 0, 'injected senders must intercept every event');
  });

  it('sends only the exact v2 shape for all six terminal outcomes without runtime collection', async () => {
    for (const event of ['backup.run', 'update.backup', 'update.self-update']) {
      for (const status of ['success', 'failure']) {
        await recordBehavioralAnalyticsEvent({ ...input, event, status, command: 'secret', origin: 'secret' }, runtime({
          appVersion: 'private-version',
          osVersionOptions: { platform: () => { throw new Error('Behavior must not collect runtime data'); } },
        }));
        assert.deepEqual(payloads.at(-1), {
          schemaVersion: 2, installId, dateBucket: '2026-09-18', event, status,
        });
      }
    }
    assert.lengthOf(payloads, 6);
  });

  it('captures terminal date and eligibility before deferring transmission', async () => {
    const now = new Date(terminalDate);
    const env: NodeJS.ProcessEnv = {};
    let senderOptions: unknown;
    const pending = recordBehavioralAnalyticsEvent({ ...input, now }, runtime({
      env,
      sender: async (payload: Payload, options: unknown) => {
        payloads.push(payload);
        senderOptions = options;
      },
    }));
    assert.deepEqual(payloads, []);
    now.setUTCDate(now.getUTCDate() + 1);
    env.BALLIN_NO_ANALYTICS = '1';
    fs.writeFileSync(configPath, JSON.stringify({ analytics: { enabled: 'false' } }));
    fs.unlinkSync(idPath);
    await pending;
    assert.equal(payloads[0].dateBucket, '2026-09-18');
    assert.deepEqual(senderOptions, {
      endpoint: 'https://ballin-scripts-analytics.jballin.workers.dev/v1/events', timeoutMs: 750,
    });
  });

  it('suppresses behavioral sends for hard opt-outs and CI but ignores command-only suppression', async () => {
    for (const env of [{ BALLIN_NO_ANALYTICS: '1' }, { CI: 'true' }, { CI: 'false' }]) {
      await recordBehavioralAnalyticsEvent(input, runtime({ env }));
    }
    assert.deepEqual(payloads, []);
    await recordBehavioralAnalyticsEvent(input, runtime({ env: { BALLIN_NO_COMMAND_ANALYTICS: '1' } }));
    assert.lengthOf(payloads, 1);
    await recordBehavioralAnalyticsEvent(input, runtime({ env: undefined }));
    assert.lengthOf(payloads, 1, 'the default harness hard opt-out must also apply');
  });

  it('consumes only the current valid local preference and fails closed for malformed config', async () => {
    for (const analytics of [undefined, null, false, [], {}, { enabled: false }, { enabled: true }, { enabled: 'false' }, { enabled: 'yes' }]) {
      fs.writeFileSync(configPath, JSON.stringify({ analytics }));
      await recordBehavioralAnalyticsEvent(input, runtime());
    }
    fs.writeFileSync(configPath, '{not json');
    await recordBehavioralAnalyticsEvent(input, runtime());
    fs.unlinkSync(configPath);
    await recordBehavioralAnalyticsEvent(input, runtime());
    assert.deepEqual(payloads, []);
    fs.writeFileSync(configPath, JSON.stringify({ analytics: { enabled: 'true' } }));
    await recordBehavioralAnalyticsEvent(input, runtime());
    assert.lengthOf(payloads, 1);
  });

  it('never creates or repairs an installation identity for a behavioral send', async () => {
    fs.unlinkSync(idPath);
    await recordBehavioralAnalyticsEvent(input, runtime());
    assert.deepEqual(fs.readdirSync(directory), []);
    fs.writeFileSync(idPath, 'invalid-id\n');
    await recordBehavioralAnalyticsEvent(input, runtime());
    assert.equal(fs.readFileSync(idPath, 'utf8'), 'invalid-id\n');
    assert.deepEqual(fs.readdirSync(directory), ['install-id']);
    assert.deepEqual(payloads, []);
    for (const invalid of [null, '', 'not-a-uuid', installId.toUpperCase()]) {
      await recordBehavioralAnalyticsEvent(input, runtime({ installId: invalid }));
    }
    assert.deepEqual(payloads, []);
  });

  it('rejects unsupported event names, nonterminal statuses, and invalid terminal dates', async () => {
    for (const event of ['', 'backup', 'backup.read', 'update.readiness', 'doctor', 'update.npm']) {
      await recordBehavioralAnalyticsEvent({ ...input, event }, runtime());
    }
    for (const status of ['', 'unknown', 'attempted', 'skipped', 'partial']) {
      await recordBehavioralAnalyticsEvent({ ...input, status }, runtime());
    }
    await recordBehavioralAnalyticsEvent({ ...input, now: new Date(NaN) }, runtime());
    assert.deepEqual(payloads, []);
  });

  it('uses the current UTC bucket when no time is supplied and preserves explicit transport options', async () => {
    const dates = [new Date().toISOString().slice(0, 10)];
    let options: unknown;
    await recordBehavioralAnalyticsEvent({ event: 'update.backup', status: 'failure' }, runtime({
      installId,
      endpoint: 'https://example.test/v1/events', timeoutMs: 17,
      sender: async (payload: Payload, senderOptions: unknown) => {
        payloads.push(payload);
        options = senderOptions;
      },
    }));
    dates.push(new Date().toISOString().slice(0, 10));
    assert.include(dates, payloads[0].dateBucket);
    assert.deepEqual(options, { endpoint: 'https://example.test/v1/events', timeoutMs: 17 });
  });

  it('swallows both synchronous sender throws and rejected sends', async () => {
    for (const sender of [
      () => { throw new Error('sender threw'); },
      () => Promise.reject(new Error('sender rejected')),
    ]) {
      process.exitCode = 23;
      await recordBehavioralAnalyticsEvent(input, runtime({ sender }));
      assert.equal(process.exitCode, 23);
    }
  });

  it('defers behavioral sending until later synchronous stages finish and awaits both event categories', async () => {
    const stages: string[] = [];
    const releases: Array<() => void> = [];
    let settled = false;
    const done = runWithCommandAnalytics('ballin update', () => {
      stages.push('self-update');
      void recordBehavioralAnalyticsEvent({ ...input, event: 'update.self-update' });
      stages.push('readiness');
      void recordBehavioralAnalyticsEvent({ ...input, event: 'update.backup' });
      stages.push('backup');
      process.exitCode = 7;
    }, runtime({ sender: (payload: Payload) => new Promise<void>((resolve) => {
      payloads.push(payload);
      releases.push(resolve);
      if (payload.schemaVersion === 2) assert.deepEqual(stages, ['self-update', 'readiness', 'backup']);
    }) })).then(() => { settled = true; });
    await Promise.resolve();
    assert.lengthOf(payloads, 3);
    assert.isFalse(settled);
    releases[0]();
    releases[1]();
    await Promise.resolve();
    assert.isFalse(settled);
    releases[2]();
    await done;
    assert.isTrue(settled);
    assert.equal(process.exitCode, 7);
    assert.deepEqual(payloads.filter((payload) => payload.schemaVersion === 2).map(({ event, status }) => ({ event, status })), [
      { event: 'update.self-update', status: 'success' }, { event: 'update.backup', status: 'success' },
    ]);
    assert.equal(payloads.find((payload) => payload.schemaVersion === 1)?.status, 'failure');
  });

  it('still drains behavior when command analytics are suppressed and restores the caller runtime', async () => {
    await runWithCommandAnalytics('ballin backup', () => {
      void recordBehavioralAnalyticsEvent(input);
    }, runtime({ env: { BALLIN_NO_COMMAND_ANALYTICS: '1' } }));
    assert.lengthOf(payloads, 1);
    assert.equal(payloads[0].schemaVersion, 2);
    // Outside the synchronous command scope, the harness hard opt-out applies again.
    await recordBehavioralAnalyticsEvent(input);
    assert.lengthOf(payloads, 1);
  });

  it('retains the original thrown value while draining a rejected behavioral send', async () => {
    const originalError = new Error('original command failure');
    const attempted: Payload[] = [];
    await runWithCommandAnalytics('ballin backup', () => {
      void recordBehavioralAnalyticsEvent({ ...input, status: 'failure' });
      process.exitCode = 19;
      throw originalError;
    }, runtime({ sender: (payload: Payload) => {
      attempted.push(payload);
      return Promise.reject(new Error('send failure'));
    } })).then(
      () => assert.fail('expected the original error'),
      (caught: unknown) => assert.strictEqual(caught, originalError),
    );
    assert.lengthOf(attempted, 2);
    assert.isTrue(attempted.every(({ status }) => status === 'failure'));
    assert.equal(process.exitCode, 19);
    await recordBehavioralAnalyticsEvent(input);
    assert.lengthOf(attempted, 2);
  });

  it('bounds the production transport for a stalled behavioral request', async () => {
    let destroyed = false;
    https.request = () => {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.end = (body: string) => { payloads.push(JSON.parse(body)); };
      request.destroy = () => { destroyed = true; };
      return request;
    };
    const startedAt = Date.now();
    await recordBehavioralAnalyticsEvent(input, runtime({ sender: undefined, timeoutMs: 5 }));
    assert.isTrue(destroyed);
    assert.isBelow(Date.now() - startedAt, 1000);
    assert.deepEqual(payloads, [{ schemaVersion: 2, installId, dateBucket: '2026-09-18', event: 'backup.run', status: 'success' }]);
  });

  it('ignores response-stream errors without changing the command exit status', async () => {
    https.request = (_options: unknown, callback: (response: unknown) => void) => {
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.destroy = () => request;
      request.end = () => {
        setImmediate(() => {
          const response = new EventEmitter();
          response.resume = () => setImmediate(() => response.emit('error', new Error('response aborted')));
          callback(response);
        });
      };
      return request;
    };
    process.exitCode = 23;
    await recordBehavioralAnalyticsEvent(input, runtime({ sender: undefined }));
    assert.equal(process.exitCode, 23);
  });
});
