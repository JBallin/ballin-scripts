const { isAbsolute, resolve } = require('node:path');
const { readdirSync, readFileSync } = require('node:fs');
const debuglog = require('node:util').debuglog('c8');

type ProcessCoverage = { result: { url: string }[] };
type C8Report = {
  tempDirectory: string;
  _loadReports: () => Iterable<ProcessCoverage>;
  _normalizeProcessCov: (coverage: ProcessCoverage, fileIndex: Set<string>) => ProcessCoverage;
};

// c8 12.0.0 omits executed absolute paths from the --all file index.
// Keep the correction in the reporter process; child tests receive no preload.
function installC8PathIndexCorrection(): void {
  const { version } = require('c8/package.json') as { version: string };
  if (version !== '12.0.0') {
    throw new Error('Review the c8 coverage compatibility wrapper before changing c8 versions.');
  }
  const createReport = require('c8/lib/report.js') as (options: object) => C8Report;
  const prototype = Object.getPrototypeOf(createReport({})) as C8Report;
  if (typeof prototype._loadReports !== 'function') {
    throw new Error('The installed c8 report does not expose the reviewed coverage loader.');
  }
  // c8 12 loads every raw JSON profile before filtering. Yield one at a time
  // into its existing normalizer, then retain its standard single merge. The
  // built-in pairwise merge mode changes branch accounting on recorded inputs.
  prototype._loadReports = function* () {
    for (const file of readdirSync(this.tempDirectory)) {
      let coverage: ProcessCoverage;
      try { coverage = JSON.parse(readFileSync(resolve(this.tempDirectory, file), 'utf8')); }
      catch (error) { debuglog(`${(error as Error).stack}`); continue; }
      yield coverage;
    }
  };
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
