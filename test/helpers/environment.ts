const path = require('path');

const setEnvironment = (values: NodeJS.ProcessEnv): (() => void) => {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (env: NodeJS.ProcessEnv): void => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  return () => apply(previous);
};

// Scoped overrides for synchronous tests; absent values must be deleted, not stringified.
const withEnvironment = <T>(values: NodeJS.ProcessEnv, action: () => T): T => {
  const restore = setEnvironment(values);
  try {
    return action();
  } finally {
    restore();
  }
};

const initializeTestEnvironment = (configPath: string): (() => void) => {
  const values: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    if (/^(BALLIN_|FAKE_|TEST_|ANALYTICS_TEST_)/.test(key)) values[key] = undefined;
  }
  return setEnvironment({
    ...values,
    CI: undefined,
    NODE_ENV: 'test',
    BALLIN_NO_ANALYTICS: '1',
    BALLIN_NO_COMMAND_ANALYTICS: undefined,
    BALLIN_TEST_CONFIG_PATH: configPath,
  });
};

// Keep c8 instrumentation explicit alongside the isolated fixture inputs.
// Node also propagates NODE_V8_COVERAGE to existing complete-environment fixtures.
const testChildEnvironment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const configPath = process.env.BALLIN_TEST_CONFIG_PATH;
  if (!configPath) throw new Error('Load test/setup.ts before creating a child test environment');
  const env: NodeJS.ProcessEnv = {
    HOME: path.dirname(configPath),
    PATH: path.dirname(process.execPath),
    NODE_ENV: 'test',
    BALLIN_TEST_CONFIG_PATH: configPath,
    BALLIN_NO_ANALYTICS: '1',
    NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
};

module.exports = {
  initializeTestEnvironment,
  testChildEnvironment,
  withEnvironment,
};
