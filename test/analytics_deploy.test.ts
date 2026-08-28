const { assert } = require('chai');
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const deployWorkflowPath = path.join(rootDir, '.github', 'workflows', 'deploy-analytics-worker.yml');
const wranglerConfigPath = path.join(rootDir, 'analytics-worker', 'wrangler.toml.example');

const compareVersions = (left: number[], right: number[]): number => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

describe('analytics Worker deployment', () => {
  it('uses a compatible Wrangler version for the production rate-limit binding', () => {
    const workflow = fs.readFileSync(deployWorkflowPath, 'utf8');
    const config = fs.readFileSync(wranglerConfigPath, 'utf8');
    const versionMatch = workflow.match(/wranglerVersion:\s*["']\^(\d+)\.(\d+)\.(\d+)["']/u);

    assert.match(workflow, /uses:\s*cloudflare\/wrangler-action@v4\b/u);
    assert.isNotNull(versionMatch, 'deployment must declare a caret Wrangler version range');

    const lowerBound = versionMatch?.slice(1).map(Number) ?? [];
    assert.equal(lowerBound[0], 4, 'deployment must stay on the compatible Wrangler 4 line');
    assert.isAtLeast(
      compareVersions(lowerBound, [4, 36, 0]),
      0,
      'rate-limit bindings require Wrangler 4.36.0 or newer',
    );
    assert.match(
      config,
      /\[\[ratelimits\]\][\s\S]*?name\s*=\s*"ANALYTICS_RATE_LIMITER"/u,
    );
  });
});
