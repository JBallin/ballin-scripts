const fs = require('node:fs');
const path = require('node:path');
const { createSandbox, cleanupSandbox, runSandbox, sandboxSuiteTimeout } = require('./helpers/onboarding.ts');
const { runInteractiveSetup } = require('./helpers/interactive_setup.ts');

describe('revision confirmation in a real terminal', function() {
  this.timeout(sandboxSuiteTimeout);
  for (const answer of ['yes', 'no']) it(`waits for delayed ${answer} without making stdin nonblocking`, () => {
    const sandbox = createSandbox({ quickstart: true });
    try {
      const install = runSandbox(sandbox, ['quickstart'], 'no\nno\nlogin\nyes\nyes\nno\nno\n');
      assert.equal(install.status, 0, install.stdout + install.stderr);
      const sha = 'a'.repeat(40);
      const r = runInteractiveSetup(sandbox, [process.execPath, path.resolve(__dirname, '../commands/repo_update.ts'), 'apply', sandbox.repo, 'sha', sha, sha, '24.12.0', '-', 'install', 'false'], [
        { prompt: 'Change the installed revision/track? [y/N]', answer },
      ]);
      assert.equal(r.status, answer === 'yes' ? 0 : 1, r.stdout + r.stderr);
      assert.notInclude(r.stdout + r.stderr, 'EAGAIN');
      const receipt = JSON.parse(fs.readFileSync(path.join(sandbox.repo, '.git/ballin-install.json'), 'utf8'));
      assert.equal(receipt.kind, answer === 'yes' ? 'sha' : 'branch');
    } finally { cleanupSandbox(sandbox.root); }
  });
});
