const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const yaml = require('js-yaml');
const { testChildEnvironment } = require('./helpers/environment.ts');

type Git = (args: string[]) => Buffer;
let selectChecks: (name: string, event: object, sha: string, git: Git) => boolean;
const detector = path.resolve(__dirname, '../.github/scripts/supplemental-checks.mjs');
const sha = 'a'.repeat(40);
const base = 'b'.repeat(40);
const event = { before: base, pull_request: { base: { sha: base } } };

before(async () => {
  ({ selectChecks } = await import(pathToFileURL(detector).href));
});

describe('supplemental CI selection', () => {
  const fakeGit = (paths: string[], calls: string[][] = []): Git => (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return Buffer.from(args[1] === 'HEAD' ? sha : base);
    return Buffer.from(args[0] === 'diff' ? paths.map((name) => `${name}\0`).join('') : '');
  };

  for (const name of [
    '.github/workflows/ci.yml', '.github/scripts/supplemental-checks.mjs',
    'test/ci/claude_preflight.test.ts', 'test/claude_workflows.test.ts',
    'test/supplemental_checks.test.ts', 'test/setup.ts', 'test/helpers/environment.ts',
    'config/.defaultConfig.json', 'package.json', 'package-lock.json', '.mocharc.yml',
    '.mocharc.json', '.nvmrc', '.npmrc', '.github/line\nbreak\tfile',
  ]) it(`runs for ${JSON.stringify(name)}`, () => {
    assert.isTrue(selectChecks('push', event, sha, fakeGit([name])));
  });

  it('skips unrelated paths, empty diffs, and misleading prefixes', () => {
    for (const paths of [[], ['README.md', 'commands/backup.ts', 'docs/.npmrc', '.github-other/a', 'package.json.old']]) {
      assert.isFalse(selectChecks('push', event, sha, fakeGit(paths)));
    }
  });

  it('uses event before for multi-commit pushes and the tested merge tree for PRs', () => {
    for (const name of ['push', 'pull_request']) {
      const calls: string[][] = [];
      assert.isFalse(selectChecks(name, event, sha, fakeGit(['README.md'], calls)));
      assert.deepEqual(calls.at(-1), ['diff', '--name-only', '-z', '--no-renames', base, sha, '--']);
      if (name === 'pull_request') assert.deepInclude(calls, ['rev-parse', 'HEAD^1']);
    }
  });

  it('runs for manual, unknown, missing, zero, malformed and mismatched revisions', () => {
    for (const name of ['workflow_dispatch', 'unknown']) {
      assert.isTrue(selectChecks(name, event, sha, fakeGit([])));
    }
    for (const before of [undefined, '0'.repeat(40), '--option', 12]) {
      assert.isTrue(selectChecks('push', { before }, sha, fakeGit([])));
    }
    assert.isTrue(selectChecks('push', event, '0'.repeat(40), fakeGit([])));
    assert.isTrue(selectChecks('push', event, base, fakeGit([])));
    assert.isTrue(selectChecks('pull_request', { pull_request: { base: { sha } } }, sha, fakeGit([])));
    assert.isTrue(selectChecks('pull_request', {}, sha, fakeGit([])));
  });

  it('fetches only an unavailable base and runs on any Git failure', () => {
    const calls: string[][] = [];
    const git = fakeGit([], calls);
    const missing: Git = (args) => {
      if (args[0] === 'cat-file') throw new Error('missing base');
      return git(args);
    };
    assert.isFalse(selectChecks('push', event, sha, missing));
    assert.deepInclude(calls, ['fetch', '--no-tags', '--depth=1', 'origin', base]);
    for (const failure of ['rev-parse', 'fetch', 'diff']) {
      assert.isTrue(selectChecks('push', event, sha, (args) => {
        if (args[0] === failure || (failure === 'fetch' && args[0] === 'cat-file')) throw new Error('failure');
        return git(args);
      }));
    }
  });

  it('handles real multi-commit pushes, deletion, rename and PR merge results', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-ci-selection-'));
    try {
      const env = testChildEnvironment({ PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
      const git: Git = (args) => execFileSync('/usr/bin/git', args, { cwd: root, env });
      const commit = () => { git(['add', '.']); git(['commit', '-qm', 'fixture']); return git(['rev-parse', 'HEAD']).toString().trim(); };
      git(['init', '-q', '-b', 'main']);
      fs.writeFileSync(path.join(root, 'package.json'), '{}');
      const first = commit();
      fs.renameSync(path.join(root, 'package.json'), path.join(root, 'unrelated\nfile'));
      commit();
      fs.writeFileSync(path.join(root, 'README.md'), 'docs');
      const last = commit();
      assert.isTrue(selectChecks('push', { before: first }, last, git));
      git(['checkout', '-qb', 'topic']);
      fs.writeFileSync(path.join(root, 'README.md'), 'topic');
      commit();
      git(['checkout', '-q', 'main']);
      fs.mkdirSync(path.join(root, '.github'));
      fs.writeFileSync(path.join(root, '.github', 'odd\nname\t'), 'base change');
      const prBase = commit();
      git(['merge', '-q', '--no-ff', '-m', 'fixture merge', 'topic']);
      const merge = git(['rev-parse', 'HEAD']).toString().trim();
      // Base-side workflow changes are already in the tested base: only the topic docs differ.
      assert.isFalse(selectChecks('pull_request', { pull_request: { base: { sha: prBase } } }, merge, git));
      fs.rmSync(path.join(root, '.github', 'odd\nname\t'));
      const deletion = commit();
      assert.isTrue(selectChecks('push', { before: merge }, deletion, git));
      fs.writeFileSync(path.join(root, 'README.md'), 'another doc change');
      const docs = commit();
      const eventFile = path.join(root, 'event.json');
      const output = path.join(root, 'output');
      fs.writeFileSync(eventFile, JSON.stringify({ before: deletion }));
      const result = spawnSync(process.execPath, [detector], { cwd: root,
        env: { ...env, GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: eventFile,
          GITHUB_SHA: docs, GITHUB_OUTPUT: output }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(output, 'utf8'), 'run=false\n');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('writes conservative output when event data cannot be read', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-ci-output-'));
    try {
      const output = path.join(root, 'output');
      const result = spawnSync(process.execPath, [detector], { env: testChildEnvironment({
        GITHUB_EVENT_PATH: path.join(root, 'absent'), GITHUB_OUTPUT: output,
      }), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(output, 'utf8'), 'run=true\n');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('CI supplemental workflow contract', () => {
  it('preserves workflow identity, triggers, permissions and unconditional portable gates', () => {
    const workflow = yaml.load(fs.readFileSync(path.resolve(__dirname, '../.github/workflows/ci.yml'), 'utf8'));
    assert.equal(workflow.name, 'CI');
    assert.deepEqual(workflow.on, { pull_request: { branches: ['main'] }, push: { branches: ['main'] }, workflow_dispatch: null });
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.deepEqual(Object.keys(workflow.jobs), ['test']);
    const steps = workflow.jobs.test.steps;
    const guarded = steps.filter((step: { if?: string }) => step.if === "steps.supplemental.outputs.run != 'false'");
    assert.deepEqual(guarded.map((step: { name: string }) => step.name), ['Run actionlint', 'Test Claude preflight with Bash and jq']);
    for (const run of ['npm ci', 'npm run lint', 'npm run typecheck', 'npm run typecheck:analytics-worker', 'npm run test:coverage']) {
      const step = steps.find((step: { run?: string }) => step.run === run);
      assert.isDefined(step);
      assert.isUndefined(step.if);
    }
    assert.deepEqual(steps[0], { name: 'Check out repository', uses: 'actions/checkout@v6', with: { 'fetch-depth': 2 } });
    assert.deepEqual(steps[1], { name: 'Select supplemental checks', id: 'supplemental', run: 'node .github/scripts/supplemental-checks.mjs' });
    assert.include(steps.find((step: { name: string }) => step.name === 'Install shell tools').run, 'shellcheck zsh jq coreutils');
    const pkg = require('../package.json');
    assert.equal(pkg.scripts.test, 'npm run lint && npm run typecheck && npm run typecheck:analytics-worker && npm run test:coverage');
    assert.equal(pkg.scripts['test:claude-preflight'], 'mocha test/ci/claude_preflight.test.ts');
  });
});
