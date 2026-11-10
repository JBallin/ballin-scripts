const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const github = path.join(__dirname, '..', '.github');
const workflow = yaml.load(fs.readFileSync(path.join(github, 'workflows', 'ci.yml'), 'utf8'));

describe('CI Bash file discovery', () => {
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-ci-bash-'));
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    env = { PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    execFileSync('git', ['init', '-q', repo], { env });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function track(files: Record<string, string>) {
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(repo, name), content);
    execFileSync('git', ['add', '--', '.'], { cwd: repo, env });
  }

  function run(name: string) {
    const step = workflow.jobs.test.steps.find((step: { name: string }) => step.name === name);
    // Explicit bash selects GitHub Actions' -eo pipefail invocation.
    assert.equal(step.shell, 'bash');
    return spawnSync('/bin/bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], {
      cwd: repo, env, encoding: 'utf8', timeout: 10_000,
    });
  }

  for (const [name, tool, args] of [
    ['Check Bash syntax', 'bash', ['-n']],
    ['Run ShellCheck', 'shellcheck', []],
  ] as const) {
    function stub(exitCode = 0) {
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, tool), `#!${process.execPath}\n`
        + `require('fs').appendFileSync(${JSON.stringify(path.join(root, 'calls'))}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`
        + `process.exit(${exitCode});\n`, { mode: 0o755 });
      env.PATH = `${bin}:${env.PATH}`;
    }

    it(`${name} selects only first-line Bash shebangs and preserves unusual filenames`, () => {
      const scripts = ['extensionless', 'space name.sh', 'tab\tname', 'line\nname', '-leading-option'];
      track({
        ...Object.fromEntries(scripts.map((file, i) => [file,
          i % 2 ? '#!/usr/bin/env bash\necho ok\n' : '#!/bin/bash\necho ok\n'])),
        'fixture.cjs': "const fixture = `\n#!/bin/bash\necho fixture\n`;\n",
        'not-bash.sh': '#!/bin/sh\necho ok\n',
        'node-script': '#!/usr/bin/env node\n// #!/bin/bash\n',
        'empty.sh': '',
        'no-final-newline': '#!/bin/bash',
      });
      fs.writeFileSync(path.join(repo, 'untracked'), '#!/bin/bash\n');
      stub();
      const result = run(name);
      assert.equal(result.status, 0, result.stderr);
      const calls: string[][] = fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n')
        .map((line: string) => JSON.parse(line));
      assert.sameDeepMembers(calls, [...scripts, 'no-final-newline'].map(file => [...args, `./${file}`]));
    });

    it(`${name} succeeds when no Bash scripts are tracked`, () => {
      track({ 'fixture.cjs': 'const text = `\n#!/bin/bash\n`;\n' });
      stub();
      const result = run(name);
      assert.equal(result.status, 0, result.stderr);
      assert.isFalse(fs.existsSync(path.join(root, 'calls')));
    });

    it(`${name} propagates validation failures`, () => {
      track({ 'a-invalid': '#!/bin/bash\n', 'z-valid': '#!/bin/bash\n' });
      stub(7);
      const result = run(name);
      assert.equal(result.status, 7, result.stderr);
      assert.equal(fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').length, 1);
    });

    it(`${name} propagates Git discovery failures`, () => {
      fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });
      assert.notEqual(run(name).status, 0);
    });

    it(`${name} propagates failures to read tracked files`, () => {
      track({ 'missing': '#!/bin/bash\n' });
      fs.unlinkSync(path.join(repo, 'missing'));
      const result = run(name);
      assert.notEqual(result.status, 0);
      assert.include(result.stderr, 'missing');
    });
  }

  it('rejects an actual invalid Bash script while ignoring an embedded fixture shebang', () => {
    track({ 'fixture.cjs': 'const text = `\n#!/bin/bash\n`;\n', 'script': '#!/bin/bash\necho ok\n' });
    assert.equal(run('Check Bash syntax').status, 0);
    fs.writeFileSync(path.join(repo, 'script'), '#!/bin/bash\nif\n');
    const result = run('Check Bash syntax');
    assert.notEqual(result.status, 0);
    assert.include(result.stderr, 'syntax error');
  });
});

describe('Ubuntu CI prerequisites', () => {
  it('uses fixed runner labels, with macOS reserved for native tests', () => {
    for (const filename of fs.readdirSync(path.join(github, 'workflows'))) {
      const config = yaml.load(fs.readFileSync(path.join(github, 'workflows', filename), 'utf8'));
      for (const [name, job] of Object.entries(config.jobs)) {
        const runner = (job as { 'runs-on'?: string })['runs-on'];
        if (runner !== undefined) assert.equal(runner,
          filename === 'macos.yml' && name === 'native' ? 'macos-26' : 'ubuntu-26.04', `${filename}: ${name}`);
      }
    }
  });

  it('installs GNU separately and requires its exact executable for preflight', () => {
    const steps = workflow.jobs.test.steps;
    const install = steps.find((step: { name: string }) => step.name === 'Install shell tools');
    assert.include(install.run, 'sudo apt-get install --yes shellcheck zsh jq gnu-coreutils');
    assert.include(install.run, 'dpkg-query --show gnu-coreutils');
    assert.include(install.run, '/usr/bin/gnutimeout --version');
    const preflight = steps.find((step: { run?: string }) => step.run === 'npm run test:claude-preflight');
    assert.deepEqual(preflight.env, { GNU_TIMEOUT: '/usr/bin/gnutimeout' });
  });

  it('extends only the known runner label without disabling lint diagnostics', () => {
    const config = yaml.load(fs.readFileSync(path.join(github, 'actionlint.yaml'), 'utf8'));
    assert.deepEqual(config, { 'self-hosted-runner': { labels: ['ubuntu-26.04'] } });
    const step = workflow.jobs.test.steps.find((step: { name: string }) => step.name === 'Run actionlint');
    assert.include(step.run, 'rhysd/actionlint:1.7.12');
    assert.notInclude(step.run, '-ignore');
  });

  it('reports the actual image, OS and relevant tool paths and versions after Node setup', () => {
    const steps = workflow.jobs.test.steps;
    const report = steps.findIndex((step: { name: string }) => step.name === 'Report runner and tool versions');
    const node = steps.findIndex((step: { name: string }) => step.name === 'Set up Node.js');
    assert.isAbove(report, node);
    assert.include(steps[report].run, '${ImageOS:-unknown}');
    assert.include(steps[report].run, '${ImageVersion:-unknown}');
    assert.include(steps[report].run, 'cat /etc/os-release');
    assert.include(steps[report].run, 'for tool in bash jq /usr/bin/gnutimeout shellcheck zsh docker node npm; do');
    assert.include(steps[report].run, 'command -v "$tool"');
    assert.include(steps[report].run, '"$tool" --version');
  });
});

describe('native macOS CI contract', () => {
  const native = yaml.load(fs.readFileSync(path.join(github, 'workflows', 'macos.yml'), 'utf8'));
  const job = native.jobs.native;

  it('runs on every PR base, main pushes, and manual requests with read-only permissions', () => {
    assert.deepEqual(native.on, { pull_request: null, push: { branches: ['main'] }, workflow_dispatch: null });
    assert.deepEqual(native.permissions, { contents: 'read' });
    assert.deepEqual(Object.keys(native.jobs), ['native']);
    assert.equal(job['runs-on'], 'macos-26');
    assert.equal(job['timeout-minutes'], 20);
    assert.notProperty(job, 'if');
    assert.notProperty(job, 'needs');
    assert.notProperty(job, 'continue-on-error');
  });

  it('uses the approved action pins, Node version, and locked dependency install', () => {
    const [checkout, setup] = job.steps;
    assert.deepEqual(checkout, workflow.jobs.test.steps[0]);
    assert.deepEqual(setup, workflow.jobs.test.steps.find((step: { name: string }) => step.name === 'Set up Node.js'));
    assert.equal(job.steps[3].run, 'npm ci');
  });

  it('fails early if native platform, tools, or fixture group requirements are missing', () => {
    const report = job.steps[2].run;
    for (const expected of [
      '${ImageOS:-unknown}', '${ImageVersion:-unknown}', 'sw_vers', 'uname -a', '\nid\n',
      'node --version', 'npm --version', "assert.equal(process.platform, 'darwin')",
      "assert.equal(process.arch, 'arm64')", 'process.getgroups().includes(80)',
      'assert.notEqual(process.getgid(), 80',
      'for tool in /usr/bin/plutil /bin/chmod /bin/stty /bin/bash /bin/zsh; do', 'test -x "$tool"',
      '/bin/bash --version', '/bin/zsh --version', 'command -v zsh', '\nzsh --version\n',
      '\nzsh -fc \'zmodload zsh/zpty && zmodload zsh/zselect && zmodload zsh/datetime\'',
    ]) assert.include(report, expected);
    assert.notInclude(report, 'sudo');
  });

  it('runs the focused suites serially without accepting pending or empty runs', () => {
    assert.equal(job.steps.length, 5);
    assert.equal(job.steps[4].run, 'npm run test:unit -- --no-parallel --forbid-pending --fail-zero '
      + 'test/nvm.test.ts test/onboarding_plutil.test.ts test/prompt_input.test.ts');
    for (const step of job.steps) {
      assert.notProperty(step, 'if');
      assert.notProperty(step, 'continue-on-error');
    }
  });
});
