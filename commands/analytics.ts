const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const os = require('os');
const path = require('path');
const { fetchConfig } = require('../config/index.ts');
const { createConfigStore } = require('../config/store.ts');
const { readCommandOutput, readPromptLine, writeStdoutLine } = require('./commandHelpers.ts');

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
  timeoutMs?: number;
};

type AnalyticsSender = (payload: AnalyticsPayload, options: SenderOptions) => Promise<void>;

type OsVersionCommandReader = (
  command: string,
  args?: string[],
  options?: { timeout?: number },
) => string | null;

type OsVersionOptions = {
  platform?: () => string;
  readCommandOutput?: OsVersionCommandReader;
};

type AnalyticsRuntime = SenderOptions & {
  analyticsConfig?: AnalyticsConfig;
  appVersion?: string;
  env?: NodeJS.ProcessEnv;
  installId?: string | null;
  installIdPath?: string;
  osVersionOptions?: OsVersionOptions;
  sender?: AnalyticsSender;
};

type CommandAnalyticsRuntime = AnalyticsRuntime & {
  nowMs?: () => number;
  preserveLocalState?: boolean;
};

type AnalyticsInstallIdOptions = {
  analyticsConfig?: AnalyticsConfig;
  env?: NodeJS.ProcessEnv;
  generateInstallId?: () => string;
  installIdPath?: string;
  repoDir?: string;
};

type AnalyticsPreferenceOptions = {
  configPath: string;
  defaultEnabled?: boolean;
  docsUrl?: string;
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
]);
const allowedStatuses = new Set(['success', 'failure', 'unknown']);
const allowedDurations = new Set(['unknown', '<1s', '1-10s', '10-60s', '1-10m', '10m+']);
const installIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const defaultAnalyticsDocsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/analytics.md';
const productionAnalyticsEndpoint = 'https://ballin-scripts-analytics.jballin.workers.dev/v1/events';
const analyticsDisclosureFor = (docsUrl = defaultAnalyticsDocsUrl): string => (
  `Ballin can send minimal anonymous usage analytics. Details: ${docsUrl}`
);
const analyticsPromptFor = (defaultEnabled = true): string => (
  `Enable minimal anonymous usage analytics? ${defaultEnabled ? '[Y/n]' : '[y/N]'} `
);
const analyticsPrompt = analyticsPromptFor();

const packageJsonPath = path.join(__dirname, '..', 'package.json');
const defaultRepoDir = path.join(__dirname, '..');

const loadAppVersion = (appPackageJsonPath = packageJsonPath): string => {
  try {
    const packageJson = JSON.parse(fs.readFileSync(appPackageJsonPath, 'utf8')) as { version?: unknown };
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

const commandAnalyticsDisabledByEnv = (env: NodeJS.ProcessEnv): boolean => (
  analyticsDisabledByEnv(env) || env.BALLIN_NO_COMMAND_ANALYTICS === '1'
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

const writeAnalyticsPreference = (configPath: string, enabled: boolean): boolean => {
  const temporary = `${configPath}.${process.pid}.analytics.tmp`;
  let created = false;
  try {
    const config = fs.readFileSync(configPath);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    created = true;
    try { fs.writeFileSync(fd, config); } finally { fs.closeSync(fd); }
    if (!createConfigStore({ configPath: temporary }).writeLeafValue('analytics.enabled', String(enabled))) {
      return false;
    }
    fs.renameSync(temporary, configPath);
    return true;
  } catch {
    return false;
  } finally {
    if (created) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* Best-effort private staging cleanup. */ }
    }
  }
};

const configureAnalyticsPreference = (options: AnalyticsPreferenceOptions): boolean => {
  writeStdoutLine(`\n${analyticsDisclosureFor(options.docsUrl)}`);
  const defaultEnabled = options.defaultEnabled ?? true;
  let response: { text: string; eof: boolean };
  try {
    response = readPromptLine(analyticsPromptFor(defaultEnabled));
  } catch {
    return false;
  }
  if (response.eof) return true;

  const enabled = response.text === ''
    ? defaultEnabled
    : response.text === 'y' || response.text === 'Y';
  if (writeAnalyticsPreference(options.configPath, enabled)) {
    return true;
  }
  writeStdoutLine('\nUnable to save the analytics preference; the existing local setting is unchanged.');
  return false;
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

  const installId = (options.generateInstallId ?? crypto.randomUUID)();
  return writeLocalInstallId(installId, installIdPath) ? installId : null;
};

const dateBucket = (now: Date): string => now.toISOString().slice(0, 10);

const nodeMajor = (): string => process.versions.node.split('.')[0];

const coarseOsVersion = (options: OsVersionOptions = {}): string => {
  try {
    const platform = (options.platform ?? os.platform)();
    if (platform !== 'darwin') {
      return 'unknown';
    }

    const version = (options.readCommandOutput ?? readCommandOutput)(
      '/usr/bin/sw_vers',
      ['-productVersion'],
      { timeout: defaultTimeoutMs },
    );
    if (typeof version !== 'string') {
      return 'unknown';
    }

    const [major, minor] = version.trim().split('.');
    if (!major || !/^[0-9]+$/.test(major)) {
      return 'unknown';
    }
    if (minor && !/^[0-9]+$/.test(minor)) {
      return 'unknown';
    }
    return minor ? `${major}.${minor}` : major;
  } catch {
    return 'unknown';
  }
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
  osVersionOptions: OsVersionOptions = {},
): AnalyticsPayload => {
  return {
    schemaVersion,
    installId,
    dateBucket: dateBucket(input.now),
    command: input.command,
    status: input.status,
    durationBucket: input.durationBucket,
    appVersion,
    nodeMajor: nodeMajor(),
    osVersion: coarseOsVersion(osVersionOptions),
  };
};

const requestOptions = (endpoint: string): RequestOptions => {
  const url = new URL(endpoint);
  return {
    method: 'POST',
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    headers: {
      'content-type': 'application/json',
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

  if (!options.endpoint) {
    settle();
    return;
  }

  try {
    const body = JSON.stringify(payload);
    const optionsWithHeaders = requestOptions(options.endpoint);
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
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
    wallClockTimeout = setTimeout(() => {
      request.destroy();
      settle();
    }, timeoutMs);
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
    if (commandAnalyticsDisabledByEnv(env)) {
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
    }, installId, runtime.appVersion, runtime.osVersionOptions);
    await (runtime.sender ?? sendAnalyticsPayload)(payload, {
      endpoint: runtime.endpoint ?? productionAnalyticsEndpoint,
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
  analyticsDisclosureFor,
  analyticsPrompt,
  analyticsPromptFor,
  buildAnalyticsPayload,
  coarseOsVersion,
  configureAnalyticsPreference,
  durationBucketFromMs,
  ensureAnalyticsInstallId,
  installIdPathForRepo,
  loadAppVersion,
  readLocalInstallId,
  recordAnalyticsEvent,
  rethrowCommandError,
  runWithCommandAnalytics,
  sendAnalyticsPayload,
};
