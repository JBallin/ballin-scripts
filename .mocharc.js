const { availableParallelism } = require('node:os');

module.exports = {
  // Keep subprocess-heavy suites serial on smaller hosts.
  jobs: availableParallelism() >= 4 ? 2 : 1,
};
