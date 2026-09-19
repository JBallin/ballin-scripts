const {
  buildAnalyticsPayload,
} = require('../commands/analytics.ts');
const {
  analyticsCommandForBallinArgs,
} = require('../commands/ballin.ts');
const {
  topLevelCommandNames,
} = require('../commands/top_level_commands.ts');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

type StatementRun = {
  query: string;
  values: unknown[];
};

type MakeEnvOptions = {
  batchError?: Error;
  hashSecret?: string;
  rateLimiter?: boolean;
  rateLimitFailure?: (key: string) => boolean;
};

type EventRequestOptions = {
  headers?: Record<string, string>;
  legacyToken?: boolean;
  sourceIp?: string;
};

type ControlledBody = {
  body: ReadableStream<Uint8Array>;
  state: {
    cancellations: number;
    deliveredBytes: number;
    pulls: number;
    remainingBytes: number;
  };
};

type ControlledBodyOptions = {
  maxBytesPerPull?: number;
};

class TestStatement {
  query: string;
  values: unknown[] = [];

  constructor(query: string) {
    this.query = query;
  }

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async run() {
    return {};
  }
}

const makeEnv = (options: MakeEnvOptions = {}) => {
  const rateLimitKeys: string[] = [];
  const runs: StatementRun[] = [];
  const rateLimiter = options.rateLimiter === false ? {} : {
    ANALYTICS_RATE_LIMITER: {
      async limit({ key }: { key: string }) {
        rateLimitKeys.push(key);
        return { success: !options.rateLimitFailure?.(key) };
      },
    },
  };
  return {
    env: {
      ANALYTICS_DB: {
        prepare(query: string) {
          return new TestStatement(query);
        },
        async batch(statements: TestStatement[]) {
          if (options.batchError) {
            throw options.batchError;
          }
          statements.forEach((statement) => {
            runs.push({
              query: statement.query,
              values: statement.values,
            });
          });
          return [];
        },
      },
      ...rateLimiter,
      INSTALL_ID_HASH_SECRET: options.hashSecret ?? 'test-secret',
    },
    rateLimitKeys,
    runs,
  };
};

const payloadForCommand = (command: string) => ({
  schemaVersion: 1,
  installId: '826f9faa-9995-4f66-a01b-73b4f7aebdf1',
  dateBucket: new Date().toISOString().slice(0, 10),
  command,
  status: 'success',
  durationBucket: '<1s',
  appVersion: '1.0.0',
  nodeMajor: '24',
  osVersion: '26.6',
});

const payloadForBehavior = (event = 'backup.run', status = 'success') => ({
  schemaVersion: 2,
  installId: '826f9faa-9995-4f66-a01b-73b4f7aebdf1',
  dateBucket: new Date().toISOString().slice(0, 10),
  event,
  status,
});

const eventRequest = (
  payload: Record<string, unknown> | string,
  options: EventRequestOptions = {},
) => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...options.headers,
  };
  if (options.legacyToken) {
    headers['x-ballin-analytics-token'] = 'test-token';
  }
  if (options.sourceIp) {
    headers['cf-connecting-ip'] = options.sourceIp;
  }

  return new Request('https://analytics.example.test/v1/events', {
    method: 'POST',
    headers,
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
};

const controlledBody = (
  chunks: Uint8Array[],
  options: ControlledBodyOptions = {},
): ControlledBody => {
  const remaining = [...chunks];
  const state = {
    cancellations: 0,
    deliveredBytes: 0,
    pulls: 0,
    remainingBytes: remaining.reduce((total, chunk) => total + chunk.byteLength, 0),
  };
  const source: UnderlyingByteSource = {
    type: 'bytes',
    pull(controller) {
      state.pulls += 1;
      const chunk = remaining[0];
      if (!chunk) {
        const byobRequest = controller.byobRequest;
        controller.close();
        byobRequest?.respond(0);
        return;
      }

      const byobRequest = controller.byobRequest;
      const byobView = byobRequest?.view;
      if (byobRequest && byobView) {
        const requested = new Uint8Array(
          byobView.buffer,
          byobView.byteOffset,
          byobView.byteLength,
        );
        const deliveredByteLength = Math.min(
          requested.byteLength,
          chunk.byteLength,
          options.maxBytesPerPull ?? chunk.byteLength,
        );
        requested.set(chunk.subarray(0, deliveredByteLength));
        if (deliveredByteLength === chunk.byteLength) {
          remaining.shift();
        } else {
          remaining[0] = chunk.subarray(deliveredByteLength);
        }
        state.deliveredBytes += deliveredByteLength;
        state.remainingBytes -= deliveredByteLength;
        byobRequest.respond(deliveredByteLength);
        return;
      }

      const deliveredByteLength = Math.min(
        chunk.byteLength,
        options.maxBytesPerPull ?? chunk.byteLength,
      );
      if (deliveredByteLength === chunk.byteLength) {
        remaining.shift();
      } else {
        remaining[0] = chunk.subarray(deliveredByteLength);
      }
      state.deliveredBytes += deliveredByteLength;
      state.remainingBytes -= deliveredByteLength;
      controller.enqueue(new Uint8Array(chunk.subarray(0, deliveredByteLength)));
    },
    cancel() {
      state.cancellations += 1;
    },
  };
  const body = new ReadableStream(source, { highWaterMark: 0 });

  return { body, state };
};

const streamedEventRequest = (
  body: ReadableStream<Uint8Array>,
  options: EventRequestOptions = {},
) => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...options.headers,
  };
  if (options.sourceIp) {
    headers['cf-connecting-ip'] = options.sourceIp;
  }

  return new Request('https://analytics.example.test/v1/events', {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
};

describe('analytics Worker', () => {
  it('accepts the root event and every supported top-level command', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const commands = ['ballin', ...topLevelCommandNames.map((command: string) => `ballin ${command}`)];

    for (const command of commands) {
      const { env } = makeEnv();
      const response = await worker.fetch(eventRequest(payloadForCommand(command)), env);
      assert.equal(response.status, 204, command);
    }
  });

  it('accepts the current client payload for a canonical command', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, runs } = makeEnv();
    const command = analyticsCommandForBallinArgs(['doctor', '--verbose']);
    const now = new Date();
    const payload = buildAnalyticsPayload({
      command,
      status: 'success',
      durationBucket: '<1s',
      now,
    }, '826f9faa-9995-4f66-a01b-73b4f7aebdf1', '2.0.0', {
      platform: () => 'darwin',
      readCommandOutput: () => '26.6.2\n',
    });

    const response = await worker.fetch(eventRequest(payload), env);

    assert.equal(command, 'ballin doctor');
    assert.equal(payload.osVersion, '26.6');
    assert.equal(response.status, 204);
    assert.includeDeepMembers(runs.map(({ values }) => values), [
      [payload.dateBucket, 'ballin doctor', 'success', '<1s'],
    ]);
  });

  it('accepts valid unauthenticated events and stores only aggregate fields', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, rateLimitKeys, runs } = makeEnv();
    const payload = payloadForCommand('ballin update');

    const response = await worker.fetch(eventRequest(payload, { sourceIp: '203.0.113.7' }), env);

    assert.equal(response.status, 204);
    assert.deepEqual(rateLimitKeys.slice(0, 2), [
      'v1-events:global',
      'v1-events:source:203.0.113.7',
    ]);
    assert.match(rateLimitKeys[2], /^v1-events:install:[0-9a-f]{64}$/);
    assert.includeDeepMembers(runs.map(({ values }) => values), [
      [payload.dateBucket, 'ballin update', '1.0.0', '24', '26.6'],
    ]);
    assert.notInclude(runs.flatMap(({ values }) => values), '203.0.113.7');
  });

  it('stores every behavioral event and terminal outcome only in its identity-free aggregate', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;

    for (const event of ['backup.run', 'update.backup', 'update.self-update']) {
      for (const status of ['success', 'failure']) {
        const { env, rateLimitKeys, runs } = makeEnv();
        const payload = payloadForBehavior(event, status);
        const response = await worker.fetch(eventRequest(payload, { sourceIp: '203.0.113.7' }), env);

        assert.equal(response.status, 204, `${event} ${status}`);
        assert.lengthOf(runs, 1);
        assert.include(runs[0].query, 'INSERT INTO behavior_events_daily (date_bucket, event, status, count)');
        assert.include(runs[0].query, 'ON CONFLICT(date_bucket, event, status)');
        assert.include(runs[0].query, 'DO UPDATE SET count = count + 1');
        assert.deepEqual(runs[0].values, [payload.dateBucket, event, status]);
        assert.notMatch(JSON.stringify(runs), /install_id|install_days|command_events_daily|version_events_daily/);
        assert.notInclude(JSON.stringify(runs), payload.installId);
        assert.notInclude(JSON.stringify(runs), '203.0.113.7');
        assert.match(rateLimitKeys[2], /^v1-events:install:[0-9a-f]{64}$/);
        assert.notInclude(JSON.stringify(runs), rateLimitKeys[2].split(':')[2]);
      }
    }
  });

  it('shares all abuse-limit keys across command and behavioral schemas', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, rateLimitKeys, runs } = makeEnv();

    const commandResponse = await worker.fetch(eventRequest(payloadForCommand('ballin backup'), {
      sourceIp: '203.0.113.7',
    }), env);
    const behaviorResponse = await worker.fetch(eventRequest(payloadForBehavior(), {
      sourceIp: '203.0.113.7',
    }), env);

    assert.equal(commandResponse.status, 204);
    assert.equal(behaviorResponse.status, 204);
    assert.deepEqual(rateLimitKeys.slice(0, 3), rateLimitKeys.slice(3));
    assert.lengthOf(runs, 4);
    assert.include(runs[0].query, 'INSERT OR IGNORE INTO install_days');
    assert.include(runs[1].query, 'INSERT INTO command_events_daily');
    assert.include(runs[2].query, 'INSERT INTO version_events_daily');
    assert.include(runs[3].query, 'INSERT INTO behavior_events_daily');
  });

  it('increments behavioral SQL counts without changing existing installation, command, or runtime aggregates', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, runs } = makeEnv();
    const database = new DatabaseSync(':memory:');
    const migrationsDir = path.join(__dirname, '..', 'analytics-worker', 'migrations');
    const applyRuns = (statements: StatementRun[]) => {
      for (const { query, values } of statements) {
        database.prepare(query).run(Object.fromEntries(values.map((value, index) => [`?${index + 1}`, value])));
      }
    };
    const existingTables = ['install_days', 'command_events_daily', 'version_events_daily'];
    const existingRows = () => existingTables.map((table) => database.prepare(`SELECT * FROM ${table}`).all());

    try {
      for (const filename of fs.readdirSync(migrationsDir).sort()) {
        database.exec(fs.readFileSync(path.join(migrationsDir, filename), 'utf8'));
      }
      assert.equal((await worker.fetch(eventRequest(payloadForCommand('ballin backup')), env)).status, 204);
      applyRuns(runs.splice(0));
      const beforeRows = existingRows();

      for (const event of ['backup.run', 'update.backup', 'update.self-update']) {
        for (const status of ['success', 'failure', 'success']) {
          assert.equal((await worker.fetch(eventRequest(payloadForBehavior(event, status)), env)).status, 204);
        }
      }
      applyRuns(runs);

      assert.deepEqual(existingRows(), beforeRows);
      assert.deepEqual(database.prepare('SELECT event, status, count FROM behavior_events_daily ORDER BY event, status').all(), [
        { event: 'backup.run', status: 'failure', count: 1 },
        { event: 'backup.run', status: 'success', count: 2 },
        { event: 'update.backup', status: 'failure', count: 1 },
        { event: 'update.backup', status: 'success', count: 2 },
        { event: 'update.self-update', status: 'failure', count: 1 },
        { event: 'update.self-update', status: 'success', count: 2 },
      ]);
    } finally {
      database.close();
    }
  });

  it('rejects missing, mistyped, unsupported, and cross-schema behavioral fields before storage', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const payload = payloadForBehavior();
    const invalidPayloads: Array<[string, Record<string, unknown>]> = [];
    for (const key of Object.keys(payload)) {
      const missing: Record<string, unknown> = { ...payload };
      delete missing[key];
      invalidPayloads.push([`missing ${key}`, missing]);
      for (const value of [null, '', [], {}, true]) {
        invalidPayloads.push([`invalid ${key}: ${JSON.stringify(value)}`, { ...payload, [key]: value }]);
      }
    }
    for (const key of ['command', 'durationBucket', 'appVersion', 'nodeMajor', 'osVersion', 'caller', 'origin', 'timestamp', 'installIdHash', 'path']) {
      invalidPayloads.push([`extra ${key}`, { ...payload, [key]: 'unexpected' }]);
    }
    for (const event of ['backup', 'backup.run.source', 'update.readiness', 'doctor', 'BACKUP.RUN', 'backup.run ']) {
      invalidPayloads.push([`event ${event}`, { ...payload, event }]);
    }
    for (const status of ['unknown', 'attempted', 'skipped', 'partial', 'SUCCESS']) {
      invalidPayloads.push([`status ${status}`, { ...payload, status }]);
    }
    for (const schemaVersion of [0, 1, 3, '2']) {
      invalidPayloads.push([`schema ${schemaVersion}`, { ...payload, schemaVersion }]);
    }
    for (const installId of [payload.installId.toUpperCase(), 'invalid', '826f9faa-9995-0f66-a01b-73b4f7aebdf1']) {
      invalidPayloads.push([`UUID ${installId}`, { ...payload, installId }]);
    }
    for (const dateBucket of ['2026/06/01', '2026-02-30', `${payload.dateBucket}T12:00:00Z`]) {
      invalidPayloads.push([`date ${dateBucket}`, { ...payload, dateBucket }]);
    }
    invalidPayloads.push(['command payload marked v2', { ...payloadForCommand('ballin backup'), schemaVersion: 2 }]);
    invalidPayloads.push(['v1 payload with behavioral event', { ...payloadForCommand('ballin backup'), event: 'backup.run' }]);

    for (const [description, invalidPayload] of invalidPayloads) {
      const { env, rateLimitKeys, runs } = makeEnv();
      const response = await worker.fetch(eventRequest(invalidPayload), env);
      assert.equal(response.status, 400, description);
      assert.deepEqual(runs, [], description);
      assert.lengthOf(rateLimitKeys, 2, description);
    }
  });

  it('accepts behavioral UTC date buckets within one day and rejects buckets beyond the skew', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const now = new Date();

    for (const offset of [-2, -1, 0, 1, 2]) {
      const { env, runs } = makeEnv();
      const dateBucket = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const response = await worker.fetch(eventRequest({ ...payloadForBehavior(), dateBucket }), env);
      const accepted = Math.abs(offset) <= 1;
      assert.equal(response.status, accepted ? 204 : 400, `UTC day offset ${offset}`);
      assert.lengthOf(runs, accepted ? 1 : 0);
    }
  });

  it('ignores the legacy ingest-token header from older clients', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env } = makeEnv();

    const response = await worker.fetch(eventRequest(payloadForCommand('ballin'), {
      legacyToken: true,
    }), env);

    assert.equal(response.status, 204);
  });

  it('rejects unsupported fields before D1 writes', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, runs } = makeEnv();
    const payload = {
      ...payloadForCommand('ballin update'),
      path: '/Users/example',
    };

    const response = await worker.fetch(eventRequest(payload), env);
    const body = await response.json() as { error?: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'event payload contains unsupported fields');
    assert.deepEqual(runs, []);
  });

  it('rejects malformed payload shapes, required identifiers, and enums without D1 writes', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const cases: Array<[Record<string, unknown> | string, string]> = [
      ['null', 'event payload must be a JSON object'],
      [{ ...payloadForCommand('ballin'), schemaVersion: 3 }, 'schemaVersion must be 1 or 2'],
      [{ ...payloadForCommand('ballin'), installId: '' }, 'installId must be a lowercase UUID'],
      [{ ...payloadForCommand('ballin'), dateBucket: '2026/06/01' }, 'dateBucket must be YYYY-MM-DD'],
      [{ ...payloadForCommand('ballin'), command: 'ballin destroy' }, 'command is not supported'],
      [{ ...payloadForCommand('ballin'), status: 'partial' }, 'status is not supported'],
      [{ ...payloadForCommand('ballin'), durationBucket: 'fast' }, 'durationBucket is not supported'],
      [{ ...payloadForCommand('ballin'), nodeMajor: 'v24' }, 'nodeMajor must be a major version number'],
      [{ ...payloadForCommand('ballin'), os: 'darwin' }, 'event payload contains unsupported fields'],
      [{ ...payloadForCommand('ballin'), osVersion: '15.1.2' }, 'osVersion must be coarse'],
    ];

    for (const [payload, expectedError] of cases) {
      const { env, runs } = makeEnv();
      const response = await worker.fetch(eventRequest(payload), env);
      const body = await response.json() as { error?: string };

      assert.equal(response.status, 400, expectedError);
      assert.equal(body.error, expectedError);
      assert.deepEqual(runs, []);
    }
  });

  it('defaults a missing duration bucket to unknown before aggregation', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, runs } = makeEnv();
    const payload = payloadForCommand('ballin backup');
    delete (payload as Partial<typeof payload>).durationBucket;

    const response = await worker.fetch(eventRequest(payload), env);

    assert.equal(response.status, 204);
    assert.includeDeepMembers(runs.map(({ values }) => values), [
      [payload.dateBucket, 'ballin backup', 'success', 'unknown'],
    ]);
  });

  it('preserves v1 unknown outcomes and its existing empty or non-string duration fallback', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;

    for (const durationBucket of ['', null, 0]) {
      const { env, runs } = makeEnv();
      const payload = { ...payloadForCommand('ballin backup'), status: 'unknown', durationBucket };
      const response = await worker.fetch(eventRequest(payload), env);

      assert.equal(response.status, 204);
      assert.lengthOf(runs, 3);
      assert.deepEqual(runs[1].values, [payload.dateBucket, 'ballin backup', 'unknown', 'unknown']);
      assert.notInclude(JSON.stringify(runs), 'behavior_events_daily');
    }
  });

  it('rejects high-cardinality version and runtime values', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, runs } = makeEnv();
    const payload = {
      ...payloadForCommand('ballin update'),
      appVersion: '1.0.0-nightly.20260627',
    };

    const response = await worker.fetch(eventRequest(payload), env);
    const body = await response.json() as { error?: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'appVersion must be a released semantic version');
    assert.deepEqual(runs, []);
  });

  it('rejects date buckets outside the accepted skew', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, runs } = makeEnv();
    const staleDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const payload = {
      ...payloadForCommand('ballin update'),
      dateBucket: staleDate,
    };

    const response = await worker.fetch(eventRequest(payload), env);
    const body = await response.json() as { error?: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'dateBucket is outside the accepted clock skew');
    assert.deepEqual(runs, []);
  });

  it('rejects oversized bodies before rate limiting when Content-Length is known', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, rateLimitKeys, runs } = makeEnv();
    const controlled = controlledBody([new TextEncoder().encode('{}')]);

    const response = await worker.fetch(streamedEventRequest(controlled.body, {
      headers: {
        'content-length': '2049',
      },
    }), env);
    const body = await response.json() as { error?: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'request body is too large');
    assert.deepEqual(rateLimitKeys, []);
    assert.deepEqual(runs, []);
    assert.equal(controlled.state.pulls, 0);
  });

  it('accepts highly fragmented valid JSON at the 2048-byte body limit', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, runs } = makeEnv();
    const encoder = new TextEncoder();
    const payload = JSON.stringify(payloadForCommand('ballin update'));
    const body = encoder.encode(payload.padEnd(2048, ' '));
    const controlled = controlledBody([body], { maxBytesPerPull: 1 });

    const response = await worker.fetch(streamedEventRequest(controlled.body), env);

    assert.equal(body.byteLength, 2048);
    assert.equal(response.status, 204);
    assert.lengthOf(runs, 3);
    assert.equal(controlled.state.deliveredBytes, 2048);
    assert.equal(controlled.state.pulls, 2049);
    assert.equal(controlled.state.cancellations, 0);
  });

  it('counts multibyte UTF-8 input by encoded bytes', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, runs } = makeEnv();
    const body = JSON.stringify('é'.repeat(1024));

    const response = await worker.fetch(eventRequest(body), env);

    assert.isBelow(body.length, 2048);
    assert.isAbove(new TextEncoder().encode(body).byteLength, 2048);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'request body is too large' });
    assert.deepEqual(runs, []);
  });

  it('enforces the same bounded body reads for behavioral payloads at and beyond the byte limit', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const payload = JSON.stringify(payloadForBehavior());

    for (const byteLength of [2048, 2049, 65_536]) {
      const { env, rateLimitKeys, runs } = makeEnv();
      const controlled = controlledBody([new TextEncoder().encode(payload.padEnd(byteLength, ' '))], {
        maxBytesPerPull: byteLength === 2048 ? 1 : undefined,
      });
      const response = await worker.fetch(streamedEventRequest(controlled.body), env);
      const accepted = byteLength === 2048;

      assert.equal(response.status, accepted ? 204 : 400);
      assert.lengthOf(runs, accepted ? 1 : 0);
      assert.lengthOf(rateLimitKeys, accepted ? 3 : 2);
      assert.equal(controlled.state.deliveredBytes, accepted ? 2048 : 2049);
      assert.equal(controlled.state.cancellations, accepted ? 0 : 1);
      if (!accepted) {
        assert.deepEqual(await response.json(), { error: 'request body is too large' });
      }
    }
  });

  it('preserves the invalid JSON response for requests without a body', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, runs } = makeEnv();
    const request = new Request('https://analytics.example.test/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    const response = await worker.fetch(request, env);

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid JSON' });
    assert.deepEqual(runs, []);
  });

  it('rejects unsupported methods, content types, invalid JSON, and unknown routes', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, runs } = makeEnv();
    const methodResponse = await worker.fetch(new Request('https://analytics.example.test/v1/events'), env);
    const contentTypeResponse = await worker.fetch(new Request('https://analytics.example.test/v1/events', {
      method: 'POST',
      body: '{}',
    }), env);
    const invalidJsonResponse = await worker.fetch(eventRequest('{'), env);
    const routeResponse = await worker.fetch(new Request('https://analytics.example.test/health'), env);

    assert.equal(methodResponse.status, 405);
    assert.equal(contentTypeResponse.status, 400);
    assert.deepEqual(await contentTypeResponse.json(), { error: 'content-type must be application/json' });
    assert.equal(invalidJsonResponse.status, 400);
    assert.deepEqual(await invalidJsonResponse.json(), { error: 'invalid JSON' });
    assert.equal(routeResponse.status, 404);
    assert.deepEqual(runs, []);
  });

  it('rejects oversized streamed bodies after rate limiting but before parsing', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, rateLimitKeys, runs } = makeEnv();
    const controlled = controlledBody([
      new Uint8Array(65_536),
    ]);
    const response = await worker.fetch(streamedEventRequest(controlled.body, {
      headers: { 'x-forwarded-for': '198.51.100.5, 198.51.100.6' },
    }), env);

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'request body is too large' });
    assert.deepEqual(rateLimitKeys, ['v1-events:global', 'v1-events:source:198.51.100.5']);
    assert.deepEqual(runs, []);
    assert.equal(controlled.state.deliveredBytes, 2049);
    assert.equal(controlled.state.pulls, 1);
    assert.equal(controlled.state.cancellations, 1);
    assert.equal(controlled.state.remainingBytes, 63_487);
  });

  it('bounds missing and malformed forwarding identities in source rate-limit keys', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const missing = makeEnv();
    const malformed = makeEnv();

    assert.equal((await worker.fetch(eventRequest(payloadForCommand('ballin')), missing.env)).status, 204);
    assert.equal((await worker.fetch(eventRequest(payloadForCommand('ballin'), {
      headers: { 'x-forwarded-for': ' CLIENT @ EXAMPLE! ' },
    }), malformed.env)).status, 204);

    assert.equal(missing.rateLimitKeys[1], 'v1-events:source:unknown');
    assert.equal(malformed.rateLimitKeys[1], 'v1-events:source:client___example_');
  });

  it('applies source rate limits before parsing or D1 writes', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, rateLimitKeys, runs } = makeEnv({
      rateLimitFailure: (key) => key === 'v1-events:source:203.0.113.7',
    });
    const controlled = controlledBody([
      new TextEncoder().encode(JSON.stringify(payloadForCommand('ballin update'))),
    ]);

    const response = await worker.fetch(streamedEventRequest(controlled.body, {
      sourceIp: '203.0.113.7',
    }), env);

    assert.equal(response.status, 429);
    assert.deepEqual(rateLimitKeys, [
      'v1-events:global',
      'v1-events:source:203.0.113.7',
    ]);
    assert.deepEqual(runs, []);
    assert.equal(controlled.state.pulls, 0);
  });

  it('applies global rate limits before source keys, parsing, or D1 writes', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, rateLimitKeys, runs } = makeEnv({
      rateLimitFailure: (key) => key === 'v1-events:global',
    });
    const controlled = controlledBody([
      new TextEncoder().encode(JSON.stringify(payloadForCommand('ballin update'))),
    ]);

    const response = await worker.fetch(streamedEventRequest(controlled.body, {
      sourceIp: '203.0.113.7',
    }), env);

    assert.equal(response.status, 429);
    assert.deepEqual(rateLimitKeys, ['v1-events:global']);
    assert.deepEqual(runs, []);
    assert.equal(controlled.state.pulls, 0);
  });

  it('applies install-hash rate limits before D1 writes', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, rateLimitKeys, runs } = makeEnv({
      rateLimitFailure: (key) => key.startsWith('v1-events:install:'),
    });

    const response = await worker.fetch(eventRequest(payloadForCommand('ballin update')), env);

    assert.equal(response.status, 429);
    assert.match(rateLimitKeys[2], /^v1-events:install:[0-9a-f]{64}$/);
    assert.deepEqual(runs, []);
  });

  it('fails closed when the install ID hash secret is missing', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, rateLimitKeys, runs } = makeEnv({ hashSecret: '' });

    const response = await worker.fetch(eventRequest(payloadForCommand('ballin update')), env);
    const body = await response.json() as { error?: string };

    assert.equal(response.status, 500);
    assert.equal(body.error, 'analytics backend is not configured');
    assert.deepEqual(rateLimitKeys, []);
    assert.deepEqual(runs, []);
  });

  it('fails closed when the rate-limit binding is missing', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, rateLimitKeys, runs } = makeEnv({ rateLimiter: false });

    const response = await worker.fetch(eventRequest(payloadForCommand('ballin update')), env);
    const body = await response.json() as { error?: string };

    assert.equal(response.status, 500);
    assert.equal(body.error, 'analytics backend is not configured');
    assert.deepEqual(rateLimitKeys, []);
    assert.deepEqual(runs, []);
  });

  it('enforces all three behavioral rate limits before any aggregate write', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;

    for (const [prefix, keyCount, readsBody] of [
      ['v1-events:global', 1, false],
      ['v1-events:source:', 2, false],
      ['v1-events:install:', 3, true],
    ] as const) {
      const { env, rateLimitKeys, runs } = makeEnv({
        rateLimitFailure: (key) => key.startsWith(prefix),
      });
      const controlled = controlledBody([new TextEncoder().encode(JSON.stringify(payloadForBehavior()))]);
      const response = await worker.fetch(streamedEventRequest(controlled.body, { sourceIp: '203.0.113.7' }), env);

      assert.equal(response.status, 429);
      assert.lengthOf(rateLimitKeys, keyCount);
      assert.deepEqual(runs, []);
      assert.equal(controlled.state.pulls > 0, readsBody);
    }
  });

  it('fails closed for behavioral requests without a hash secret or rate-limit binding', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;

    for (const options of [{ hashSecret: '' }, { rateLimiter: false }]) {
      const { env, rateLimitKeys, runs } = makeEnv(options);
      const controlled = controlledBody([new TextEncoder().encode(JSON.stringify(payloadForBehavior()))]);
      const response = await worker.fetch(streamedEventRequest(controlled.body), env);

      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: 'analytics backend is not configured' });
      assert.deepEqual(rateLimitKeys, []);
      assert.deepEqual(runs, []);
      assert.equal(controlled.state.pulls, 0);
    }
  });

  it('does not acknowledge behavioral storage failures as accepted outcomes', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const error = new Error('D1 write failed');
    const { env, runs } = makeEnv({ batchError: error });

    await worker.fetch(eventRequest(payloadForBehavior()), env).then(
      () => assert.fail('expected behavioral storage to reject'),
      (caught: Error) => assert.strictEqual(caught, error),
    );
    assert.deepEqual(runs, []);
  });

  it('deletes every aggregate older than the scheduled retention cutoff', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, runs } = makeEnv();
    let cleanup: Promise<unknown> | undefined;

    await worker.scheduled({
      cron: '0 4 * * *',
      scheduledTime: Date.parse('2026-06-30T04:00:00.000Z'),
    }, env, {
      waitUntil(promise: Promise<unknown>) {
        cleanup = promise;
      },
    });
    await cleanup;

    assert.lengthOf(runs, 4);
    assert.deepEqual(runs.map(({ values }) => values), [
      ['2025-05-31'],
      ['2025-05-31'],
      ['2025-05-31'],
      ['2025-05-31'],
    ]);
    assert.deepEqual(runs.map(({ query }) => query), [
      'DELETE FROM install_days WHERE date_bucket < ?1',
      'DELETE FROM command_events_daily WHERE date_bucket < ?1',
      'DELETE FROM version_events_daily WHERE date_bucket < ?1',
      'DELETE FROM behavior_events_daily WHERE date_bucket < ?1',
    ]);
  });

  it('retains behavioral rows on the 395-day cutoff and deletes only older rows', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, runs } = makeEnv();
    const database = new DatabaseSync(':memory:');
    const migrationsDir = path.join(__dirname, '..', 'analytics-worker', 'migrations');
    let cleanup: Promise<unknown> | undefined;

    try {
      for (const filename of fs.readdirSync(migrationsDir).sort()) {
        database.exec(fs.readFileSync(path.join(migrationsDir, filename), 'utf8'));
      }
      const insert = database.prepare('INSERT INTO behavior_events_daily VALUES (?, ?, ?, 1)');
      for (const date of ['2025-05-30', '2025-05-31', '2025-06-01']) {
        insert.run(date, 'backup.run', 'success');
      }

      await worker.scheduled({ cron: '0 4 * * *', scheduledTime: Date.parse('2026-06-30T04:00:00.000Z') }, env, {
        waitUntil(promise: Promise<unknown>) {
          cleanup = promise;
        },
      });
      await cleanup;
      for (const { query, values } of runs) {
        database.prepare(query).run({ '?1': values[0] });
      }

      assert.deepEqual(database.prepare('SELECT date_bucket FROM behavior_events_daily ORDER BY date_bucket').all(), [
        { date_bucket: '2025-05-31' },
        { date_bucket: '2025-06-01' },
      ]);
    } finally {
      database.close();
    }
  });

  it('propagates scheduled D1 cleanup failures through waitUntil', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env } = makeEnv({ batchError: new Error('D1 retention failed') });
    let cleanup: Promise<unknown> | undefined;

    await worker.scheduled({ cron: '0 4 * * *', scheduledTime: Date.now() }, env, {
      waitUntil(promise: Promise<unknown>) {
        cleanup = promise;
      },
    });

    await cleanup?.then(
      () => assert.fail('expected retention cleanup to reject'),
      (error: Error) => assert.equal(error.message, 'D1 retention failed'),
    );
  });
});
