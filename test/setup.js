const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-config-'));
const configPath = path.join(tempDir, 'ballin.config.json');
const defaultConfigPath = path.join(__dirname, '..', 'config', '.defaultConfig.json');
const previousConfigPath = process.env.BALLIN_TEST_CONFIG_PATH;

const cleanup = () => {
  fs.rmSync(tempDir, { recursive: true, force: true });
};

try {
  fs.copyFileSync(defaultConfigPath, configPath);
} catch (error) {
  cleanup();
  throw error;
}

process.env.BALLIN_TEST_CONFIG_PATH = configPath;
process.once('exit', cleanup);

exports.mochaHooks = {
  afterAll() {
    cleanup();
    process.removeListener('exit', cleanup);
    if (previousConfigPath === undefined) {
      delete process.env.BALLIN_TEST_CONFIG_PATH;
    } else {
      process.env.BALLIN_TEST_CONFIG_PATH = previousConfigPath;
    }
  },
};
