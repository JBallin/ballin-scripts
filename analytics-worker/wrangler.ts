const path = require('path');

const localWranglerPath = (rootDir: string): string => (
  path.join(rootDir, 'analytics-worker', 'node_modules', '.bin', 'wrangler')
);
const missingWranglerMessage = 'Missing local Wrangler. Run npm ci --prefix analytics-worker --include=dev from the repository root.';

module.exports = { localWranglerPath, missingWranglerMessage };
