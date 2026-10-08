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

describe('Claude preflight Bash/jq integration', () => {
  it('executes the production script against isolated gh responses', function () {
    this.timeout(30_000);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-claude-preflight-'));
    try {
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      const bash = requiredTool('bash');
      for (const [name, target] of [
        ['jq', requiredTool('jq')], ['timeout', requiredTool('GNU timeout', ['timeout', 'gtimeout'])],
      ]) fs.symlinkSync(target, path.join(bin, name));
      const env = testChildEnvironment({ HOME: root, TMPDIR: root, PATH: bin, LC_ALL: 'C' });
      const version = spawnSync(path.join(bin, 'timeout'), ['--version'], { env, encoding: 'utf8', timeout: 1000 });
      assert.equal(version.status, 0, version.stderr);
      assert.include(version.stdout, 'GNU coreutils', 'the production script requires GNU timeout');
      const workflow = yaml.load(fs.readFileSync(
        path.join(__dirname, '..', '..', '.github', 'workflows', 'claude.yml'), 'utf8',
      ));
      const script = workflow.jobs.eligibility.steps[0].run;
      assert.isString(script);
      fs.writeFileSync(path.join(bin, 'gh'), [
        '#!/bin/bash',
        'set -euo pipefail',
        '[[ "$#" == 2 && "$1" == api && "$2" == "repos/$REPO/pulls/$PR_NUMBER" ]] || exit 90',
        '[[ "$GH_TOKEN" == fixture-only ]] || exit 91',
        'printf "called\\n" >> "$FIXTURE_CALLS"',
        'printf "%s" "$FIXTURE_RESPONSE"',
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
          },
          encoding: 'utf8', timeout: 2000,
        });
        assert.isUndefined(result.error, `${fixture.name}: ${result.error}`);
        assert.isNull(result.signal, fixture.name);
        if (fixture.output) assert.equal(result.status, 0, `${fixture.name}: ${result.stderr}`);
        else assert.isAbove(result.status, 0, `${fixture.name}: must fail closed`);
        assert.equal(fs.readFileSync(output, 'utf8'), fixture.output, fixture.name);
        assert.equal(fs.readFileSync(calls, 'utf8'), 'called\n', `${fixture.name}: one bounded API call`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
