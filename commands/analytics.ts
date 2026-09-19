const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const os = require('os');
const path = require('path');
const { fetchConfig } = require('../config/index.ts');
const { createConfigStore } = require('../config/store.ts');
const { readCommandOutput, readPromptLine, writeStdoutLine } = require('./commandHelpers.ts');
const {
  topLevelCommandNames,
} = require('./top_level_commands.ts') as {
  topLevelCommandNames: readonly string[];
};

import type { IncomingMessage } from 'http';
import type { RequestOptions } from 'https';

type AnalyticsConfig = {
  enabled?: string;
};

type CommandAnalyticsPayload = {
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

type BehavioralEvent = 'backup.run' | 'update.backup' | 'update.self-update';
type BehavioralStatus = 'success' | 'failure';
type BehavioralAnalyticsPayload = {
  schemaVersion: 2;
  installId: string;
  dateBucket: string;
  event: BehavioralEvent;
  status: BehavioralStatus;
};
type AnalyticsPayload = CommandAnalyticsPayload | BehavioralAnalyticsPayload;
type BehavioralRecordInput = {
  event: BehavioralEvent;
  status: BehavioralStatus;
  now?: Date;
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
let installIdTemporarySequence = 0;
const allowedCommands = new Set([
  'ballin',
  ...topLevelCommandNames.map((command) => `ballin ${command}`),
]);
const allowedStatuses = new Set(['success', 'failure', 'unknown']);
const allowedBehavioralEvents = new Set(['backup.run', 'update.backup', 'update.self-update']);
const allowedBehavioralStatuses = new Set(['success', 'failure']);
const pendingBehavioralSends = new Set<Promise<void>>();
let currentAnalyticsRuntime: AnalyticsRuntime | undefined;
const allowedDurations = new Set(['unknown', '<1s', '1-10s', '10-60s', '1-10m', '10m+']);
const installIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const defaultAnalyticsDocsUrl = 'https://github.com/JBallin/ballin-scripts/blob/main/docs/analytics.md';
const productionAnalyticsEndpoint = 'https://ballin-scripts-analytics.jballin.workers.dev/v1/events';
const analyticsDisclosureFor = (docsUrl = defaultAnalyticsDocsUrl): string => (
  'Ballin can send minimal anonymous analytics about top-level command usage and outcomes, '
  + 'real backup outcomes, and automatic backup and self-update outcomes during ballin update. '
  + 'Backup contents, destination identities and configuration values are not sent. '
  + `Payload and retention details: ${docsUrl}`
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

const replaceInvalidLocalInstallId = (
  temporary: string,
  installIdPath: string,
): string | null => {
  const lockPath = `${installIdPath}.lock`;
  const promotion = `${temporary}.promotion`;
  let lockCreated = false;
  let promotionCreated = false;
  let removeLock = false;
  try {
    try {
      fs.linkSync(temporary, lockPath);
      lockCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return null;
      }
    }

    const winner = readLocalInstallId(installIdPath);
    if (winner) {
      removeLock = true;
      return winner;
    }
    if (!readLocalInstallId(lockPath)) {
      removeLock = true;
      return null;
    }

    fs.linkSync(lockPath, promotion);
    promotionCreated = true;
    const winnerBeforeCommit = readLocalInstallId(installIdPath);
    if (winnerBeforeCommit) {
      removeLock = true;
      return winnerBeforeCommit;
    }

    fs.renameSync(promotion, installIdPath);
    promotionCreated = false;
    const persisted = readLocalInstallId(installIdPath);
    removeLock = Boolean(persisted);
    return persisted;
  } catch {
    return readLocalInstallId(installIdPath);
  } finally {
    if (promotionCreated) {
      try { fs.rmSync(promotion, { force: true }); } catch { /* Best-effort private staging cleanup. */ }
    }
    if (lockCreated || removeLock) {
      try { fs.rmSync(lockPath, { force: true }); } catch { /* Best-effort lock cleanup. */ }
    }
  }
};

const writeLocalInstallId = (installId: string, installIdPath = installIdPathForRepo()): string | null => {
  const temporary = `${installIdPath}.${process.pid}.${installIdTemporarySequence}.tmp`;
  installIdTemporarySequence += 1;
  let temporaryCreated = false;
  try {
    fs.mkdirSync(path.dirname(installIdPath), { recursive: true });
    const fd = fs.openSync(temporary, 'wx', 0o600);
    temporaryCreated = true;
    try { fs.writeFileSync(fd, `${installId}\n`, 'utf8'); } finally { fs.closeSync(fd); }

    try {
      fs.linkSync(temporary, installIdPath);
      return installId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return null;
      }
    }

    const winner = readLocalInstallId(installIdPath);
    return winner ?? replaceInvalidLocalInstallId(temporary, installIdPath);
  } catch {
    return null;
  } finally {
    if (temporaryCreated) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* Best-effort private staging cleanup. */ }
    }
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
  return writeLocalInstallId(installId, installIdPath);
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
): CommandAnalyticsPayload => {
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
      response.on('error', settle);
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

const recordBehavioralAnalyticsEvent = (
  input: BehavioralRecordInput,
  runtime: AnalyticsRuntime = currentAnalyticsRuntime ?? {},
): Promise<void> => {
  try {
    const env = runtime.env ?? process.env;
    if (analyticsDisabledByEnv(env)
      || !allowedBehavioralEvents.has(input.event)
      || !allowedBehavioralStatuses.has(input.status)) return Promise.resolve();

    const analytics = runtime.analyticsConfig ?? readAnalyticsConfig().analytics;
    if (analytics.enabled !== 'true') return Promise.resolve();
    const installId = runtime.installId === undefined
      ? readLocalInstallId(runtime.installIdPath)
      : runtime.installId;
    if (!installId || !installIdPattern.test(installId)) return Promise.resolve();

    // Capture the terminal outcome now; later synchronous stages may cross UTC midnight.
    const payload: BehavioralAnalyticsPayload = {
      schemaVersion: 2,
      installId,
      dateBucket: dateBucket(input.now ?? new Date()),
      event: input.event,
      status: input.status,
    };
    const sender = runtime.sender ?? sendAnalyticsPayload;
    const options = {
      endpoint: runtime.endpoint ?? productionAnalyticsEndpoint,
      timeoutMs: runtime.timeoutMs ?? defaultTimeoutMs,
    };
    // Start network I/O after synchronous commands yield, so later spawnSync work
    // cannot block a running request's timeout or callbacks.
    const pending = Promise.resolve().then(() => sender(payload, options)).catch(() => {
      // Analytics must never affect command behavior or exit status.
    });
    pendingBehavioralSends.add(pending);
    void pending.then(() => pendingBehavioralSends.delete(pending));
    return pending;
  } catch {
    return Promise.resolve();
  }
};

const flushPendingAnalytics = async (): Promise<void> => {
  await Promise.allSettled([...pendingBehavioralSends]);
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
  const previousRuntime = currentAnalyticsRuntime;
  currentAnalyticsRuntime = analyticsRuntime;
  process.exitCode = undefined;
  try {
    runCommand();
    return Promise.allSettled([recordAnalyticsEvent({
      command,
      status: analyticsStatusFromExitCode(process.exitCode),
      durationBucket: durationBucketFromMs(Math.max(0, nowMs() - startedAt)),
    }, analyticsRuntime), flushPendingAnalytics()]).then(() => {});
  } catch (error) {
    return Promise.allSettled([recordAnalyticsEvent({
      command,
      status: 'failure',
      durationBucket: durationBucketFromMs(Math.max(0, nowMs() - startedAt)),
    }, analyticsRuntime), flushPendingAnalytics()]).then(() => {
      throw error;
    });
  } finally {
    currentAnalyticsRuntime = previousRuntime;
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
  flushPendingAnalytics,
  installIdPathForRepo,
  loadAppVersion,
  readLocalInstallId,
  recordAnalyticsEvent,
  recordBehavioralAnalyticsEvent,
  rethrowCommandError,
  runWithCommandAnalytics,
  sendAnalyticsPayload,
};
