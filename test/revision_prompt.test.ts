const fs = require('node:fs');
const path = require('node:path');
const { createSandbox, cleanupSandbox, runSandbox, sandboxSuiteTimeout } = require('./helpers/onboarding.ts');
const { runInteractiveSetup } = require('./helpers/interactive_setup.ts');

describe('revision confirmation in a real terminal', function() {
  this.timeout(sandboxSuiteTimeout);
  for (const answer of ['yes', 'no', '']) it(`waits for delayed ${JSON.stringify(answer)} without making stdin nonblocking`, () => {
    const sandbox = createSandbox({ quickstart: true });
    try {
      const install = runSandbox(sandbox, ['quickstart'], 'no\nno\nlogin\nyes\nyes\nno\nno\n');
      assert.equal(install.status, 0, install.stdout + install.stderr);
      const sha = 'a'.repeat(40);
      const r = runInteractiveSetup(sandbox, [process.execPath, path.resolve(__dirname, '../commands/repo_update.ts'), 'apply', sandbox.repo, 'sha', sha, sha, '24.12.0', '-', 'install', 'false'], [
        { prompt: 'Change the installed revision/track? [y/N]', answer },
      ]);
      assert.equal(r.status, answer === 'yes' ? 0 : 20, r.stdout + r.stderr);
      assert.include(r.stdout, '\x1b[0;32m?\x1b[0m Change the installed revision/track? [y/\x1b[1mN\x1b[0m] ');
      assert.include(r.stdout, '\x1b[36m' + (answer === 'yes' ? 'Yes' : 'No') + '\x1b[0m');
      assert.notInclude(r.stdout + r.stderr, 'EAGAIN');
      const receipt = JSON.parse(fs.readFileSync(path.join(sandbox.repo, '.git/ballin-install.json'), 'utf8'));
      assert.equal(receipt.kind, answer === 'yes' ? 'sha' : 'branch');
    } finally { cleanupSandbox(sandbox.root); }
  });
  it('reprompts a completed invalid answer and accepts one subsequent Enter in a real terminal', () => {
    const sandbox = createSandbox({ quickstart: true });
    try {
      const installed = runSandbox(sandbox, ['quickstart'], 'no\nno\nlogin\nyes\nyes\nno\nno\n');
      assert.equal(installed.status, 0, installed.stdout + installed.stderr);
      const sha = 'a'.repeat(40);
      const result = runInteractiveSetup(sandbox, [process.execPath, path.resolve(__dirname, '../commands/repo_update.ts'), 'apply', sandbox.repo, 'sha', sha, sha, '24.12.0', '-', 'install', 'false'], [
        { prompt: 'Change the installed revision/track? [y/N]', answer: 'maybe' },
        { prompt: 'Please enter yes or no.', answer: 'Y' },
      ]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, 'Please enter yes or no.');
      assert.include(result.stdout, '\x1b[36mYes\x1b[0m');
      assert.notInclude(result.stdout, '\x1b[36mmaybe');
      assert.equal(JSON.parse(fs.readFileSync(path.join(sandbox.repo, '.git/ballin-install.json'), 'utf8')).kind, 'sha');
    } finally { cleanupSandbox(sandbox.root); }
  });
  for (const mode of ['dumb', 'NO_COLOR']) it(`keeps standalone helper consent plain for ${mode}`, () => {
    const sandbox = createSandbox({ quickstart: true });
    try {
      const installed = runSandbox(sandbox, ['quickstart'], 'no\nno\nlogin\nyes\nyes\nno\nno\n');
      assert.equal(installed.status, 0, installed.stdout + installed.stderr);
      const sha = 'a'.repeat(40);
      const command = [process.execPath, path.resolve(__dirname, '../commands/repo_update.ts'), 'apply', sandbox.repo, 'sha', sha, sha, '24.12.0', '-', 'install', 'false'];
      const result = runInteractiveSetup(sandbox, mode === 'NO_COLOR' ? ['/usr/bin/env', 'NO_COLOR=0', ...command] : command, [
        { prompt: 'Change the installed revision/track? [y/N]', answer: 'no' },
      ], undefined, { term: mode === 'dumb' ? 'dumb' : 'xterm' });
      assert.equal(result.status, 20, result.stdout + result.stderr);
      assert.include(result.stdout, '? Change the installed revision/track? [y/N] ');
      assert.notMatch(result.stdout, /\x1b\[[0-9;]*m/u);
    } finally { cleanupSandbox(sandbox.root); }
  });
  it('returns cleanly from a cancelled installer track change without setup or false success', () => {
    const sandbox = createSandbox({ quickstart: true });
    try {
      const installed = runSandbox(sandbox, ['quickstart'], 'no\nno\nlogin\nyes\nyes\nno\nno\n');
      assert.equal(installed.status, 0, installed.stdout + installed.stderr);
      const file = path.join(sandbox.repo, '.git/ballin-install.json');
      const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
      receipt.kind = 'sha'; receipt.value = receipt.sha;
      fs.writeFileSync(file, JSON.stringify(receipt));
      const result = runInteractiveSetup(sandbox, [path.join(sandbox.source, 'install.sh')], [
        { prompt: 'Change the installed revision/track? [y/N]', answer: 'no' },
      ]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, 'Revision change cancelled. The installed checkout is unchanged.');
      assert.notInclude(result.stdout, 'ERROR:'); assert.notInclude(result.stdout, 'Setup complete.');
      assert.notInclude(result.stdout, 'Review your update and analytics');
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), receipt);
    } finally { cleanupSandbox(sandbox.root); }
  });

});
