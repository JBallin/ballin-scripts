const { availableParallelism } = require('node:os');
const path = require('node:path');

const jobs = availableParallelism() >= 4 ? 2 : 1;

module.exports = {
  // Keep subprocess-heavy suites serial on smaller hosts.
  jobs,
};

// Only prioritize the unfiltered default command; let Mocha own all overrides.
if (jobs === 2 && process.argv.length === 3 && process.argv[2] === '--parallel' && !process.env.MOCHA_OPTIONS) {
  const { lookupFiles } = require('mocha/lib/cli');
  const files = lookupFiles('test', require('./package.json').mocha.extension);
  const lifecycle = path.join('test', 'repository_backup.test.ts');
  const quickstart = path.join('test', 'quickstart.test.ts');
  module.exports.spec = [
    ...files.filter((file) => file === lifecycle),
    ...files.filter((file) => file === quickstart),
    ...files.filter((file) => file !== lifecycle && file !== quickstart),
  ];
}
