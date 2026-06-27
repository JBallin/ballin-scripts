type D1Database = {
  prepare: (query: string) => D1PreparedStatement;
  batch: (statements: D1PreparedStatement[]) => Promise<unknown[]>;
};

type D1PreparedStatement = {
  bind: (...values: unknown[]) => D1PreparedStatement;
  run: () => Promise<unknown>;
};

type ExecutionContext = {
  waitUntil: (promise: Promise<unknown>) => void;
};

type ScheduledController = {
  scheduledTime: number;
  cron: string;
};

type Env = {
  ANALYTICS_DB: D1Database;
  INSTALL_ID_HASH_SECRET: string;
  INGEST_TOKEN: string;
};

type AnalyticsEvent = {
  schemaVersion: number;
  installId: string;
  dateBucket: string;
  command: string;
  status: string;
  durationBucket?: string;
  appVersion: string;
  nodeMajor: string;
  os: string;
  osVersion: string;
};

type ParseOptions = {
  now: Date;
};

const allowedCommands = new Set(['up', 'gu', 'ballin_update', 'ballin']);
const allowedStatuses = new Set(['success', 'failure', 'unknown']);
const allowedDurations = new Set(['unknown', '<1s', '1-10s', '10-60s', '1-10m', '10m+']);
const allowedOs = new Set(['darwin', 'linux', 'win32', 'unknown']);
const installIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const dateBucketPattern = /^\d{4}-\d{2}-\d{2}$/;
const versionPattern = /^[0-9]+(?:\.[0-9]+){0,2}$/;
const majorVersionPattern = /^[0-9]+$/;
const coarseOsVersionPattern = /^[0-9]+(?:\.[0-9]+)?$|^unknown$/;
const ingestTokenHeader = 'x-ballin-analytics-token';
const maxBodyBytes = 2048;
const retentionDays = 395;
const allowedDateSkewDays = 1;

const jsonResponse = (status: number, body: { error: string }): Response => (
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
);

const emptyResponse = (status: number): Response => (
  new Response(null, {
    status,
    headers: {
      'cache-control': 'no-store',
    },
  })
);

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const stringField = (payload: Record<string, unknown>, key: string): string | null => {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const validateDateBucket = (dateBucket: string): boolean => {
  if (!dateBucketPattern.test(dateBucket)) {
    return false;
  }
  const parsed = new Date(`${dateBucket}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(dateBucket);
};

const isDateBucketWithinSkew = (dateBucket: string, now: Date): boolean => {
  const dateBucketTime = Date.parse(`${dateBucket}T00:00:00.000Z`);
  const currentBucketTime = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const maxDifference = allowedDateSkewDays * 24 * 60 * 60 * 1000;
  return Math.abs(dateBucketTime - currentBucketTime) <= maxDifference;
};

const parseAnalyticsEvent = (payload: unknown, options: ParseOptions): AnalyticsEvent | string => {
  if (!isObject(payload)) {
    return 'event payload must be a JSON object';
  }
  if (payload.schemaVersion !== 1) {
    return 'schemaVersion must be 1';
  }

  const installId = stringField(payload, 'installId');
  const dateBucket = stringField(payload, 'dateBucket');
  const command = stringField(payload, 'command');
  const status = stringField(payload, 'status');
  const durationBucket = stringField(payload, 'durationBucket') ?? 'unknown';
  const appVersion = stringField(payload, 'appVersion');
  const nodeMajor = stringField(payload, 'nodeMajor');
  const os = stringField(payload, 'os');
  const osVersion = stringField(payload, 'osVersion');

  if (!installId || !installIdPattern.test(installId)) {
    return 'installId must be a lowercase UUID';
  }
  if (!dateBucket || !validateDateBucket(dateBucket)) {
    return 'dateBucket must be YYYY-MM-DD';
  }
  if (!isDateBucketWithinSkew(dateBucket, options.now)) {
    return 'dateBucket is outside the accepted clock skew';
  }
  if (!command || !allowedCommands.has(command)) {
    return 'command is not supported';
  }
  if (!status || !allowedStatuses.has(status)) {
    return 'status is not supported';
  }
  if (!allowedDurations.has(durationBucket)) {
    return 'durationBucket is not supported';
  }
  if (!appVersion || !versionPattern.test(appVersion)) {
    return 'appVersion must be a released semantic version';
  }
  if (!nodeMajor || !majorVersionPattern.test(nodeMajor)) {
    return 'nodeMajor must be a major version number';
  }
  if (!os || !allowedOs.has(os)) {
    return 'os is not supported';
  }
  if (!osVersion || !coarseOsVersionPattern.test(osVersion)) {
    return 'osVersion must be coarse';
  }

  return {
    schemaVersion: 1,
    installId,
    dateBucket,
    command,
    status,
    durationBucket,
    appVersion,
    nodeMajor,
    os,
    osVersion,
  };
};

const hashInstallId = async (installId: string, secret: string): Promise<string> => {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(installId));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

const storeAnalyticsEvent = async (env: Env, event: AnalyticsEvent): Promise<void> => {
  const installIdHash = await hashInstallId(event.installId, env.INSTALL_ID_HASH_SECRET);

  await env.ANALYTICS_DB.batch([
    env.ANALYTICS_DB.prepare(`
      INSERT OR IGNORE INTO install_days (date_bucket, install_id_hash)
      VALUES (?1, ?2)
    `).bind(event.dateBucket, installIdHash),
    env.ANALYTICS_DB.prepare(`
      INSERT INTO command_events_daily (date_bucket, command, status, duration_bucket, count)
      VALUES (?1, ?2, ?3, ?4, 1)
      ON CONFLICT(date_bucket, command, status, duration_bucket)
      DO UPDATE SET count = count + 1
    `).bind(event.dateBucket, event.command, event.status, event.durationBucket),
    env.ANALYTICS_DB.prepare(`
      INSERT INTO version_events_daily (
        date_bucket,
        command,
        app_version,
        node_major,
        os,
        os_version,
        count
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
      ON CONFLICT(date_bucket, command, app_version, node_major, os, os_version)
      DO UPDATE SET count = count + 1
    `).bind(
      event.dateBucket,
      event.command,
      event.appVersion,
      event.nodeMajor,
      event.os,
      event.osVersion,
    ),
  ]);
};

const handleEventRequest = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== 'POST') {
    return emptyResponse(405);
  }
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    return jsonResponse(400, { error: 'content-type must be application/json' });
  }
  if (!env.INSTALL_ID_HASH_SECRET) {
    return jsonResponse(500, { error: 'analytics backend is not configured' });
  }
  if (!env.INGEST_TOKEN) {
    return jsonResponse(500, { error: 'analytics ingest gate is not configured' });
  }
  if (request.headers.get(ingestTokenHeader) !== env.INGEST_TOKEN) {
    return emptyResponse(401);
  }
  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > maxBodyBytes) {
    return jsonResponse(400, { error: 'invalid content length' });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse(400, { error: 'invalid JSON' });
  }

  const event = parseAnalyticsEvent(payload, { now: new Date() });
  if (typeof event === 'string') {
    return jsonResponse(400, { error: event });
  }

  await storeAnalyticsEvent(env, event);
  return emptyResponse(204);
};

const cutoffDateBucket = (scheduledTime: number): string => {
  const cutoff = new Date(scheduledTime - retentionDays * 24 * 60 * 60 * 1000);
  return cutoff.toISOString().slice(0, 10);
};

const cleanupOldRows = async (env: Env, scheduledTime: number): Promise<void> => {
  const cutoff = cutoffDateBucket(scheduledTime);
  await env.ANALYTICS_DB.batch([
    env.ANALYTICS_DB.prepare('DELETE FROM install_days WHERE date_bucket < ?1').bind(cutoff),
    env.ANALYTICS_DB.prepare('DELETE FROM command_events_daily WHERE date_bucket < ?1').bind(cutoff),
    env.ANALYTICS_DB.prepare('DELETE FROM version_events_daily WHERE date_bucket < ?1').bind(cutoff),
  ]);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/v1/events') {
      return emptyResponse(404);
    }
    return handleEventRequest(request, env);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanupOldRows(env, controller.scheduledTime));
  },
};
