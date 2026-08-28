const {
  buildAnalyticsPayload,
} = require('../commands/analytics.ts');
const {
  analyticsCommandForBallinArgs,
} = require('../commands/ballin.ts');

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
  os: 'darwin',
  osVersion: '15',
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

describe('analytics Worker', () => {
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
    }, '826f9faa-9995-4f66-a01b-73b4f7aebdf1', '2.0.0');

    const response = await worker.fetch(eventRequest(payload), env);

    assert.equal(command, 'ballin doctor');
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
      [payload.dateBucket, 'ballin update', '1.0.0', '24', 'darwin', '15'],
    ]);
    assert.notInclude(runs.flatMap(({ values }) => values), '203.0.113.7');
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
      [{ ...payloadForCommand('ballin'), schemaVersion: 2 }, 'schemaVersion must be 1'],
      [{ ...payloadForCommand('ballin'), installId: '' }, 'installId must be a lowercase UUID'],
      [{ ...payloadForCommand('ballin'), dateBucket: '2026/06/01' }, 'dateBucket must be YYYY-MM-DD'],
      [{ ...payloadForCommand('ballin'), command: 'ballin destroy' }, 'command is not supported'],
      [{ ...payloadForCommand('ballin'), status: 'partial' }, 'status is not supported'],
      [{ ...payloadForCommand('ballin'), durationBucket: 'fast' }, 'durationBucket is not supported'],
      [{ ...payloadForCommand('ballin'), nodeMajor: 'v24' }, 'nodeMajor must be a major version number'],
      [{ ...payloadForCommand('ballin'), os: 'freebsd' }, 'os is not supported'],
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

    const response = await worker.fetch(eventRequest('{}', {
      headers: {
        'content-length': '2049',
      },
    }), env);
    const body = await response.json() as { error?: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'request body is too large');
    assert.deepEqual(rateLimitKeys, []);
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
    const response = await worker.fetch(eventRequest(' '.repeat(2049), {
      headers: { 'x-forwarded-for': '198.51.100.5, 198.51.100.6' },
    }), env);

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'request body is too large' });
    assert.deepEqual(rateLimitKeys, ['v1-events:global', 'v1-events:source:198.51.100.5']);
    assert.deepEqual(runs, []);
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

    const response = await worker.fetch(eventRequest(payloadForCommand('ballin update'), {
      sourceIp: '203.0.113.7',
    }), env);

    assert.equal(response.status, 429);
    assert.deepEqual(rateLimitKeys, [
      'v1-events:global',
      'v1-events:source:203.0.113.7',
    ]);
    assert.deepEqual(runs, []);
  });

  it('applies global rate limits before source keys, parsing, or D1 writes', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, rateLimitKeys, runs } = makeEnv({
      rateLimitFailure: (key) => key === 'v1-events:global',
    });

    const response = await worker.fetch(eventRequest(payloadForCommand('ballin update'), {
      sourceIp: '203.0.113.7',
    }), env);

    assert.equal(response.status, 429);
    assert.deepEqual(rateLimitKeys, ['v1-events:global']);
    assert.deepEqual(runs, []);
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

    assert.lengthOf(runs, 3);
    assert.deepEqual(runs.map(({ values }) => values), [
      ['2025-05-31'],
      ['2025-05-31'],
      ['2025-05-31'],
    ]);
    assert.deepEqual(runs.map(({ query }) => query), [
      'DELETE FROM install_days WHERE date_bucket < ?1',
      'DELETE FROM command_events_daily WHERE date_bucket < ?1',
      'DELETE FROM version_events_daily WHERE date_bucket < ?1',
    ]);
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
