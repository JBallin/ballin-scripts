const { assert } = require('chai');

type StatementRun = {
  query: string;
  values: unknown[];
};

type MakeEnvOptions = {
  hashSecret?: string;
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
  return {
    env: {
      ANALYTICS_DB: {
        prepare(query: string) {
          return new TestStatement(query);
        },
        async batch(statements: TestStatement[]) {
          statements.forEach((statement) => {
            runs.push({
              query: statement.query,
              values: statement.values,
            });
          });
          return [];
        },
      },
      ANALYTICS_RATE_LIMITER: {
        async limit({ key }: { key: string }) {
          rateLimitKeys.push(key);
          return { success: !options.rateLimitFailure?.(key) };
        },
      },
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
});
