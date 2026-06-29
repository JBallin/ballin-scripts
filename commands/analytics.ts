const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const os = require('os');
const path = require('path');
const { fetchConfig } = require('../config/index.ts');

import type { ClientRequest, IncomingMessage } from 'http';
import type { RequestOptions } from 'https';
import type { Socket } from 'net';

type AnalyticsConfig = {
  enabled?: string;
};

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

type AnalyticsRecordInput = {
  command: string;
  status?: string;
  durationBucket?: string;
  now?: Date;
};

type SenderOptions = {
  endpoint?: string;
  ingestToken?: string;
  timeoutMs?: number;
};

type AnalyticsSender = (payload: AnalyticsPayload, options: SenderOptions) => void;

type AnalyticsRuntime = SenderOptions & {
  env?: NodeJS.ProcessEnv;
  installIdPath?: string;
  sender?: AnalyticsSender;
};

type CommandAnalyticsRuntime = AnalyticsRuntime & {
  nowMs?: () => number;
};

type AnalyticsInstallIdOptions = {
  analyticsConfig?: AnalyticsConfig;
  docsUrl?: string;
  env?: NodeJS.ProcessEnv;
  generateInstallId?: () => string;
  installIdPath?: string;
  noticeWriter?: (message: string) => void;
  repoDir?: string;
};

type ConfigObject = { [key: string]: unknown };

const schemaVersion = 1;
const defaultTimeoutMs = 750;
const allowedCommands = new Set([
  'ballin',
  'ballin_config',
  'ballin_uninstall',
  'ballin_update',
  'gu',
  'up',
]);
const allowedStatuses = new Set(['success', 'failure', 'unknown']);
const allowedDurations = new Set(['unknown', '<1s', '1-10s', '10-60s', '1-10m', '10m+']);
const allowedOs = new Set(['darwin', 'linux', 'win32']);
const installIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const defaultAnalyticsDocsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/analytics.md';
const analyticsNoticeFor = (docsUrl = defaultAnalyticsDocsUrl): string => [
  'ballin-scripts collects minimal anonymous usage analytics after this notice.',
  'Disable: ballin_config set analytics.enabled false',
  `Details: ${docsUrl}`,
].join('\n');
const analyticsNotice = analyticsNoticeFor();

const packageJsonPath = path.join(__dirname, '..', 'package.json');
const defaultRepoDir = path.join(__dirname, '..');

const loadAppVersion = (): string => {
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
    return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
};

const isAnalyticsConfig = (value: unknown): value is AnalyticsConfig => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const readAnalyticsConfig = (): { analytics: AnalyticsConfig } => {
  const { configObj } = fetchConfig() as { configObj: ConfigObject };
  return {
    analytics: isAnalyticsConfig(configObj.analytics) ? configObj.analytics : {},
  };
};

const analyticsDisabledByEnv = (env: NodeJS.ProcessEnv): boolean => (
  env.BALLIN_NO_ANALYTICS === '1' || Boolean(env.CI)
);

const installIdPathForRepo = (repoDir = defaultRepoDir): string => (
  path.join(repoDir, '.analytics', 'install-id')
);

const readLocalInstallId = (installIdPath = installIdPathForRepo()): string | null => {
  try {
    const installId = fs.readFileSync(installIdPath, 'utf8').trim();
    return installIdPattern.test(installId) ? installId : null;
  } catch {
    return null;
  }
};

const writeLocalInstallId = (installId: string, installIdPath = installIdPathForRepo()): boolean => {
  try {
    fs.mkdirSync(path.dirname(installIdPath), { recursive: true });
    fs.writeFileSync(installIdPath, `${installId}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
};

const ensureAnalyticsInstallId = (options: AnalyticsInstallIdOptions = {}): string | null => {
  if (analyticsDisabledByEnv(options.env ?? process.env)) {
    return null;
  }
  if (options.analyticsConfig?.enabled !== 'true') {
    return null;
  }

  const installIdPath = options.installIdPath ?? installIdPathForRepo(options.repoDir);
  const existingInstallId = readLocalInstallId(installIdPath);
  if (existingInstallId) {
    return existingInstallId;
  }

  options.noticeWriter?.(analyticsNoticeFor(options.docsUrl));
  const installId = (options.generateInstallId ?? crypto.randomUUID)();
  return writeLocalInstallId(installId, installIdPath) ? installId : null;
};

const dateBucket = (now: Date): string => now.toISOString().slice(0, 10);

const nodeMajor = (): string => process.versions.node.split('.')[0] ?? '0';

const osFamily = (): string => {
  const platform = os.platform();
  return allowedOs.has(platform) ? platform : 'unknown';
};

const coarseOsVersion = (): string => {
  const [major, minor] = os.release().split('.');
  if (!major || !/^[0-9]+$/.test(major)) {
    return 'unknown';
  }
  return minor && /^[0-9]+$/.test(minor) ? `${major}.${minor}` : major;
};

const durationBucketFromMs = (durationMs: number): string => {
  if (durationMs < 1000) {
    return '<1s';
  }
  if (durationMs < 10_000) {
    return '1-10s';
  }
  if (durationMs < 60_000) {
    return '10-60s';
  }
  if (durationMs < 600_000) {
    return '1-10m';
  }
  return '10m+';
};

const buildAnalyticsPayload = (
  input: Required<Pick<AnalyticsRecordInput, 'command' | 'status' | 'durationBucket' | 'now'>>,
  installId: string,
): AnalyticsPayload => ({
  schemaVersion,
  installId,
  dateBucket: dateBucket(input.now),
  command: input.command,
  status: input.status,
  durationBucket: input.durationBucket,
  appVersion: loadAppVersion(),
  nodeMajor: nodeMajor(),
  os: osFamily(),
  osVersion: coarseOsVersion(),
});

const requestOptions = (endpoint: string, ingestToken: string): RequestOptions => {
  const url = new URL(endpoint);
  return {
    method: 'POST',
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    headers: {
      'content-type': 'application/json',
      'x-ballin-analytics-token': ingestToken,
    },
  };
};

const ignoreRequestFailure = (request: ClientRequest): void => {
  request.on('error', () => {});
};

const unrefRequestSocket = (request: ClientRequest): void => {
  request.on('socket', (socket: Socket) => {
    socket.unref();
  });
};

const sendAnalyticsPayload: AnalyticsSender = (payload, options) => {
  if (!options.endpoint || !options.ingestToken) {
    return;
  }

  try {
    const body = JSON.stringify(payload);
    const optionsWithHeaders = requestOptions(options.endpoint, options.ingestToken);
    const request = https.request({
      ...optionsWithHeaders,
      headers: {
        ...optionsWithHeaders.headers,
        'content-length': Buffer.byteLength(body),
      },
    }, (response: IncomingMessage) => {
      response.resume();
    });

    ignoreRequestFailure(request);
    unrefRequestSocket(request);
    request.setTimeout(options.timeoutMs ?? defaultTimeoutMs, () => {
      request.destroy();
    });
    request.end(body);
  } catch {
    // Analytics must never affect command behavior.
  }
};

const recordAnalyticsEvent = (input: AnalyticsRecordInput, runtime: AnalyticsRuntime = {}): void => {
  try {
    const env = runtime.env ?? process.env;
    if (analyticsDisabledByEnv(env)) {
      return;
    }
    if (!allowedCommands.has(input.command)) {
      return;
    }

    const status = input.status ?? 'unknown';
    const durationBucket = input.durationBucket ?? 'unknown';
    if (!allowedStatuses.has(status) || !allowedDurations.has(durationBucket)) {
      return;
    }

    const { analytics } = readAnalyticsConfig();
    if (analytics.enabled !== 'true') {
      return;
    }

    const installId = readLocalInstallId(runtime.installIdPath);
    if (!installId) {
      return;
    }

    const payload = buildAnalyticsPayload({
      command: input.command,
      status,
      durationBucket,
      now: input.now ?? new Date(),
    }, installId);
    (runtime.sender ?? sendAnalyticsPayload)(payload, {
      endpoint: runtime.endpoint,
      ingestToken: runtime.ingestToken,
      timeoutMs: runtime.timeoutMs ?? defaultTimeoutMs,
    });
  } catch {
    // Analytics must never affect command behavior or exit status.
  }
};

const analyticsStatusFromExitCode = (exitCode: string | number | null | undefined): string => {
  if (exitCode === undefined || exitCode === null || exitCode === 0 || exitCode === '0') {
    return 'success';
  }
  return 'failure';
};

const runWithCommandAnalytics = (
  command: string,
  runCommand: () => void,
  runtime: CommandAnalyticsRuntime = {},
): void => {
  const nowMs = runtime.nowMs ?? Date.now;
  const startedAt = nowMs();
  process.exitCode = undefined;
  try {
    runCommand();
    recordAnalyticsEvent({
      command,
      status: analyticsStatusFromExitCode(process.exitCode),
      durationBucket: durationBucketFromMs(Math.max(0, nowMs() - startedAt)),
    }, runtime);
  } catch (error) {
    recordAnalyticsEvent({
      command,
      status: 'failure',
      durationBucket: durationBucketFromMs(Math.max(0, nowMs() - startedAt)),
    }, runtime);
    throw error;
  }
};

module.exports = {
  analyticsDisabledByEnv,
  analyticsNotice,
  analyticsNoticeFor,
  buildAnalyticsPayload,
  durationBucketFromMs,
  ensureAnalyticsInstallId,
  installIdPathForRepo,
  readLocalInstallId,
  recordAnalyticsEvent,
  runWithCommandAnalytics,
  sendAnalyticsPayload,
};
