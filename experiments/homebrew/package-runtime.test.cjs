const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { generate } = require('./generate-formula.cjs');
const { renderFormulaWrapper } = require('./formula-wrapper-fixture.cjs');
const { fixtureDestination, fixtureState, installRepositoryFixture } = require('../../test/helpers/repository.ts');
const { repositoryCacheDirectory } = require('../../commands/backup_repository.ts');

describe('generated package launcher with real CLI collectors', { timeout: 15000 }, () => {
  const source = path.join(__dirname, '../..');
  let root;
  let home;
  let tools;
  let libexec;
  let wrapper;
  let stateFile;
  let configFile;
  let log;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-package-wrapper-'));
    home = path.join(root, 'home');
    tools = path.join(root, 'caller-tools');
    libexec = path.join(root, 'keg/libexec');
    const bin = path.join(root, 'keg/bin'), runtime = path.join(root, 'package-runtime');
    for (const directory of [home, tools, libexec, bin, runtime, path.join(home, '.ballin')]) fs.mkdirSync(directory, { recursive: true });
    for (const name of ['bin', 'commands', 'config', 'completions', 'package.json', '.nvmrc']) {
      fs.cpSync(path.join(source, name), path.join(libexec, name), { recursive: true });
    }
    const archive = path.join(root, 'source.tar.gz');
    execFileSync('/usr/bin/tar', ['-czf', archive, '-C', path.dirname(libexec), 'libexec']);
    const checksum = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    const formula = generate({ archive, checksum, sourceRevision: 'a'.repeat(40) });
    const node = path.join(runtime, 'node');
    fs.symlinkSync(process.execPath, node);
    log = path.join(root, 'operations.log');
    fs.writeFileSync(path.join(runtime, 'npm'), '#!/bin/sh\nprintf "package npm must stay private\\n" >> "$OPERATIONS_LOG"\nexit 89\n', { mode: 0o755 });
    wrapper = renderFormulaWrapper({ formula, node, libexec, bin });
    fs.writeFileSync(path.join(libexec, '.ballin-package.json'), JSON.stringify({
      manager: 'homebrew', schema: 2, formula: 'ballin-experiment', version: require('../../package.json').version,
      sourceRevision: 'a'.repeat(40), archiveSha256: checksum, selection: { kind: 'development' },
      commandPath: wrapper, completionRoot: path.join(libexec, 'completions'),
    }));
    // Only explicit basic tools and fixture-owned integrations are visible.
    for (const [name, executable] of [['bash', '/bin/bash'], ['cat', '/bin/cat']]) fs.symlinkSync(executable, path.join(tools, name));
    fs.writeFileSync(path.join(tools, 'npm'), `#!/bin/sh
printf 'npm|%s|%s\\n' "$*" "$PATH" >> "$OPERATIONS_LOG"
case "$*" in
  'list -g --depth=0') printf 'caller npm inventory\\n' ;;
  'update -g') ;;
  *) exit 87 ;;
esac
`, { mode: 0o755 });
    fs.writeFileSync(path.join(tools, 'brew'), `#!/bin/sh
printf 'brew|%s\\n' "$*" >> "$OPERATIONS_LOG"
[ "$HOMEBREW_NO_INSTALL_CLEANUP" = 1 ] || exit 88
case "$*" in
  update|upgrade|doctor|cleanup) ;;
  '--prefix') printf '%s\\n' "$HOME/missing-brew-prefix" ;;
  'list --formula'|leaves|'list --cask'|'services list'|'bundle dump --file=-') ;;
  *) exit 86 ;;
esac
`, { mode: 0o755 });
    stateFile = path.join(root, 'repository.json');
    fs.writeFileSync(stateFile, JSON.stringify(fixtureState()));
    installRepositoryFixture(tools, stateFile);
    configFile = path.join(home, '.ballin/ballin.config.json');
    fs.writeFileSync(configFile, JSON.stringify({
      update: { cleanup: true, nvm: false, npm: true, softwareupdate: false, selfUpdate: true, backup: true },
      backup: { repository: fixtureDestination, includeSensitive: 'false' }, analytics: { enabled: 'false' },
    }));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const ambientNode of ['absent', 'incompatible']) {
    it(`updates caller npm and backs up its inventory through the generated launcher with ${ambientNode} ambient Node`, () => {
      if (ambientNode === 'incompatible') fs.writeFileSync(path.join(tools, 'node'), '#!/bin/sh\nexit 91\n', { mode: 0o755 });
      const originalConfig = fs.readFileSync(configFile, 'utf8');
      const result = spawnSync(wrapper, ['update'], {
        input: '', encoding: 'utf8', timeout: 12000, cwd: home,
        env: { HOME: home, TMPDIR: root, PATH: tools, NO_COLOR: '1', TERM: 'dumb', BALLIN_NO_ANALYTICS: '1', OPERATIONS_LOG: log },
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.ok(result.stdout.includes('+ npm_global'));
      const operations = fs.readFileSync(log, 'utf8').trim().split('\n');
      assert.deepEqual(operations.filter((line) => line.startsWith('npm|')), [
        `npm|update -g|${tools}`, `npm|list -g --depth=0|${tools}`,
      ]);
      assert.equal(operations.at(-1), 'brew|cleanup', 'cleanup must follow the real backup child');
      assert.ok(!operations.join('\n').includes('package npm must stay private'));
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.equal(Buffer.from(state.commits[state.head].files.npm_global, 'base64').toString(), 'caller npm inventory\n');
      const cache = repositoryCacheDirectory(path.join(home, '.ballin/.backup-cache'), fixtureDestination);
      assert.equal(fs.readFileSync(path.join(cache, 'npm_global'), 'utf8'), 'caller npm inventory\n');
      assert.equal(fs.readFileSync(configFile, 'utf8'), originalConfig);
      assert.equal(fs.existsSync(path.join(libexec, '.backup-cache')), false);
      assert.equal(fs.existsSync(path.join(libexec, 'ballin.config.json')), false);
    });
  }
});
