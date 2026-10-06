const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');

describe('beginner quickstart bootstrap', function() {
  this.timeout(15000);
  let root: string;
  let home: string;
  let tools: string;
  let systemNode: string;
  let log: string;
  const source = path.resolve(__dirname, '../quickstart.sh');
  const readLog = (): string => fs.readFileSync(log, 'utf8');
  const linkFake = (name: string, destination = tools): void => fs.symlinkSync(path.join(root, 'fake-tool'), path.join(destination, name));
  const run = (input = 'y\ny\n', overrides: NodeJS.ProcessEnv = {}) => spawnSync('/bin/bash', ['-c', `
source "$FAKE_SOURCE"
system_node_bin="$FAKE_SYSTEM_NODE"
system_git="$FAKE_ROOT/tools/git"
trap cleanup EXIT
main
`], {
    encoding: 'utf8', input, cwd: home, timeout: 12000,
    env: testChildEnvironment({
      HOME: home, PATH: tools, TMPDIR: path.join(root, 'tmp'), SHELL: '/bin/zsh',
      FAKE_ROOT: root, FAKE_COMMAND_LOG: log, FAKE_SOURCE: source,
      FAKE_SYSTEM_NODE: systemNode, TEST_NODE_RUNTIME: process.execPath, ...overrides,
    }),
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-quickstart-test-'));
    home = path.join(root, 'home');
    tools = path.join(root, 'tools');
    systemNode = path.join(root, 'system-node');
    log = path.join(root, 'commands.log');
    [home, tools, systemNode, path.join(root, 'tmp')].forEach((dir) => fs.mkdirSync(dir));
    fs.writeFileSync(log, '');
    for (const name of ['awk', 'bash', 'cat', 'chmod', 'cmp', 'cp', 'grep', 'ln', 'mkdir', 'mktemp', 'mv', 'readlink', 'rm', 'shasum', 'touch', 'zsh']) {
      const target = ['/bin', '/usr/bin'].map((dir) => path.join(dir, name)).find((file) => fs.existsSync(file));
      assert.exists(target, `Fixture requires ${name}`);
      fs.symlinkSync(target, path.join(tools, name));
    }
    const nodeBytes = 'Synthetic official Node package\n';
    const ghBytes = 'Synthetic official GitHub CLI archive\n';
    fs.writeFileSync(path.join(root, 'node.pkg'), nodeBytes);
    fs.writeFileSync(path.join(root, 'gh.zip'), ghBytes);
    const hash = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
    fs.writeFileSync(path.join(root, 'node-checksums.txt'), `${hash(nodeBytes)}  node-v24.21.0.pkg\n`);
    fs.writeFileSync(path.join(root, 'gh-checksums.txt'), ['arm64', 'amd64'].map((arch) => (
      `${hash(ghBytes)}  gh_2.102.0_macOS_${arch}.zip\n`
    )).join(''));
    fs.writeFileSync(path.join(root, 'gh-release.json'), '{"tag_name":"v2.102.0","draft":false,"prerelease":false}');
    fs.writeFileSync(path.join(root, 'fake-tool'), `#!/bin/bash
set -euo pipefail
name="\${0##*/}"
printf '%s:%s\\n' "$name" "$*" >> "$FAKE_COMMAND_LOG"
case "$name" in
  uname) case "$1" in -s) printf '%s\\n' "\${FAKE_OS:-Darwin}" ;; -m) printf '%s\\n' "\${FAKE_ARCH:-arm64}" ;; *) exit 97 ;; esac ;;
  sw_vers) [[ "$*" == -productVersion ]] || exit 97; printf '%s\\n' "\${FAKE_MACOS:-13.5}" ;;
  git) [[ "$*" == --version ]] || exit 97; [[ "\${FAKE_GIT:-ready}" == ready || -f "$FAKE_ROOT/git-installed" ]] ;;
  brew) [[ "$*" == --prefix ]] || exit 97; printf '%s\\n' "$FAKE_BREW_PREFIX" ;;
  xcode-select)
    if [[ "$*" == -p ]]; then [[ "\${FAKE_GIT:-ready}" == ready || -f "$FAKE_ROOT/git-installed" ]]; exit; fi
    [[ "$*" == --install ]] || exit 97
    [[ "\${FAKE_XCODE_FAIL:-0}" != 1 ]] || exit 1
    touch "$FAKE_ROOT/git-installed" ;;
  node)
    if [[ "$1" == -p ]]; then
      if [[ "$0" == "$FAKE_ROOT/tools/node" && "\${FAKE_OLD_NODE:-0}" == 1 ]]; then printf 'false\\n'; else printf 'true\\n'; fi
    else exec "$TEST_NODE_RUNTIME" "$@"; fi ;;
  gh)
    case "$*" in
      --version) printf 'gh version fixture\\n' ;;
      'auth status --help') printf '%s\\n' '--active' ;;
      'auth status --active --hostname github.com') [[ "\${FAKE_AUTH:-ready}" == ready || -f "$FAKE_ROOT/login-complete" ]] ;;
      'auth login --hostname github.com --git-protocol https --web')
        printf 'Native login prompt: '; IFS= read -r answer
        [[ "$answer" == device-code ]] || exit 1
        touch "$FAKE_ROOT/login-complete" ;;
      *) exit 97 ;;
    esac ;;
  curl)
    url=''; target=''
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -o) target="$2"; shift 2 ;;
        --proto|--proto-redir) shift 2 ;;
        -fsSL|-fL|--progress-bar|--tlsv1.2) shift ;;
        https://*) url="$1"; shift ;;
        *) exit 97 ;;
      esac
    done
    case "$url" in
      https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt) cp "$FAKE_ROOT/node-checksums.txt" "$target" ;;
      https://nodejs.org/dist/v24.21.0/node-v24.21.0.pkg)
        cp "$FAKE_ROOT/node.pkg" "$target"; if [[ "\${FAKE_CORRUPT_NODE:-0}" == 1 ]]; then printf 'corruption' >> "$target"; fi ;;
      https://api.github.com/repos/cli/cli/releases/latest) cp "$FAKE_ROOT/gh-release.json" "$target" ;;
      https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_checksums.txt) cp "$FAKE_ROOT/gh-checksums.txt" "$target" ;;
      https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_macOS_arm64.zip|https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_macOS_amd64.zip)
        cp "$FAKE_ROOT/gh.zip" "$target"; if [[ "\${FAKE_CORRUPT_GH:-0}" == 1 ]]; then printf 'corruption' >> "$target"; fi ;;
      https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh)
        [[ "\${FAKE_DOWNLOAD_FAIL:-0}" != 1 ]] || exit 22
        cp "$FAKE_ROOT/fake-tool" "$target" ;;
      *) exit 97 ;;
    esac ;;
  pkgutil)
    [[ "$1" == --check-signature && "$2" == "$FAKE_ROOT"/tmp/ballin-quickstart.*/node-v24.21.0.pkg && $# == 2 ]] || exit 97
    [[ "\${FAKE_SIGNATURE_FAIL:-0}" != 1 ]] || exit 1
    if [[ "\${FAKE_BAD_PUBLISHER:-0}" == 1 ]]; then printf 'Unexpected publisher\\n'
    else printf 'Developer ID Installer: Node.js Foundation (HX7739G8FX)\\n'; fi ;;
  sudo)
    [[ "$1" == /usr/sbin/installer && "$2" == -pkg && "$3" == "$FAKE_ROOT"/tmp/ballin-quickstart.*/node-v24.21.0.pkg && "$4" == -target && "$5" == / && $# == 5 ]] || exit 97
    [[ "\${FAKE_SUDO_FAIL:-0}" != 1 ]] || exit 1
    cp "$FAKE_ROOT/fake-tool" "$FAKE_SYSTEM_NODE/node" ;;
  ditto)
    [[ "$1" == -x && "$2" == -k && "$3" == "$FAKE_ROOT"/tmp/ballin-quickstart.*/gh_2.102.0_macOS_*.zip && "$4" == "$FAKE_ROOT"/tmp/ballin-quickstart.*/gh-extract && $# == 4 ]] || exit 97
    folder="\${3##*/}"; folder="\${folder%.zip}"
    mkdir -p "$4/$folder/bin"
    cp "$FAKE_ROOT/fake-tool" "$4/$folder/bin/gh" ;;
  install.sh)
    [[ "\${FAKE_INSTALL_FAIL:-0}" != 1 ]] || exit 1
    repo="$HOME/.ballin-scripts"
    if [[ ! -f "$repo/ballin.config.json" ]]; then
      printf 'Native installation prompt: '; IFS= read -r answer
      [[ "$answer" == y ]] || exit 0
      mkdir -p "$repo/bin" "$repo/commands"
      if [[ "\${FAKE_SKIP_BACKUP:-0}" == 1 ]]; then printf '{"backup":{}}\\n' > "$repo/ballin.config.json"
      else printf '{"backup":{"repository":true}}\\n' > "$repo/ballin.config.json"; fi
    fi
    cp "$FAKE_ROOT/fake-tool" "$repo/bin/ballin"
    printf '%s\\n' 'module.exports = { configuredBackupDestination: c => ({ kind: c.backup.repository ? "repository" : "unconfigured" }) };' > "$repo/commands/backup_config.ts" ;;
  ballin)
    case "$*" in
      'backup setup')
        printf 'Native backup setup prompt: '; IFS= read -r answer
        [[ "$answer" == y ]] || exit 1
        printf '{"backup":{"repository":true}}\\n' > "$HOME/.ballin-scripts/ballin.config.json" ;;
      backup)
        [[ "\${FAKE_BACKUP_FAIL:-0}" != 1 ]] || exit 1
        if ! grep -q '"repository":true' "$HOME/.ballin-scripts/ballin.config.json"; then printf 'Backup is not configured\\n' >&2; exit 1; fi ;;
      'backup open') ;;
      *) exit 97 ;;
    esac ;;
  *) exit 97 ;;
esac
`, { mode: 0o755 });
    for (const name of ['uname', 'sw_vers', 'git', 'xcode-select', 'node', 'gh', 'curl', 'pkgutil', 'sudo', 'ditto']) linkFake(name);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reuses working tools, preserves native stdin, and opens only after capture', () => {
    const result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr + readLog());
    assert.include(result.stdout, 'Native installation prompt:');
    assert.include(readLog(), 'ballin:backup\nballin:backup open\n');
    for (const unexpected of ['sudo:', 'xcode-select:--install', 'releases/latest', 'ballin:update']) assert.notInclude(readLog(), unexpected);
    assert.include(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), 'export PATH=');
  });
  for (const shell of ['zsh', 'bash']) {
    for (const withBrew of [false, true]) {
      it(`follows a healthy ${shell} version manager's new default${withBrew ? ' with Homebrew available' : ''} while the old version exists`, () => {
        const versions = path.join(home, '.nvm/versions/node');
        const firstBin = path.join(versions, 'v24.12.0/bin');
        const nextBin = path.join(versions, 'v24.21.0/bin');
        for (const bin of [firstBin, nextBin]) {
          fs.mkdirSync(bin, { recursive: true });
          linkFake('node', bin);
          linkFake('npm', bin);
        }
        const selected = path.join(home, '.nvm/default');
        fs.writeFileSync(selected, 'v24.12.0');
        const profile = path.join(home, shell === 'zsh' ? '.zshrc' : '.bash_profile');
        fs.writeFileSync(profile, 'export PATH="$HOME/.nvm/versions/node/$(cat "$HOME/.nvm/default")/bin:$PATH"\n');
        let basePath = tools;
        const brewPrefix = path.join(root, 'brew');
        if (withBrew) {
          const brewBin = path.join(brewPrefix, 'bin');
          fs.mkdirSync(brewBin, { recursive: true });
          linkFake('node', brewBin);
          linkFake('npm', brewBin);
          linkFake('brew');
          basePath = `${brewBin}:${tools}`;
        }
        const installed = run('y\ny\n', { PATH: `${firstBin}:${basePath}`, FAKE_BREW_PREFIX: brewPrefix, SHELL: `/bin/${shell}` });
        assert.equal(installed.status, 0, installed.stdout + installed.stderr);
        fs.writeFileSync(selected, 'v24.21.0');
        const resolve = () => spawnSync(`/bin/${shell}`, ['-c', 'source "$FAKE_PROFILE"; command -v node; command -v npm'], {
          encoding: 'utf8', cwd: home,
          env: testChildEnvironment({ HOME: home, PATH: basePath, TMPDIR: path.join(root, 'tmp'), SHELL: `/bin/${shell}`, FAKE_PROFILE: profile }),
        });
        for (const removeOld of [false, true]) {
          if (removeOld) fs.rmSync(path.dirname(firstBin), { recursive: true });
          const resolved = resolve();
          assert.equal(resolved.status, 0, resolved.stdout + resolved.stderr);
          assert.deepEqual(resolved.stdout.trim().split('\n'), [path.join(nextBin, 'node'), path.join(nextBin, 'npm')]);
        }
        const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
        for (const name of ['node', 'npm']) assert.isFalse(fs.existsSync(path.join(quickBin, name)));
        assert.notInclude(readLog(), 'sudo:');
      });
    }
  }
  it('releases managed fallback links when a compatible version manager becomes available on rerun', () => {
    linkFake('npm', systemNode);
    const first = run('y\ny\ny\n', { FAKE_OLD_NODE: '1' });
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
    for (const name of ['node', 'npm']) assert.isTrue(fs.lstatSync(path.join(quickBin, name)).isSymbolicLink());
    const managerBin = path.join(home, '.nvm/versions/node/v24.21.0/bin');
    fs.mkdirSync(managerBin, { recursive: true });
    linkFake('node', managerBin);
    linkFake('npm', managerBin);
    const before = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
    const rerun = run('', { PATH: `${quickBin}:${managerBin}:${tools}`, FAKE_OLD_NODE: '1' });
    assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
    for (const name of ['node', 'npm']) assert.isFalse(fs.existsSync(path.join(quickBin, name)));
    assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), before);
    assert.equal(readLog().split('sudo:').length - 1, 1);
  });
  it('keeps links and one PATH line usable when rerun through the new PATH', () => {
    assert.equal(run('y\ny\ny\n', { FAKE_OLD_NODE: '1' }).status, 0);
    const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
    const before = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
    const result = run('', { PATH: `${quickBin}:${tools}`, FAKE_OLD_NODE: '1' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), before);
    assert.notEqual(fs.readlinkSync(path.join(quickBin, 'node')), path.join(quickBin, 'node'));
    assert.notInclude(result.stdout, 'Use these tools');
    assert.notInclude(readLog(), 'ballin:backup setup');
  });
  for (const arch of ['arm64', 'x86_64']) {
    it(`installs missing official prerequisites for ${arch}`, () => {
      fs.unlinkSync(path.join(tools, 'gh'));
      const result = run('y\n\ny\ny\n', { FAKE_GIT: 'missing', FAKE_ARCH: arch, FAKE_OLD_NODE: '1' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(readLog(), 'xcode-select:--install');
      assert.include(readLog(), 'sudo:/usr/sbin/installer -pkg');
      assert.include(readLog(), `gh_2.102.0_macOS_${arch === 'arm64' ? 'arm64' : 'amd64'}.zip`);
      assert.include(readLog(), 'ballin:backup open');
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    });
  }
  it('reuses compatible system Node when an older Node shadows it', () => {
    linkFake('node', systemNode);
    const result = run('y\ny\n', { FAKE_OLD_NODE: '1' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.notInclude(readLog(), 'sudo:');
    assert.equal(fs.readlinkSync(path.join(home, '.local/share/ballin-quickstart/bin/node')), path.join(systemNode, 'node'));
  });
  it('passes stdin to native browser login', () => {
    const result = run('y\ndevice-code\ny\n', { FAKE_AUTH: 'missing' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, 'Native login prompt:');
    assert.include(readLog(), 'gh:auth login --hostname github.com --git-protocol https --web');
    assert.isTrue(fs.existsSync(path.join(root, 'login-complete')));
  });
  for (const flag of ['FAKE_SIGNATURE_FAIL', 'FAKE_BAD_PUBLISHER', 'FAKE_SUDO_FAIL']) {
    it(`stops Node setup safely after ${flag}`, () => {
      const result = run('y\n', { FAKE_OLD_NODE: '1', [flag]: '1' });
      assert.equal(result.status, 1);
      assert.notInclude(readLog(), 'install.sh:');
      assert.notInclude(readLog(), 'ballin:');
      if (flag !== 'FAKE_SUDO_FAIL') assert.notInclude(readLog(), 'sudo:');
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    });
  }
  it('keeps an existing Bash .profile active and respects an exported ZDOTDIR', () => {
    const profile = path.join(home, '.profile');
    fs.writeFileSync(profile, '# Existing login profile\n');
    const bash = run('y\ny\n', { SHELL: '/bin/bash' });
    assert.equal(bash.status, 0, bash.stdout + bash.stderr);
    assert.isFalse(fs.existsSync(path.join(home, '.bash_profile')));
    assert.isTrue(fs.readFileSync(profile, 'utf8').startsWith('# Existing login profile\n'));
    const zdotdir = path.join(home, 'zsh-config');
    fs.mkdirSync(zdotdir);
    const zsh = run('y\n', { ZDOTDIR: zdotdir });
    assert.equal(zsh.status, 0, zsh.stdout + zsh.stderr);
    assert.isTrue(fs.existsSync(path.join(zdotdir, '.zshrc')));
  });
  for (const kind of ['NODE', 'GH']) {
    it(`rejects a corrupt ${kind} download before installing or running it`, () => {
      if (kind === 'GH') fs.unlinkSync(path.join(tools, 'gh'));
      const result = run('y\n', { FAKE_OLD_NODE: kind === 'NODE' ? '1' : '0', [`FAKE_CORRUPT_${kind}`]: '1' });
      assert.equal(result.status, 1);
      assert.include(result.stderr, 'Checksum verification failed');
      for (const forbidden of ['sudo:', 'ditto:', 'install.sh:']) assert.notInclude(readLog(), forbidden);
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    });
  }
  it('preserves files when prerequisite installation or PATH changes are declined', () => {
    fs.unlinkSync(path.join(tools, 'gh'));
    assert.equal(run('n\n').status, 0);
    assert.isFalse(fs.existsSync(path.join(home, '.local')));
    linkFake('gh');
    fs.writeFileSync(path.join(home, '.zshrc'), '# Existing settings\n', { mode: 0o640 });
    assert.equal(run('n\n').status, 1);
    assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), '# Existing settings\n');
    assert.notInclude(readLog(), 'install.sh:');
    assert.notInclude(readLog(), 'auth status --active');
  });
  it('preserves symlinked and syntactically invalid startup files', () => {
    const target = path.join(home, 'settings');
    fs.writeFileSync(target, '# Original settings\n');
    fs.symlinkSync(target, path.join(home, '.zshrc'));
    assert.equal(run().status, 1);
    assert.equal(fs.readFileSync(target, 'utf8'), '# Original settings\n');
    fs.unlinkSync(path.join(home, '.zshrc'));
    fs.writeFileSync(path.join(home, '.zshrc'), 'if true; then\n');
    assert.equal(run().status, 1);
    assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), 'if true; then\n');
    assert.notInclude(readLog(), 'install.sh:');
  });
  it('preserves startup files ending at an unfinished continuation', () => {
    for (const suffix of ['\\', '\\\n']) {
      const contents = `export EXAMPLE=1 ${suffix}`;
      fs.writeFileSync(path.join(home, '.zshrc'), contents);
      const result = run();
      assert.equal(result.status, 1);
      assert.include(result.stderr, 'unfinished continuation');
      assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), contents);
    }
    assert.notInclude(readLog(), 'install.sh:');
  });
  it('rejects an incompatible Node package version before requesting admin access', () => {
    fs.writeFileSync(path.join(root, 'node-checksums.txt'), 'a'.repeat(64) + '  node-v24.11.0.pkg\n');
    const result = run('y\n', { FAKE_OLD_NODE: '1' });
    assert.equal(result.status, 1);
    assert.include(result.stderr, 'older than the required 24.12');
    assert.notInclude(readLog(), 'sudo:');
    assert.notInclude(readLog(), '/node-v24.11.0.pkg -o');
  });
  it('preserves unfinished heredocs even when they contain the expected PATH line', () => {
    const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
    const activation = "export PATH='" + quickBin + "':$PATH:'" + path.join(home, '.local/bin') + "'";
    for (const shell of ['/bin/zsh', '/bin/bash']) {
      const profile = path.join(home, shell.endsWith('zsh') ? '.zshrc' : '.bash_profile');
      for (const contents of ['cat <<EOF\nExisting text\n', "cat <<'EOF'\n" + activation + '\n']) {
        fs.writeFileSync(profile, contents);
        const result = run('', { SHELL: shell });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.include(result.stderr, 'unfinished heredoc');
        assert.equal(fs.readFileSync(profile, 'utf8'), contents);
      }
    }
    assert.notInclude(readLog(), 'install.sh:');
    assert.notInclude(readLog(), 'auth status --active');
  });
  it('appends PATH after complete heredocs in both supported shells', () => {
    const contents = "cat <<'EOF'\nExisting text\nEOF\n";
    for (const shell of ['/bin/zsh', '/bin/bash']) {
      const profile = path.join(home, shell.endsWith('zsh') ? '.zshrc' : '.bash_profile');
      fs.writeFileSync(profile, contents);
      const result = run('y\ny\n', { SHELL: shell });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.isTrue(fs.readFileSync(profile, 'utf8').startsWith(contents + '\nexport PATH='));
    }
  });
  it('preserves startup bytes and permissions and quotes apostrophes in paths', () => {
    home = path.join(root, "home with 'quotes'");
    fs.mkdirSync(home);
    const profile = path.join(home, '.zshrc');
    fs.writeFileSync(profile, '# User settings without final newline', { mode: 0o640 });
    const result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.isTrue(fs.readFileSync(profile, 'utf8').startsWith('# User settings without final newline\n'));
    assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
  });
  it('offers setup only for an existing unconfigured installation', () => {
    assert.equal(run('y\ny\n', { FAKE_SKIP_BACKUP: '1' }).status, 1);
    assert.notInclude(readLog(), 'ballin:backup setup');
    const result = run('y\n');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readLog().split('ballin:backup setup').length - 1, 1);
    assert.include(readLog(), 'ballin:backup\nballin:backup open');
  });
  for (const flag of ['FAKE_DOWNLOAD_FAIL', 'FAKE_INSTALL_FAIL', 'FAKE_BACKUP_FAIL']) {
    it(`never opens a browser after ${flag}`, () => {
      const result = run('y\ny\n', { [flag]: '1' });
      assert.equal(result.status, flag === 'FAKE_DOWNLOAD_FAIL' ? 22 : 1);
      assert.notInclude(readLog(), 'ballin:backup open');
      if (flag !== 'FAKE_BACKUP_FAIL') assert.notInclude(readLog(), 'ballin:backup\n');
    });
  }
  it('does not capture after cancelling a fresh Ballin install', () => {
    assert.equal(run('y\nn\n').status, 0);
    assert.notInclude(readLog(), 'ballin:');
  });
  it('rejects unsupported platforms before changing home files', () => {
    for (const env of [{ FAKE_OS: 'Linux' }, { FAKE_MACOS: '13.4' }, { FAKE_ARCH: 'i386' }]) {
      assert.equal(run('', env).status, 1);
      assert.isFalse(fs.existsSync(path.join(home, '.local')));
    }
  });
});
