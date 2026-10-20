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
      assert.lengthOf(all.match(new RegExp('raw\\.githubusercontent\\.com/JBallin/ballin-scripts/main/' + route + '\\.sh', 'gu')) ?? [], 1);
    }
    assert.notInclude(all, 'BALLIN_SHELL_');
    assert.include(details, '../README.md#installation'); assert.include(details, 'quickstart.md#quickstart-install-ballin');
    for (const heading of ['What will installation change?', 'Startup files and manual activation', 'Manual PATH setup', 'Optional backup setup and reconnect']) {
      assert.include(details, heading);
    }
    assert.include(quick, 'only if you choose to set up backups'); assert.include(details, 'Ballin can be installed for maintenance without configuring backups.');
  });
  for (const shell of ['bash', 'zsh']) {
    it(`runs the actual README command with untouched prompt stdin in ${shell}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-doc-command-'));
      try {
        fs.writeFileSync(path.join(root, 'curl'), '#!/bin/sh\nprintf \'%s\\n\' \'IFS= read -r answer; [ "$answer" = n ] || exit 71; printf "fixture-declined\\n"\'\n', { mode: 0o755 });
        const result = spawnSync('/bin/' + shell, ['-f', '-c', command('README.md')], {
          input: 'n\n', encoding: 'utf8', cwd: root,
          env: testChildEnvironment({ HOME: root, PATH: root + ':/bin:/usr/bin', SHELL: '/bin/' + shell }), timeout: 5000,
        });
        assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, 'fixture-declined\n');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });
  }
});
