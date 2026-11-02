const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');

describe('canonical installation commands', () => {
  const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const command = (file: string) => read(file).match(/```shell\n([\s\S]*?)\n```/)?.[1];
  it('keeps one discoverable command per route and stable detail/recovery links', () => {
    const readme = read('README.md'), quick = read('docs/quickstart.md'), details = read('docs/installation.md');
    assert.include(readme, '## Installation\n'); assert.include(quick, '# Quickstart: Install Ballin\n');
    assert.include(command('README.md'), '/main/install.sh');
    assert.include(command('docs/quickstart.md'), '/main/quickstart.sh');
    const all = [readme, quick, details].join('\n');
    for (const route of ['install', 'quickstart']) {
      assert.lengthOf(all.match(new RegExp('raw\\.githubusercontent\\.com/JBallin/ballin-scripts/main/' + route + '\\.sh', 'gu')) ?? [], route === 'install' ? 2 : 1);
    }
    assert.notInclude(all, 'BALLIN_SHELL_');
    assert.include(details, '../README.md#installation'); assert.include(details, 'quickstart.md#quickstart-install-ballin');
    for (const heading of ['What will installation change?', 'Startup files and manual activation', 'Manual PATH setup', 'Optional backup setup and reconnect']) {
      assert.include(details, heading);
    }
    assert.include(quick, 'only if you choose to set up backups'); assert.include(details, 'Ballin can be installed for maintenance without configuring backups.');
  });
  for (const [guide, script] of [['README.md', 'install.sh'], ['docs/quickstart.md', 'quickstart.sh']]) {
    for (const shell of ['bash', 'zsh']) {
      const runDownloaded = (body: string, status = 0, input = '', overrides: NodeJS.ProcessEnv = {}) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-doc-command-'));
        try {
          fs.writeFileSync(path.join(root, 'payload'), body);
          fs.writeFileSync(path.join(root, 'curl'), `#!/bin/sh
[ "$1" = -q ] || exit 97
/bin/cat payload
${status ? 'printf "Fixture curl failure\\n" >&2' : ''}
exit ${status}
`, { mode: 0o755 });
          const result = spawnSync('/bin/' + shell, ['-f', '-c', command(guide)], {
            input, encoding: 'utf8', cwd: root,
            env: testChildEnvironment({ HOME: root, PATH: root, SHELL: '/bin/' + shell, ...overrides }), timeout: 5000,
          });
          assert.isFalse(fs.existsSync(path.join(root, 'executed')));
          return result;
        } finally { fs.rmSync(root, { recursive: true, force: true }); }
      };
      it(`preserves curl failure before executing the downloaded command for ${script} in ${shell}`, () => {
        assert.equal(command(guide), `ballin_script=$(curl -q -fsSL https://raw.githubusercontent.com/JBallin/ballin-scripts/main/${script}) && /bin/bash -c "$ballin_script"`);
      });
      it(`propagates curl's empty download error for ${script} in ${shell}`, () => {
        const result = runDownloaded('', 22);
        assert.equal(result.status, 22, result.stderr);
        assert.equal(result.stdout, '');
        assert.include(result.stderr, 'Fixture curl failure');
      });
      for (const cut of ['first function', 'middle', 'quoted value', 'final brace']) {
        it(`refuses the actual ${script} truncated at ${cut} in ${shell}`, () => {
          const body = read(script).replace('{ # Parse the complete body before starting installation.\n',
            '{ # Parse the complete body before starting installation.\n: > executed\n');
          const end = cut === 'first function' ? body.indexOf('\n}\n') + 3
            : cut === 'middle' ? Math.floor(body.length / 2)
              : cut === 'quoted value' ? body.indexOf("required_node_version='") + "required_node_version='".length + 1
                : body.lastIndexOf('}');
          const result = runDownloaded(body.slice(0, end), 22);
          assert.equal(result.status, 22, result.stderr);
          assert.equal(result.stdout, '');
          assert.include(result.stderr, 'Fixture curl failure');
        });
      }
      it(`refuses a malformed ${script} body before executing in ${shell}`, () => {
        const body = read(script).replace('{ # Parse the complete body before starting installation.\n',
          '{ # Parse the complete body before starting installation.\n: > executed\nif then\n');
        const result = runDownloaded(body);
        assert.equal(result.status, 2, result.stderr);
        assert.equal(result.stdout, '');
        assert.include(result.stderr, 'syntax error');
      });
      it(`does not execute a complete ${script} body after curl failure in ${shell}`, () => {
        const result = runDownloaded('{ printf "complete-body-ran\\n"; }\n', 22);
        assert.equal(result.status, 22, result.stderr);
        assert.equal(result.stdout, '');
        assert.include(result.stderr, 'Fixture curl failure');
      });
      it(`retains the script's failure status for ${script} in ${shell}`, () => {
        const result = runDownloaded('{ exit 71; }\n');
        assert.equal(result.status, 71, result.stderr);
      });
      it(`keeps prompt stdin untouched for ${script} in ${shell}`, () => {
        const result = runDownloaded('{ IFS= read -r answer; [ "$answer" = n ] || exit 71; printf "fixture-declined\\n"; }\n', 0, 'n\n');
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, 'fixture-declined\n');
      });
      it(`preserves inherited options without replacing an exported buffer for ${script} in ${shell}`, () => {
        const result = runDownloaded('{ [ "$s" = "caller value" ]; IFS= read -r answer; [ "$answer" = n ]; printf "fixture-declined\\n"; }\n', 0, 'n\n', {
          s: 'caller value', SHELLOPTS: 'allexport:errexit:noclobber:nounset:pipefail',
        });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, 'fixture-declined\n');
      });
    }
  }
  it('keeps Quickstart sourceable under nounset without starting setup or installing traps', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-doc-source-'));
    try {
      const result = spawnSync('/bin/bash', ['-u', '-c',
        'source "$1"; declare -F main cleanup download >/dev/null; [ -z "$(trap -p EXIT INT TERM)" ]; printf sourced',
        'source-test', path.resolve(__dirname, '../quickstart.sh')], {
        encoding: 'utf8', cwd: root, timeout: 5000,
        env: testChildEnvironment({ HOME: root, PATH: root }),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, 'sourced');
      assert.isEmpty(fs.readdirSync(root));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
