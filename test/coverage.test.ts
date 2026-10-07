const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { testChildEnvironment } = require('./helpers/environment.ts');

type RawScript = {
  scriptId: string;
  url: string;
  functions: {
    functionName: string;
    ranges: { startOffset: number; endOffset: number; count: number }[];
    isBlockCoverage: boolean;
  }[];
};
type Cell = {
  cell: string;
  source: { sha256: string };
  scripts: RawScript[];
};
type FileCoverage = {
  fnMap: Record<string, { name: string }>;
  f: Record<string, number>;
};
const { cells } = require('./fixtures/coverage-identity/profiles.json') as { cells: Cell[] };
const wrapper = path.resolve(__dirname, 'coverage.ts');
const vanilla = require.resolve('c8/bin/c8.js');
const root = path.resolve(__dirname, '..');

function report(cell: Cell, corrected: boolean, options: {
  mergeAsync?: boolean; unexecutedFile?: boolean; uncalledFunction?: boolean;
  mixedPaths?: boolean; checkCoverageFalse?: boolean;
} = {}) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-c8-')));
  try {
    const extension = cell.cell.endsWith('-ts') ? 'ts' : 'cjs';
    const subject = path.join(temp, `backup cache ü.${extension}`);
    const source = extension === 'ts'
      ? path.join(root, 'commands/backup_cache.ts')
      : path.join(__dirname, 'fixtures/coverage-identity/backup_cache.cjs');
    const bytes = fs.readFileSync(source);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), cell.source.sha256);
    fs.writeFileSync(subject, bytes);
    const scripts = structuredClone(cell.scripts);
    for (const script of scripts) {
      script.url = script.url.startsWith('file://') ? pathToFileURL(subject).href : subject;
      if (options.uncalledFunction) {
        script.functions.find(fn => fn.functionName === 'repositoryCacheDirectory')!.ranges[0].count = 0;
      }
    }
    if (options.mixedPaths) {
      const duplicate = structuredClone(scripts[0]);
      duplicate.scriptId = 'mixed-path-control';
      duplicate.url = duplicate.url.startsWith('file://') ? subject : pathToFileURL(subject).href;
      scripts.push(duplicate);
    }
    const raw = path.join(temp, 'raw');
    const output = path.join(temp, 'report');
    fs.mkdirSync(raw);
    fs.writeFileSync(path.join(raw, 'coverage-1-1-0.json'), JSON.stringify({ result: scripts }));
    const unexecuted = path.join(temp, `unexecuted.${extension}`);
    if (options.unexecutedFile) fs.writeFileSync(unexecuted, bytes);
    const config = path.join(temp, 'c8.json');
    const thresholds = require('../package.json').c8;
    fs.writeFileSync(config, JSON.stringify({
      all: thresholds.all, extension: ['.ts', '.cjs'],
      include: ['*.ts', '*.cjs'], exclude: [], reporter: ['json', 'json-summary'],
      'check-coverage': thresholds['check-coverage'],
      statements: thresholds.statements, lines: thresholds.lines,
      branches: thresholds.branches, functions: thresholds.functions,
    }));
    const args = [corrected ? wrapper : vanilla, 'report', '--config', config,
      '--temp-directory', raw, '--reports-dir', output];
    if (options.mergeAsync) args.push('--merge-async');
    if (options.checkCoverageFalse) args.push('--check-coverage=false');
    const result = spawnSync(process.execPath, args, {
      cwd: temp, encoding: 'utf8', timeout: 8000,
      env: testChildEnvironment({ HOME: temp, TMPDIR: temp, NODE_V8_COVERAGE: undefined }),
    });
    assert.isUndefined(result.error, result.stderr);
    assert.isNull(result.signal);
    const coverage = JSON.parse(fs.readFileSync(path.join(output, 'coverage-final.json'), 'utf8')) as Record<string, FileCoverage>;
    const summary = JSON.parse(fs.readFileSync(path.join(output, 'coverage-summary.json'), 'utf8')).total;
    return { status: result.status, stderr: result.stderr, summary,
      subject: { ...coverage[subject], path: path.basename(subject) }, unexecuted: coverage[unexecuted],
      files: Object.keys(coverage).map(filename => path.basename(filename)).sort() };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

describe('c8 absolute-path compatibility', () => {
  for (const cell of cells) {
    it(`reports preserved ${cell.cell} coverage without changing real function counts`, () => {
      const before = report(cell, false);
      const after = report(cell, true);
      assert.equal(after.status, 0, after.stderr);
      for (const metric of ['statements', 'lines', 'branches', 'functions']) {
        assert.equal(after.summary[metric].pct, 100);
      }
      assert.deepEqual(after.files, before.files);
      const named = Object.entries(after.subject.fnMap)
        .find(([, fn]) => fn.name === 'repositoryCacheDirectory')!;
      assert.equal(after.subject.f[named[0]], 2);
      assert.deepEqual(Object.values(after.subject.fnMap).map(fn => fn.name), ['repositoryCacheDirectory']);
      if (cell.cell === '01-v2415-ts') {
        assert.equal(before.status, 1);
        assert.equal(before.summary.statements.pct, 0);
        assert.equal(before.summary.functions.pct, 50);
        assert.include(Object.values(before.subject.fnMap).map(fn => fn.name), '(empty-report)');
      } else {
        assert.equal(before.status, 0, before.stderr);
        assert.deepEqual(after.subject, before.subject);
      }
    });
  }

  it('indexes absolute paths during asynchronous merging', () => {
    const result = report(cells[0], true, { mergeAsync: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.summary.functions.pct, 100);
    assert.notExists(result.unexecuted);
  });

  it('merges mixed absolute paths and file URLs without adding an empty report', () => {
    const result = report(cells[0], true, { mixedPaths: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.summary.functions.pct, 100);
    assert.deepEqual(Object.values(result.subject.f), [4]);
    assert.lengthOf(result.files, 1);
  });

  it('keeps genuinely unexecuted included files uncovered and fails the strict gate', () => {
    const result = report(cells[0], true, { unexecutedFile: true });
    assert.equal(result.status, 1);
    assert.isBelow(result.summary.functions.pct, 100);
    assert.isDefined(result.unexecuted);
    assert.isTrue(Object.values(result.unexecuted.f).every(count => count === 0));
    assert.lengthOf(result.files, 2);
  });

  it('preserves zero real-function counts and fails the strict gate', () => {
    const result = report(cells[0], true, { uncalledFunction: true });
    assert.equal(result.status, 1);
    assert.equal(result.summary.functions.pct, 0);
    assert.isTrue(Object.values(result.subject.f).every(count => count === 0));
    assert.notInclude(Object.values(result.subject.fnMap).map(fn => fn.name), '(empty-report)');
  });

  it('forwards the existing CI diagnostic override while retaining failing coverage data', () => {
    const result = report(cells[0], true, { uncalledFunction: true, checkCoverageFalse: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.summary.functions.pct, 0);
    assert.isTrue(Object.values(result.subject.f).every(count => count === 0));
  });

  it('loads silently during test discovery', () => {
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(wrapper)})`], {
      encoding: 'utf8', timeout: 8000,
      env: testChildEnvironment({ NODE_V8_COVERAGE: undefined }),
    });
    assert.isUndefined(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  it('instruments a child and preserves its nonzero exit status', () => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-c8-child-')));
    try {
      const subject = path.join(temp, 'fixture.ts');
      fs.writeFileSync(subject, 'module.exports = () => 7;\n');
      const config = path.join(temp, 'c8.json');
      const thresholds = require('../package.json').c8;
      fs.writeFileSync(config, JSON.stringify({
        ...thresholds, include: ['fixture.ts'], exclude: [], reporter: ['json', 'json-summary'],
      }));
      const output = path.join(temp, 'report');
      const code = `
        require('node:assert/strict').equal(require(${JSON.stringify(subject)})(), 7);
        require('node:assert/strict').equal(process.env.NODE_OPTIONS, undefined);
        process.exitCode = 23;
      `;
      const result = spawnSync(process.execPath, [wrapper, '--config', config,
        '--temp-directory', path.join(temp, 'raw'), '--reports-dir', output,
        process.execPath, '-e', code], {
        cwd: temp, encoding: 'utf8', timeout: 8000,
        env: testChildEnvironment({ HOME: temp, TMPDIR: temp, NODE_V8_COVERAGE: undefined }),
      });
      assert.isUndefined(result.error, result.stderr);
      assert.isNull(result.signal);
      assert.equal(result.status, 23, result.stderr || result.stdout);
      const summary = JSON.parse(fs.readFileSync(path.join(output, 'coverage-summary.json'), 'utf8')).total;
      assert.equal(summary.functions.pct, 100);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
