const { assert } = require('chai');

type StatementRun = {
  query: string;
  values: unknown[];
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

const makeEnv = () => {
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
        async limit() {
          return { success: true };
        },
      },
      INSTALL_ID_HASH_SECRET: 'test-secret',
      INGEST_TOKEN: 'test-token',
    },
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

const eventRequest = (payload: ReturnType<typeof payloadForCommand>) => new Request('https://analytics.example.test/v1/events', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-ballin-analytics-token': 'test-token',
  },
  body: JSON.stringify(payload),
});

describe('analytics Worker', () => {
  it('accepts canonical Ballin command names', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env, runs } = makeEnv();
    const payload = payloadForCommand('ballin update');

    const response = await worker.fetch(eventRequest(payload), env);

    assert.equal(response.status, 204);
    assert.includeDeepMembers(runs.map(({ values }) => values), [
      [payload.dateBucket, 'ballin update', '1.0.0', '24', 'darwin', '15'],
    ]);
  });

  it('rejects unsupported command names', async () => {
    const worker = require('../analytics-worker/src/index.ts').default;
    const { env } = makeEnv();

    const response = await worker.fetch(eventRequest(payloadForCommand('unknown command')), env);
    const body = await response.json() as { error?: string };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'command is not supported');
  });
});
