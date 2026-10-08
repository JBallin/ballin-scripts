const fs = require('fs');
const os = require('os');
const path = require('path');
const { initializeTestEnvironment } = require('./helpers/environment.ts');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-config-'));
const configPath = path.join(tempDir, 'ballin.config.json');
const defaultConfigPath = path.join(__dirname, '..', 'config', '.defaultConfig.json');

const cleanup = () => {
  fs.rmSync(tempDir, { recursive: true, force: true });
};

try {
  fs.copyFileSync(defaultConfigPath, configPath);
} catch (error) {
  cleanup();
  throw error;
}

// Normalize before test files import production modules or spawn CLI processes.
const restoreEnvironment = initializeTestEnvironment(configPath);
process.once('exit', cleanup);

exports.mochaHooks = {
  afterAll() {
    // Reused parallel workers keep their isolated config until process exit.
    if (process.env.MOCHA_WORKER_ID !== undefined) return;
    cleanup();
    process.removeListener('exit', cleanup);
    restoreEnvironment();
  },
};
