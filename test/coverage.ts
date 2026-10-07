const { isAbsolute } = require('node:path');

type ProcessCoverage = { result: { url: string }[] };
type C8Report = {
  _normalizeProcessCov: (coverage: ProcessCoverage, fileIndex: Set<string>) => ProcessCoverage;
};

// c8 12.0.0 omits executed absolute paths from the --all file index.
// Keep the correction in the reporter process; child tests receive no preload.
function installC8PathIndexCorrection(): void {
  const { version } = require('c8/package.json') as { version: string };
  if (version !== '12.0.0') {
    throw new Error('Review the c8 absolute-path compatibility correction before changing c8 versions.');
  }
  const createReport = require('c8/lib/report.js') as (options: object) => C8Report;
  const prototype = Object.getPrototypeOf(createReport({})) as C8Report;
  const normalize = prototype._normalizeProcessCov;
  if (typeof normalize !== 'function') {
    throw new Error('The installed c8 report does not expose the reviewed coverage normalizer.');
  }
  prototype._normalizeProcessCov = function (coverage, fileIndex) {
    const normalized = normalize.call(this, coverage, fileIndex);
    for (const script of normalized.result) {
      if (isAbsolute(script.url)) fileIndex.add(script.url);
    }
    return normalized;
  };
}

if (require.main === module) {
  installC8PathIndexCorrection();
  require('c8/bin/c8.js');
}
