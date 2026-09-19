const fs = require('fs');
const path = require('path');

type CapturedAnalyticsEvent = {
  schemaVersion: number;
  installId: string;
  dateBucket: string;
  command?: string;
  event?: string;
  status: string;
};

const fixtureInstallId = '826f9faa-9995-4f66-a01b-73b4f7aebdf1';

// Every HTTPS request in the child is intercepted; no real network fallback exists.
const createAnalyticsCapture = (rootDir: string) => {
  const captureDir = path.join(rootDir, 'analytics-fixture');
  fs.mkdirSync(captureDir, { recursive: true });
  const installIdPath = path.join(captureDir, 'install-id');
  const eventsPath = path.join(captureDir, 'events.jsonl');
  const preloadPath = path.join(captureDir, 'preload.cjs');
  fs.writeFileSync(installIdPath, `${fixtureInstallId}\n`);
  fs.writeFileSync(preloadPath, `
const fs = require('fs');
const https = require('https');
const { EventEmitter } = require('events');
https.request = (_options, callback) => {
  if (process.env.BALLIN_TEST_ANALYTICS_MODE === 'throw') throw new Error('fixture sender failure');
  const request = new EventEmitter();
  request.setTimeout = () => request;
  request.destroy = () => { request.emit('close'); return request; };
  request.end = (body) => {
    fs.appendFileSync(${JSON.stringify(eventsPath)}, body + '\\n');
    if (process.env.BALLIN_TEST_ANALYTICS_MODE === 'hang') return request;
    setImmediate(() => {
      if (process.env.BALLIN_TEST_ANALYTICS_MODE === 'error') {
        request.emit('error', new Error('fixture sender failure'));
        return;
      }
      const response = new EventEmitter();
      response.resume = () => setImmediate(() => response.emit('end'));
      callback(response);
    });
    return request;
  };
  return request;
};
const analytics = require(${JSON.stringify(path.join(__dirname, '..', '..', 'commands', 'analytics.ts'))});
for (const [name, runtimeIndex] of [['runWithCommandAnalytics', 2], ['ensureAnalyticsInstallId', 0]]) {
  const original = analytics[name];
  analytics[name] = (...args) => {
    args[runtimeIndex] = {
      ...(name === 'runWithCommandAnalytics' ? { osVersionOptions: { platform: () => 'linux' } } : {}),
      ...args[runtimeIndex],
      installIdPath: ${JSON.stringify(installIdPath)},
    };
    return original(...args);
  };
}
`);
  return {
    env: {
      BALLIN_NO_ANALYTICS: undefined,
      NODE_OPTIONS: `--require ${JSON.stringify(preloadPath)}`,
    },
    installIdPath,
    preloadPath,
    readEvents: (): CapturedAnalyticsEvent[] => fs.existsSync(eventsPath)
      ? fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map((line: string) => JSON.parse(line))
      : [],
    clear: (): void => fs.rmSync(eventsPath, { force: true }),
  };
};

module.exports = { createAnalyticsCapture, fixtureInstallId };
export type { CapturedAnalyticsEvent };
