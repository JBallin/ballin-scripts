const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const os = require('os');
const path = require('path');
const { fetchConfig } = require('../config/index.ts');

import type { IncomingMessage } from 'http';
import type { RequestOptions } from 'https';

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

type AnalyticsSender = (payload: AnalyticsPayload, options: SenderOptions) => Promise<void>;

type AnalyticsRuntime = SenderOptions & {
  analyticsConfig?: AnalyticsConfig;
  appVersion?: string;
  env?: NodeJS.ProcessEnv;
  installId?: string | null;
  installIdPath?: string;
  sender?: AnalyticsSender;
};

type CommandAnalyticsRuntime = AnalyticsRuntime & {
  nowMs?: () => number;
  preserveLocalState?: boolean;
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
  'ballin backup',
  'ballin config',
  'ballin doctor',
  'ballin self-update',
  'ballin uninstall',
  'ballin update',
  'ballin_config',
  'ballin_uninstall',
  'ballin_update',
]);
const allowedStatuses = new Set(['success', 'failure', 'unknown']);
const allowedDurations = new Set(['unknown', '<1s', '1-10s', '10-60s', '1-10m', '10m+']);
const allowedOs = new Set(['darwin', 'linux', 'win32']);
const installIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const defaultAnalyticsDocsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/analytics.md';
const productionAnalyticsEndpoint = 'https://ballin-scripts-analytics.jballin.workers.dev/v1/events';
const productionAnalyticsIngestToken = '6jC_OqsMynyQc3FKXgUN7aP3bbDQ_H_DMhGDrw7t6RE';
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

const preserveLocalAnalyticsState = (runtime: CommandAnalyticsRuntime): AnalyticsRuntime => {
  try {
    return {
      ...runtime,
      analyticsConfig: readAnalyticsConfig().analytics,
      appVersion: loadAppVersion(),
      installId: readLocalInstallId(runtime.installIdPath),
    };
  } catch {
    return runtime;
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
  appVersion = loadAppVersion(),
): AnalyticsPayload => ({
  schemaVersion,
  installId,
  dateBucket: dateBucket(input.now),
  command: input.command,
  status: input.status,
  durationBucket: input.durationBucket,
  appVersion,
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

const sendAnalyticsPayload: AnalyticsSender = (payload, options) => new Promise((resolve) => {
  let wallClockTimeout: NodeJS.Timeout | undefined;
  let settled = false;
  const settle = (): void => {
    if (!settled) {
      settled = true;
      if (wallClockTimeout) {
        clearTimeout(wallClockTimeout);
      }
      resolve();
    }
  };

  if (!options.endpoint || !options.ingestToken) {
    settle();
    return;
  }

  try {
    const body = JSON.stringify(payload);
    const optionsWithHeaders = requestOptions(options.endpoint, options.ingestToken);
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    let destroyRequest = () => {};
    wallClockTimeout = setTimeout(() => {
      destroyRequest();
      settle();
    }, timeoutMs);
    const request = https.request({
      ...optionsWithHeaders,
      headers: {
        ...optionsWithHeaders.headers,
        'content-length': Buffer.byteLength(body),
      },
    }, (response: IncomingMessage) => {
      response.on('end', settle);
      response.on('close', settle);
      response.resume();
    });
    destroyRequest = () => {
      request.destroy();
    };

    request.on('error', settle);
    request.on('close', settle);
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      settle();
    });
    request.end(body);
  } catch {
    // Analytics must never affect command behavior.
    settle();
  }
});

const recordAnalyticsEvent = async (input: AnalyticsRecordInput, runtime: AnalyticsRuntime = {}): Promise<void> => {
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

    const analytics = runtime.analyticsConfig ?? readAnalyticsConfig().analytics;
    if (analytics.enabled !== 'true') {
      return;
    }

    const installId = runtime.installId ?? readLocalInstallId(runtime.installIdPath);
    if (!installId) {
      return;
    }

    const payload = buildAnalyticsPayload({
      command: input.command,
      status,
      durationBucket,
      now: input.now ?? new Date(),
    }, installId, runtime.appVersion);
    await (runtime.sender ?? sendAnalyticsPayload)(payload, {
      endpoint: runtime.endpoint ?? productionAnalyticsEndpoint,
      ingestToken: runtime.ingestToken ?? productionAnalyticsIngestToken,
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
): Promise<void> => {
  const nowMs = runtime.nowMs ?? Date.now;
  const startedAt = nowMs();
  const analyticsRuntime = runtime.preserveLocalState ? preserveLocalAnalyticsState(runtime) : runtime;
  process.exitCode = undefined;
  try {
    runCommand();
    return recordAnalyticsEvent({
      command,
      status: analyticsStatusFromExitCode(process.exitCode),
      durationBucket: durationBucketFromMs(Math.max(0, nowMs() - startedAt)),
    }, analyticsRuntime);
  } catch (error) {
    return recordAnalyticsEvent({
      command,
      status: 'failure',
      durationBucket: durationBucketFromMs(Math.max(0, nowMs() - startedAt)),
    }, analyticsRuntime).then(() => {
      throw error;
    });
  }
};

const rethrowCommandError = (error: unknown): void => {
  setImmediate(() => {
    throw error;
  });
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
  rethrowCommandError,
  runWithCommandAnalytics,
  sendAnalyticsPayload,
};
