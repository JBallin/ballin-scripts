const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');
const { testChildEnvironment } = require('../helpers/environment.ts');

// Explicit CI-only suite: default Mocha discovery does not recurse into test/ci.
// Missing Bash, jq or GNU timeout is a failure, never a skipped validation.
const requiredTool = (name: string, aliases = [name]): string => {
  for (const directory of ['/usr/bin', '/bin', '/opt/homebrew/bin', '/usr/local/bin']) {
    for (const alias of aliases) {
      const candidate = path.join(directory, alias);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch { /* Try the next standard tool location. */ }
    }
  }
  throw new Error(`Claude preflight CI test requires ${name}`);
};

// Ubuntu 26 uses gnutimeout; Homebrew uses gtimeout. Never accept a different
// implementation merely because its executable appears earlier on the host.
const requiredGNUTimeout = (candidates: string[]): string => {
  for (const candidate of candidates) {
    const version = spawnSync(candidate, ['--version'], {
      env: testChildEnvironment({ LC_ALL: 'C' }), encoding: 'utf8', timeout: 1000,
    });
    if (version.status === 0 && version.stdout.includes('GNU coreutils')) return candidate;
  }
  throw new Error(`Claude preflight CI test requires GNU timeout; checked ${candidates.join(', ')}`);
};

const hostGNUTimeout = (): string => requiredGNUTimeout(process.env.GNU_TIMEOUT
  ? [process.env.GNU_TIMEOUT]
  : ['/usr/bin', '/bin', '/opt/homebrew/bin', '/usr/local/bin'].flatMap(
    (directory) => ['gnutimeout', 'gtimeout', 'timeout'].map((name) => path.join(directory, name)),
  ));

describe('GNU timeout selection', () => {
  it('skips non-GNU executables and rejects missing or non-GNU tools', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-timeout-selection-'));
    try {
      const other = path.join(root, 'timeout');
      const gnu = path.join(root, 'gnutimeout');
      fs.writeFileSync(other, '#!/bin/bash\nprintf "timeout (uutils coreutils) 0.10.0\\n"\n', { mode: 0o755 });
      fs.writeFileSync(gnu, '#!/bin/bash\nprintf "timeout (GNU coreutils) fixture\\n"\n', { mode: 0o755 });
      assert.equal(requiredGNUTimeout([other, gnu]), gnu);
      assert.throws(() => requiredGNUTimeout([other]), /requires GNU timeout/u);
      assert.throws(() => requiredGNUTimeout([path.join(root, 'missing')]), /requires GNU timeout/u);
      const workflow = yaml.load(fs.readFileSync(
        path.join(__dirname, '..', '..', '.github', 'workflows', 'claude.yml'), 'utf8',
      ));
      const script = workflow.jobs.eligibility.steps.find((step: { id?: string }) => step.id === 'eligibility').run;
      const output = path.join(root, 'output');
      fs.writeFileSync(output, '');
      const result = spawnSync(requiredTool('bash'), ['--noprofile', '--norc', '-c', script], {
        env: testChildEnvironment({
          GNU_TIMEOUT: other, GITHUB_OUTPUT: output,
          GH_TOKEN: 'fixture-only', REPO: 'JBallin/ballin-scripts', PR_NUMBER: '42',
        }),
        encoding: 'utf8', timeout: 1000,
      });
      assert.isUndefined(result.error);
      assert.isNull(result.signal);
      assert.equal(result.status, 1, 'the production script must reject non-GNU before the request');
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
      assert.equal(fs.readFileSync(output, 'utf8'), '');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('GNU timeout behavior', () => {
  it('preserves output and a completed command’s exit status', () => {
    const result = spawnSync(hostGNUTimeout(), ['1s', requiredTool('bash'), '-c', 'printf fixture; exit 23'], {
      env: testChildEnvironment(), encoding: 'utf8', timeout: 1500,
    });
    assert.isUndefined(result.error);
    assert.isNull(result.signal);
    assert.equal(result.stdout, 'fixture');
    assert.equal(result.status, 23);
  });

  it('sends TERM at expiry and returns 124 even when the command handles TERM', () => {
    const result = spawnSync(hostGNUTimeout(), ['0.1s', requiredTool('bash'), '-c',
      'trap \'printf "TERM\\n"; exit 0\' TERM; while :; do :; done'], {
      env: testChildEnvironment(), encoding: 'utf8', timeout: 1500,
    });
    assert.isUndefined(result.error);
    assert.isNull(result.signal);
    assert.equal(result.stdout, 'TERM\n');
    assert.equal(result.status, 124);
  });
});

describe('Claude preflight Bash/jq integration', () => {
  it('executes the production script against isolated gh responses', function () {
    this.timeout(30_000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-claude-preflight-'));
    try {
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      const bash = requiredTool('bash');
      const timeout = hostGNUTimeout();
      fs.symlinkSync(requiredTool('jq'), path.join(bin, 'jq'));
      const timeoutWrapper = path.join(bin, 'timeout');
      // Assert the production duration, then shorten only the expiry fixture.
      // All timing and signals still come from the selected real GNU binary.
      fs.writeFileSync(timeoutWrapper, [
        '#!/bin/bash',
        'set -euo pipefail',
        'if [[ "$1" == --version ]]; then exec "$REAL_GNU_TIMEOUT" --version; fi',
        '[[ "$1" == 30s ]] || exit 92',
        'duration=$1',
        'if [[ "$FIXTURE_TIMEOUT" == 1 ]]; then duration=0.1s; fi',
        'shift',
        'exec "$REAL_GNU_TIMEOUT" "$duration" "$@"',
        '',
      ].join('\n'), { mode: 0o755 });
      const env = testChildEnvironment({ HOME: root, TMPDIR: root, PATH: bin, LC_ALL: 'C' });
      const version = spawnSync(timeout, ['--version'], { env, encoding: 'utf8', timeout: 1000 });
      assert.equal(version.status, 0, version.stderr);
      assert.include(version.stdout, 'GNU coreutils', 'the production script requires GNU timeout');
      const workflow = yaml.load(fs.readFileSync(
        path.join(__dirname, '..', '..', '.github', 'workflows', 'claude.yml'), 'utf8',
      ));
      const script = workflow.jobs.eligibility.steps.find((step: { id?: string }) => step.id === 'eligibility').run;
      assert.isString(script);
      fs.writeFileSync(path.join(bin, 'gh'), [
        '#!/bin/bash',
        'set -euo pipefail',
        '[[ "$#" == 2 && "$1" == api && "$2" == "repos/$REPO/pulls/$PR_NUMBER" ]] || exit 90',
        '[[ "$GH_TOKEN" == fixture-only ]] || exit 91',
        'printf "called\\n" >> "$FIXTURE_CALLS"',
        'printf "%s" "$FIXTURE_RESPONSE"',
        'if [[ "$FIXTURE_TIMEOUT" == 1 ]]; then exec /bin/sleep 5; fi',
        'exit "$FIXTURE_STATUS"',
        '',
      ].join('\n'), { mode: 0o755 });
      const pr = {
        number: 42, state: 'open', draft: false,
        head: { repo: { full_name: 'JBallin/ballin-scripts' } },
        base: { repo: { full_name: 'JBallin/ballin-scripts' } },
      };
      const cases = [
        { name: 'eligible', response: JSON.stringify(pr), output: 'eligible=true\n' },
        { name: 'closed', response: JSON.stringify({ ...pr, state: 'closed' }), output: 'eligible=false\n' },
        { name: 'draft', response: JSON.stringify({ ...pr, draft: true }), output: 'eligible=false\n' },
        { name: 'fork', response: JSON.stringify({ ...pr, head: { repo: { full_name: 'contributor/fork' } } }), output: 'eligible=false\n' },
        { name: 'wrong base repository', response: JSON.stringify({ ...pr, base: { repo: { full_name: 'other/repo' } } }), output: 'eligible=false\n' },
        { name: 'missing fields', response: '{"number":42}', output: 'eligible=false\n' },
        { name: 'malformed JSON', response: '{', output: '' },
        { name: 'non-object response', response: '[]', output: '' },
        { name: 'wrong PR number', response: JSON.stringify({ ...pr, number: 43 }), output: '' },
        { name: 'string PR number', response: JSON.stringify({ ...pr, number: '42' }), output: '' },
        { name: 'gh failure with valid response', response: JSON.stringify(pr), status: 1, output: '' },
        { name: 'gh timeout with valid response', response: JSON.stringify(pr), expires: true, output: '' },
      ];
      for (const [index, fixture] of cases.entries()) {
        const output = path.join(root, `output-${index}`);
        const calls = path.join(root, `calls-${index}`);
        fs.writeFileSync(output, '');
        const result = spawnSync(bash, ['--noprofile', '--norc', '-c', script], {
          cwd: root,
          env: {
            ...env, GH_TOKEN: 'fixture-only', REPO: 'JBallin/ballin-scripts', PR_NUMBER: '42',
            GITHUB_OUTPUT: output, FIXTURE_CALLS: calls, FIXTURE_RESPONSE: fixture.response,
            FIXTURE_STATUS: String(fixture.status ?? 0),
            GNU_TIMEOUT: timeoutWrapper, REAL_GNU_TIMEOUT: timeout,
            FIXTURE_TIMEOUT: fixture.expires ? '1' : '0',
          },
          encoding: 'utf8', timeout: 2000,
        });
        assert.isUndefined(result.error, `${fixture.name}: ${result.error}`);
        assert.isNull(result.signal, fixture.name);
        if (fixture.output) assert.equal(result.status, 0, `${fixture.name}: ${result.stderr}`);
        else assert.isAbove(result.status, 0, `${fixture.name}: must fail closed`);
        if (fixture.expires) assert.equal(result.status, 124, fixture.name);
        assert.equal(fs.readFileSync(output, 'utf8'), fixture.output, fixture.name);
        assert.equal(fs.readFileSync(calls, 'utf8'), 'called\n', `${fixture.name}: one bounded API call`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
