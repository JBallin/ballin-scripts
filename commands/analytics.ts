const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const os = require('os');
const path = require('path');
const { configPath, fetchConfig, stringify } = require('../config/index.ts');

import type { ClientRequest, IncomingMessage } from 'http';
import type { RequestOptions } from 'https';

type AnalyticsConfig = {
  enabled?: string;
  noticeShown?: string;
  installId?: string | null;
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
  isInteractive?: boolean;
  noticeWriter?: (message: string) => void;
  sender?: AnalyticsSender;
  generateInstallId?: () => string;
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
const analyticsNotice = [
  'ballin-scripts collects minimal anonymous command analytics.',
  'No command arguments, paths, usernames, Gist IDs, dotfiles, package lists, raw errors, or environment values are sent.',
  'Opt out with: ballin_config set analytics.enabled false',
  'Or for a single environment: BALLIN_NO_ANALYTICS=1',
].join('\n');

const packageJsonPath = path.join(__dirname, '..', 'package.json');

const loadAppVersion = (): string => {
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
    return typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
};

const defaultNoticeWriter = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

const isInteractiveRun = (): boolean => Boolean(process.stdin.isTTY && process.stderr.isTTY);

const isAnalyticsConfig = (value: unknown): value is AnalyticsConfig => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const readAnalyticsConfig = (): { root: ConfigObject; analytics: AnalyticsConfig } => {
  const { configObj } = fetchConfig() as { configObj: ConfigObject };
  return {
    root: configObj,
    analytics: isAnalyticsConfig(configObj.analytics) ? configObj.analytics : {},
  };
};

const writeAnalyticsConfig = (root: ConfigObject, analytics: AnalyticsConfig): void => {
  root.analytics = analytics;
  fs.writeFileSync(configPath, stringify(root), 'utf8');
};

const analyticsDisabledByEnv = (env: NodeJS.ProcessEnv): boolean => (
  env.BALLIN_NO_ANALYTICS === '1' || Boolean(env.CI)
);

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
    request.setTimeout(options.timeoutMs ?? defaultTimeoutMs, () => {
      request.destroy();
    });
    request.end(body);
    request.unref();
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

    const { root, analytics } = readAnalyticsConfig();
    if (analytics.enabled !== 'true') {
      return;
    }

    let installId = analytics.installId;
    if (analytics.noticeShown !== 'true') {
      const interactive = runtime.isInteractive ?? isInteractiveRun();
      if (!interactive) {
        return;
      }
      (runtime.noticeWriter ?? defaultNoticeWriter)(analyticsNotice);
      installId = (runtime.generateInstallId ?? crypto.randomUUID)();
      writeAnalyticsConfig(root, {
        ...analytics,
        noticeShown: 'true',
        installId,
      });
    } else if (!installId) {
      installId = (runtime.generateInstallId ?? crypto.randomUUID)();
      writeAnalyticsConfig(root, {
        ...analytics,
        installId,
      });
    }
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

module.exports = {
  analyticsDisabledByEnv,
  analyticsNotice,
  buildAnalyticsPayload,
  recordAnalyticsEvent,
  sendAnalyticsPayload,
};
