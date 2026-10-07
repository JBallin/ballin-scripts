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
  const runCopiedCommand = (shell: string, input: string, overrides: NodeJS.ProcessEnv = {}) => {
    const guide = fs.readFileSync(path.join(__dirname, '../docs/quickstart.md'), 'utf8');
    const command = guide.match(/```shell\n([\s\S]*?)\n```/)?.[1];
    assert.isString(command, 'Exercise the actual pasted guide command');
    return spawnSync('/bin/' + shell, ['-c', command], {
      encoding: 'utf8', input, cwd: home, timeout: 12000,
      env: testChildEnvironment({
        HOME: home, PATH: tools, TMPDIR: path.join(root, 'tmp'), SHELL: '/bin/' + shell,
        FAKE_ROOT: root, FAKE_COMMAND_LOG: log, FAKE_QUICK_DOWNLOAD: 'success',
        FAKE_QUICKSTART_EXIT: '0', ...overrides,
      }),
    });
  };
  const run = (input = 'y\ny\n', overrides: NodeJS.ProcessEnv = {}) => spawnSync('/bin/bash', ['-c', `
source "$FAKE_SOURCE"
system_node_bin="$FAKE_SYSTEM_NODE"
system_git="\${FAKE_SYSTEM_GIT:-$FAKE_ROOT/tools/git}"
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
    fs.writeFileSync(path.join(root, 'quickstart-entrypoint'), '#!/bin/bash\n'
      + 'set -euo pipefail\n'
      + 'printf "downloaded-quickstart:started\\n" >> "$FAKE_COMMAND_LOG"\n'
      + 'touch "$FAKE_ROOT/entrypoint-ran"\n'
      + 'printf "Native fixture prompt: "\n'
      + 'IFS= read -r answer\n'
      + '[[ "$answer" == device-code ]] || exit 91\n'
      + 'printf "downloaded-quickstart:stdin-preserved\\n" >> "$FAKE_COMMAND_LOG"\n'
      + 'exit "$FAKE_QUICKSTART_EXIT"\n');
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
  git)
    [[ "$*" == --version ]] || exit 97
    if [[ "$0" == "$FAKE_ROOT/tools/git" && "\${FAKE_BROKEN_PATH_GIT:-0}" == 1 ]]; then exit 1; fi
    [[ "\${FAKE_GIT:-ready}" == ready || -f "$FAKE_ROOT/git-installed" ]] ;;
  brew)
    [[ "$*" == --prefix ]] || exit 97
    [[ "\${FAKE_BREW_FAIL:-0}" != 1 ]] || exit 42
    printf '%s\\n' "$FAKE_BREW_PREFIX" ;;
  xcode-select)
    if [[ "$*" == -p ]]; then [[ "\${FAKE_GIT:-ready}" == ready || -f "$FAKE_ROOT/git-installed" ]]; exit; fi
    [[ "$*" == --install ]] || exit 97
    [[ "\${FAKE_XCODE_FAIL:-0}" != 1 ]] || exit 1
    touch "$FAKE_ROOT/git-installed" ;;
  node)
    if [[ "$1" == -p ]]; then
      if [[ "$0" == "$FAKE_ROOT/tools/node" && "\${FAKE_OLD_NODE:-0}" == 1 ]]; then printf 'false\\n'; else printf 'true\\n'; fi
    elif [[ "\${FAKE_CHANGE_PROFILE:-0}" == 1 && "$1" == -e && "$3" == "$HOME/.zshrc" ]]; then
      "$TEST_NODE_RUNTIME" "$@"
      printf '# Changed while validating\\n' > "$3"
    else exec "$TEST_NODE_RUNTIME" "$@"; fi ;;
  gh)
    case "$*" in
      --version) printf 'gh version fixture\\n' ;;
      'auth status --help') printf '%s\\n' '--active' ;;
      'auth status --active --hostname github.com')
        if [[ -n "\${FAKE_TOKEN_SOURCE:-}" ]]; then
          [[ "\${!FAKE_TOKEN_SOURCE}" == fixture-invalid-token ]] || exit 97
          printf 'token-preserved:status:%s\\n' "$FAKE_TOKEN_SOURCE" >> "$FAKE_COMMAND_LOG"
          exit 1
        fi
        [[ "\${FAKE_AUTH:-ready}" == ready || -f "$FAKE_ROOT/login-complete" ]] ;;
      'auth login --hostname github.com --git-protocol https --web')
        if [[ -n "\${FAKE_TOKEN_SOURCE:-}" ]]; then
          [[ "\${!FAKE_TOKEN_SOURCE}" == fixture-invalid-token ]] || exit 97
          printf 'token-preserved:login:%s\\n' "$FAKE_TOKEN_SOURCE" >> "$FAKE_COMMAND_LOG"
          printf 'The %s environment variable controls authentication.\\nClear it from the environment before logging in.\\n' "$FAKE_TOKEN_SOURCE" >&2
          exit 1
        fi
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
      https://raw.githubusercontent.com/JBallin/ballin-scripts/main/quickstart.sh)
        if [[ "$FAKE_QUICK_DOWNLOAD" == empty ]]; then printf 'Fixture curl failure\\n' >&2; exit 22; fi
        if [[ -n "$target" ]]; then cp "$FAKE_ROOT/quickstart-entrypoint" "$target"
        else cat "$FAKE_ROOT/quickstart-entrypoint"; fi
        if [[ "$FAKE_QUICK_DOWNLOAD" == partial ]]; then printf 'Fixture curl failure\\n' >&2; exit 22; fi ;;
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
    assert.isFalse(fs.existsSync(path.join(tools, 'npm')));
    const result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr + readLog());
    assert.include(result.stdout, 'Native installation prompt:');
    assert.notInclude(readLog(), 'sudo:');
    assert.include(readLog(), 'ballin:backup\nballin:backup open\n');
    for (const unexpected of ['sudo:', 'xcode-select:--install', 'releases/latest', 'ballin:update']) assert.notInclude(readLog(), unexpected);
    assert.include(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), 'export PATH=');
  });
  it('keeps the local command directory when optional Homebrew prefix lookup fails', () => {
    linkFake('brew');
    const result = run('y\ny\n', { FAKE_BREW_FAIL: '1' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), ":$PATH:'" + path.join(home, '.local/bin') + "'");
    assert.include(readLog(), 'brew:--prefix');
    assert.include(readLog(), 'install.sh:');
    assert.include(readLog(), 'ballin:backup open');
    assert.notInclude(readLog(), 'sudo:');
  });
  for (const installed of [true, false]) {
    it(`uses working system Git past a broken PATH shim${installed ? ' without installation' : ' after installing Command Line Tools'}`, () => {
      const systemGit = path.join(root, 'system-git');
      fs.mkdirSync(systemGit);
      linkFake('git', systemGit);
      const selectedGit = path.join(systemGit, 'git');
      const result = run(installed ? 'y\ny\n' : 'y\ny\ny\ny\n', {
        FAKE_SYSTEM_GIT: selectedGit, FAKE_BROKEN_PATH_GIT: '1', FAKE_GIT: installed ? 'ready' : 'missing',
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(fs.readlinkSync(path.join(home, '.local/share/ballin-quickstart/bin/git')), selectedGit);
      if (installed) assert.notInclude(readLog(), 'xcode-select:--install');
      else assert.include(readLog(), 'xcode-select:--install');
      assert.include(readLog(), 'ballin:backup open');
    });
  }
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
  for (const spelling of ['trailing slash', 'directory symlink', 'parent segment']) {
    it('preserves managed Node fallbacks through a PATH ' + spelling, () => {
      linkFake('npm', systemNode);
      const first = run('y\ny\ny\n', { FAKE_OLD_NODE: '1' });
      assert.equal(first.status, 0, first.stdout + first.stderr);
      const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
      const alias = path.join(root, 'managed-bin-alias');
      fs.symlinkSync(quickBin, alias);
      const entry = spelling === 'trailing slash' ? quickBin + '/'
        : spelling === 'directory symlink' ? alias : quickBin + '/../bin';
      const profile = path.join(home, '.zshrc');
      const before = fs.readFileSync(profile, 'utf8');
      const rerun = run('', { PATH: `${entry}:${tools}`, FAKE_OLD_NODE: '1' });
      assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
      for (const name of ['node', 'npm']) {
        assert.equal(fs.readlinkSync(path.join(quickBin, name)), path.join(systemNode, name));
      }
      for (const name of ['git', 'gh']) assert.equal(fs.readlinkSync(path.join(quickBin, name)), path.join(tools, name));
      assert.equal(fs.readFileSync(profile, 'utf8'), before);
      assert.equal(readLog().split('sudo:').length - 1, 1);
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));

      const managerBin = path.join(home, '.nvm/versions/node/v24.21.0/bin');
      fs.mkdirSync(managerBin, { recursive: true });
      linkFake('node', managerBin);
      linkFake('npm', managerBin);
      const takeover = run('', { PATH: `${entry}:${managerBin}:${tools}`, FAKE_OLD_NODE: '1' });
      assert.equal(takeover.status, 0, takeover.stdout + takeover.stderr);
      for (const name of ['node', 'npm']) assert.isFalse(fs.existsSync(path.join(quickBin, name)));
      for (const name of ['git', 'gh']) assert.equal(fs.readlinkSync(path.join(quickBin, name)), path.join(tools, name));
      assert.equal(fs.readFileSync(profile, 'utf8'), before);
      assert.equal(readLog().split('sudo:').length - 1, 1);
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    });
  }
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
  for (const tokenSource of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    it(`retains ${tokenSource} and exposes native CLI refusal before installing Ballin`, () => {
      const result = run('y\n', { FAKE_TOKEN_SOURCE: tokenSource, [tokenSource]: 'fixture-invalid-token' });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.include(result.stderr, tokenSource);
      assert.include(result.stderr, 'Clear it from the environment before logging in');
      assert.notInclude(result.stdout + result.stderr + readLog(), 'fixture-invalid-token');
      assert.include(readLog(), `token-preserved:status:${tokenSource}`);
      assert.include(readLog(), `token-preserved:login:${tokenSource}`);
      assert.notInclude(result.stdout, 'Native login prompt:');
      assert.isFalse(fs.existsSync(path.join(root, 'login-complete')));
      assert.notInclude(readLog(), '/main/install.sh');
      assert.notInclude(readLog(), 'install.sh:');
      assert.notInclude(readLog(), 'ballin:');
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    });
  }
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
    for (const shell of ['/bin/zsh', '/bin/bash']) {
      const profile = path.join(home, shell.endsWith('zsh') ? '.zshrc' : '.bash_profile');
      for (const prefix of ['export EXAMPLE=1 ', "printf '%s' '# not a comment' "]) {
        for (const suffix of ['\\', '\\\n']) {
          const contents = prefix + suffix;
          fs.writeFileSync(profile, contents);
          const result = run('', { SHELL: shell });
          assert.equal(result.status, 1, result.stdout + result.stderr);
          assert.include(result.stderr, 'unfinished continuation');
          assert.equal(fs.readFileSync(profile, 'utf8'), contents);
        }
      }
    }
    assert.notInclude(readLog(), 'install.sh:');
  });
  it('accepts trailing comment backslashes without changing existing bytes in either shell', () => {
    for (const shell of ['/bin/zsh', '/bin/bash']) {
      const profile = path.join(home, shell.endsWith('zsh') ? '.zshrc' : '.bash_profile');
      for (const prefix of ['# Windows path C:', 'export EXAMPLE=1 # Windows path C:']) {
        for (const suffix of ['\\', '\\\n']) {
          const contents = prefix + suffix;
          fs.writeFileSync(profile, contents);
          const result = run('y\ny\n', { SHELL: shell });
          assert.equal(result.status, 0, result.stdout + result.stderr);
          assert.isTrue(fs.readFileSync(profile, 'utf8').startsWith(contents + '\nexport PATH='));
        }
      }
    }
    assert.include(readLog(), 'ballin:backup open');
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
  for (const shell of ['bash', 'zsh']) {
    for (const kind of ['false-branch', 'completed-heredoc', 'heredoc-delimiter', 'continued-command'] as const) {
      it(`adds a usable PATH after an inactive matching line in ${shell}: ${kind}`, () => {
        const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
        const commandBin = path.join(home, '.local/bin');
        const line = `export PATH='${quickBin}':$PATH:'${commandBin}'`;
        const profile = path.join(home, shell === 'bash' ? '.bash_profile' : '.zshrc');
        const sentinel = path.join(root, 'profile-executed');
        const constructs = {
          'false-branch': `if false; then\n${line}\nfi\n`,
          'completed-heredoc': `: <<'END'\n${line}\nEND\n`,
          'heredoc-delimiter': `: <<"${line}"\nExisting text\n${line}\n`,
          'continued-command': `: \\\n${line}\n`,
        };
        const contents = `touch '${sentinel}'\n` + constructs[kind];
        fs.writeFileSync(profile, contents, { mode: 0o640 });
        const result = run('y\ny\n', { SHELL: `/bin/${shell}` });
        assert.equal(result.status, 0, result.stdout + result.stderr + readLog());
        assert.include(result.stdout, 'Use these tools in new Terminal windows?');
        assert.isFalse(fs.existsSync(sentinel), 'Validation must not execute startup contents');
        const after = contents + '\n' + line + '\n';
        assert.equal(fs.readFileSync(profile, 'utf8'), after);
        assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
        const args = shell === 'bash' ? ['--noprofile', '--norc', '-c'] : ['-f', '-c'];
        const fresh = spawnSync(`/bin/${shell}`, [...args, 'source "$FAKE_PROFILE"; printf "%s" "$PATH"'], {
          encoding: 'utf8', cwd: home,
          env: testChildEnvironment({ HOME: home, PATH: tools, FAKE_PROFILE: profile }),
        });
        assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
        assert.equal(fresh.stdout, `${quickBin}:${tools}:${commandBin}`);
        fs.unlinkSync(sentinel);
        const rerun = run('', { SHELL: `/bin/${shell}`, PATH: `${quickBin}:${tools}` });
        assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
        assert.equal(fs.readFileSync(profile, 'utf8'), after);
        assert.notInclude(rerun.stdout, 'Use these tools in new Terminal windows?');
        assert.isFalse(fs.existsSync(sentinel), 'Repeat validation must not execute startup contents');
      });
    }
    it(`preserves an inactive matching line when the ${shell} PATH change is declined`, () => {
      const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
      const line = `export PATH='${quickBin}':$PATH:'${path.join(home, '.local/bin')}'`;
      const profile = path.join(home, shell === 'bash' ? '.bash_profile' : '.zshrc');
      const contents = `if false; then\n${line}\nfi\n`;
      fs.writeFileSync(profile, contents);
      const result = run('n\n', { SHELL: `/bin/${shell}` });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.include(result.stderr, 'PATH setup was declined');
      assert.equal(fs.readFileSync(profile, 'utf8'), contents);
      assert.notInclude(readLog(), 'install.sh:');
      assert.notInclude(readLog(), 'auth status --active');
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    });
  }
  it('reuses a final standalone PATH command after a comment backslash, with or without a final newline', () => {
    const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
    const line = `export PATH='${quickBin}':$PATH:'${path.join(home, '.local/bin')}'`;
    for (const shell of ['bash', 'zsh']) {
      const profile = path.join(home, shell === 'bash' ? '.bash_profile' : '.zshrc');
      for (const ending of ['', '\n']) {
        const contents = '# Windows path C:\\\n' + line + ending;
        fs.writeFileSync(profile, contents);
        const result = run('y\n', { SHELL: `/bin/${shell}` });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(fs.readFileSync(profile, 'utf8'), contents);
        assert.notInclude(result.stdout, 'Use these tools in new Terminal windows?');
      }
    }
  });
  it('asks before changing a profile that changed after the PATH reuse check', () => {
    const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
    const line = `export PATH='${quickBin}':$PATH:'${path.join(home, '.local/bin')}'`;
    const profile = path.join(home, '.zshrc');
    fs.writeFileSync(profile, line + '\n');
    const result = run('n\n', { FAKE_CHANGE_PROFILE: '1' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.include(result.stderr, 'PATH setup was declined');
    assert.equal(fs.readFileSync(profile, 'utf8'), '# Changed while validating\n');
    assert.notInclude(readLog(), 'install.sh:');
    assert.notInclude(readLog(), 'auth status --active');
  });
  it('refuses a confirmed PATH append when the checked profile changed', () => {
    const profile = path.join(home, '.zshrc');
    fs.writeFileSync(profile, '# Original settings\n');
    const result = run('y\n', { FAKE_CHANGE_PROFILE: '1' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.include(result.stderr, 'startup file changed during setup');
    assert.equal(fs.readFileSync(profile, 'utf8'), '# Changed while validating\n');
    assert.notInclude(readLog(), 'install.sh:');
    assert.notInclude(readLog(), 'auth status --active');
    assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
  });
  it('refuses a transfer introduced while copying the checked profile', () => {
    const profile = path.join(home, '.zshrc');
    fs.writeFileSync(profile, '# Original settings\n');
    fs.unlinkSync(path.join(tools, 'cp'));
    fs.writeFileSync(path.join(tools, 'cp'), `#!/bin/bash
set -euo pipefail
if [[ "$1" == -p && "$2" == "$HOME/.zshrc" ]]; then printf 'return\\n' > "$2"; fi
exec /bin/cp "$@"
`, { mode: 0o755 });
    const result = run('y\n');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.include(result.stderr, 'startup file changed during setup');
    assert.equal(fs.readFileSync(profile, 'utf8'), 'return\n');
    assert.notInclude(readLog(), 'install.sh:');
    assert.notInclude(readLog(), 'auth status --active');
    assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    assert.notInclude(fs.readdirSync(home).join('\n'), '.ballin-quickstart.');
  });
  for (const shell of ['bash', 'zsh']) {
    it(`requires manual PATH placement for ambiguous arithmetic in ${shell}`, () => {
      const profile = path.join(home, shell === 'bash' ? '.bash_profile' : '.zshrc');
      const line = `export PATH='${path.join(home, '.local/share/ballin-quickstart/bin')}':$PATH:'${path.join(home, '.local/bin')}'`;
      const sentinel = path.join(root, 'profile-executed');
      for (const arithmetic of ['(( value = (1 << 2) ))', 'VALUE=$[1 << 2]']) {
        for (const existingPath of [false, true]) {
          const contents = `touch '${sentinel}'\n${arithmetic}\nreturn\n` + (existingPath ? line + '\n' : '');
          fs.writeFileSync(profile, contents, { mode: 0o640 });
          const result = run('', { SHELL: `/bin/${shell}` });
          assert.equal(result.status, 1, contents + result.stdout + result.stderr);
          assert.include(result.stderr, `Manual PATH setup for ${profile}:\n${line}\n`);
          assert.include(result.stderr, 'shell syntax that this check cannot interpret safely');
          assert.notInclude(result.stdout, 'Use these tools in new Terminal windows?');
          assert.equal(fs.readFileSync(profile, 'utf8'), contents);
          assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
          assert.isFalse(fs.existsSync(sentinel), 'Validation must not execute startup contents');
          assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
        }
      }
      assert.notInclude(readLog(), 'auth status --active');
      assert.notInclude(readLog(), '/main/install.sh');
      assert.notInclude(readLog(), 'install.sh:');
      assert.notInclude(readLog(), 'ballin:');
    });
    for (const existingPath of [false, true]) {
      it(`preserves ${shell} profiles with ambiguous brace/hash words before PATH ${existingPath ? 'reuse' : 'append'}`, () => {
        const profile = path.join(home, shell === 'bash' ? '.bash_profile' : '.zshrc');
        const line = `export PATH='${path.join(home, '.local/share/ballin-quickstart/bin')}':$PATH:'${path.join(home, '.local/bin')}'`;
        const sentinel = path.join(root, 'profile-executed');
        for (const prefix of [': \\${#PATH};', 'echo foo{#bar};', 'echo foo}#bar;']) {
          for (const command of ['return', 'exit 0', 'exec /bin/true']) {
            const contents = `touch '${sentinel}'\n${prefix} ${command}\n` + (existingPath ? line + '\n' : '');
            fs.writeFileSync(profile, contents, { mode: 0o640 });
            const result = run('', { SHELL: `/bin/${shell}` });
            assert.equal(result.status, 1, contents + result.stdout + result.stderr);
            assert.include(result.stderr, `Manual PATH setup for ${profile}:\n${line}\n`);
            assert.include(result.stderr, 'shell syntax that this check cannot interpret safely');
            assert.notInclude(result.stdout, 'Use these tools in new Terminal windows?');
            assert.equal(fs.readFileSync(profile, 'utf8'), contents);
            assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
            assert.isFalse(fs.existsSync(sentinel), 'Validation must not execute startup contents');
            assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
          }
        }
        assert.notInclude(readLog(), 'auth status --active');
        assert.notInclude(readLog(), '/main/install.sh');
        assert.notInclude(readLog(), 'install.sh:');
        assert.notInclude(readLog(), 'ballin:');
      });
      if (shell === 'zsh') {
        it(`requires manual placement for a zsh brace-adjacent block comment before PATH ${existingPath ? 'reuse' : 'append'}`, () => {
          const profile = path.join(home, '.zshrc');
          const line = `export PATH='${path.join(home, '.local/share/ballin-quickstart/bin')}':$PATH:'${path.join(home, '.local/bin')}'`;
          const sentinel = path.join(root, 'profile-executed');
          const contents = `touch '${sentinel}'\n{# harmless block comment\n:\n}\n` + (existingPath ? line + '\n' : '');
          fs.writeFileSync(profile, contents, { mode: 0o640 });
          const result = run('', { SHELL: '/bin/zsh' });
          assert.equal(result.status, 1, result.stdout + result.stderr);
          assert.include(result.stderr, `Manual PATH setup for ${profile}:\n${line}\n`);
          assert.include(result.stderr, 'shell syntax that this check cannot interpret safely');
          assert.notInclude(result.stdout, 'Use these tools in new Terminal windows?');
          assert.equal(fs.readFileSync(profile, 'utf8'), contents);
          assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
          assert.isFalse(fs.existsSync(sentinel));
          assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
          assert.notInclude(readLog(), 'auth status --active');
          assert.notInclude(readLog(), '/main/install.sh');
          assert.notInclude(readLog(), 'ballin:');
        });
      }
      it(`preserves ${shell} profiles with parameter-length expansions before PATH ${existingPath ? 'reuse' : 'append'}`, () => {
        const profile = path.join(home, shell === 'bash' ? '.bash_profile' : '.zshrc');
        const line = `export PATH='${path.join(home, '.local/share/ballin-quickstart/bin')}':$PATH:'${path.join(home, '.local/bin')}'`;
        const sentinel = path.join(root, 'profile-executed');
        const forms = [
          '[ ${#PATH} -gt 0 ] && return',
          'if [ ${#example} -gt 3 ]; then exit 0; fi',
          '[ ${#PATH} -gt 0 ] && exec /bin/true',
          'case ${#PATH} in *) builtin return ;; esac',
          'VALUE=${#PATH} return 0',
        ];
        for (const form of forms) {
          const contents = `touch '${sentinel}'\nexample=abcd\n${form}\n` + (existingPath ? line + '\n' : '');
          fs.writeFileSync(profile, contents, { mode: 0o640 });
          const result = run('', { SHELL: `/bin/${shell}` });
          assert.equal(result.status, 1, contents + result.stdout + result.stderr);
          assert.include(result.stderr, `Manual PATH setup for ${profile}:\n${line}\n`);
          assert.notInclude(result.stdout, 'Use these tools in new Terminal windows?');
          assert.equal(fs.readFileSync(profile, 'utf8'), contents);
          assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
          assert.isFalse(fs.existsSync(sentinel), 'Validation must not execute startup contents');
          assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
        }
        assert.notInclude(readLog(), 'auth status --active');
        assert.notInclude(readLog(), '/main/install.sh');
        assert.notInclude(readLog(), 'install.sh:');
        assert.notInclude(readLog(), 'ballin:');
      });
      it(`preserves ${shell} profiles with case-arm transfers before PATH ${existingPath ? 'reuse' : 'append'}`, () => {
        const profile = path.join(home, shell === 'bash' ? '.bash_profile' : '.zshrc');
        const line = `export PATH='${path.join(home, '.local/share/ballin-quickstart/bin')}':$PATH:'${path.join(home, '.local/bin')}'`;
        const sentinel = path.join(root, 'profile-executed');
        const forms = [
          'case "$TERM" in dumb) return ;; esac',
          'case "$TERM" in (dumb) exit 0 ;; esac',
          'case "$TERM" in dumb|unknown) exec /bin/true ;; esac',
          'case "$TERM" in\n dumb) VALUE=x builtin return 0 ;;\n *) : ;;\nesac',
          'if true; then\n case "$TERM" in dumb) return ;; esac\nfi',
        ];
        for (const form of forms) {
          const contents = `touch '${sentinel}'\n${form}\n` + (existingPath ? line + '\n' : '');
          fs.writeFileSync(profile, contents, { mode: 0o640 });
          const result = run('', { SHELL: `/bin/${shell}` });
          assert.equal(result.status, 1, contents + result.stdout + result.stderr);
          assert.include(result.stderr, `Manual PATH setup for ${profile}:\n${line}\n`);
          assert.include(result.stderr, 'recognized return, exit, logout, or executable exec form');
          assert.notInclude(result.stdout, 'Use these tools in new Terminal windows?');
          assert.equal(fs.readFileSync(profile, 'utf8'), contents);
          assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
          assert.isFalse(fs.existsSync(sentinel), 'Validation must not execute startup contents');
          assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
        }
        assert.notInclude(readLog(), 'auth status --active');
        assert.notInclude(readLog(), '/main/install.sh');
        assert.notInclude(readLog(), 'install.sh:');
        assert.notInclude(readLog(), 'ballin:');
      });
      it(`preserves ${shell} profiles with arithmetic then transfer before PATH ${existingPath ? 'reuse' : 'append'}`, () => {
        const profile = path.join(home, shell === 'bash' ? '.bash_profile' : '.zshrc');
        const line = `export PATH='${path.join(home, '.local/share/ballin-quickstart/bin')}':$PATH:'${path.join(home, '.local/bin')}'`;
        const sentinel = path.join(root, 'profile-executed');
        for (const arithmetic of ['(( value = 1 << 2 ))', 'VALUE=$((1 << 2))']) {
          for (const transfer of ['return', 'exit 0']) {
            const contents = `touch '${sentinel}'\n${arithmetic}\n${transfer}\n` + (existingPath ? line + '\n' : '');
            fs.writeFileSync(profile, contents, { mode: 0o640 });
            const result = run('', { SHELL: `/bin/${shell}` });
            assert.equal(result.status, 1, contents + result.stdout + result.stderr);
            assert.include(result.stderr, `Manual PATH setup for ${profile}:\n${line}\n`);
            assert.include(result.stderr, 'recognized return, exit, logout, or executable exec form');
            assert.notInclude(result.stdout, 'Use these tools in new Terminal windows?');
            assert.equal(fs.readFileSync(profile, 'utf8'), contents);
            assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
            assert.isFalse(fs.existsSync(sentinel), 'Validation must not execute startup contents');
            assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
          }
        }
        assert.notInclude(readLog(), 'auth status --active');
        assert.notInclude(readLog(), '/main/install.sh');
        assert.notInclude(readLog(), 'install.sh:');
        assert.notInclude(readLog(), 'ballin:');
      });
      it(`preserves ${shell} profiles with a here-string then transfer before PATH ${existingPath ? 'reuse' : 'append'}`, () => {
        const profile = path.join(home, shell === 'bash' ? '.bash_profile' : '.zshrc');
        const line = `export PATH='${path.join(home, '.local/share/ballin-quickstart/bin')}':$PATH:'${path.join(home, '.local/bin')}'`;
        const sentinel = path.join(root, 'profile-executed');
        for (const operand of ['text', "'return; exit; exec /bin/true'", '"text"', '"multi\nreturn\nline"']) {
          for (const transfer of ['return', 'exit 0']) {
            const contents = `touch '${sentinel}'\n: <<< ${operand}\n${transfer}\n` + (existingPath ? line + '\n' : '');
            fs.writeFileSync(profile, contents, { mode: 0o640 });
            const result = run('', { SHELL: `/bin/${shell}` });
            assert.equal(result.status, 1, contents + result.stdout + result.stderr);
            assert.include(result.stderr, `Manual PATH setup for ${profile}:\n${line}\n`);
            assert.include(result.stderr, 'recognized return, exit, logout, or executable exec form');
            assert.notInclude(result.stdout, 'Use these tools in new Terminal windows?');
            assert.equal(fs.readFileSync(profile, 'utf8'), contents);
            assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
            assert.isFalse(fs.existsSync(sentinel), 'Validation must not execute startup contents');
            assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
          }
        }
        assert.notInclude(readLog(), 'auth status --active');
        assert.notInclude(readLog(), '/main/install.sh');
        assert.notInclude(readLog(), 'install.sh:');
        assert.notInclude(readLog(), 'ballin:');
      });
      it(`leaves recognized transfers unchanged in ${shell} before PATH ${existingPath ? 'reuse' : 'append'}`, () => {
        const profile = path.join(home, shell === 'bash' ? '.bash_profile' : '.zshrc');
        const line = `export PATH='${path.join(home, '.local/share/ballin-quickstart/bin')}':$PATH:'${path.join(home, '.local/bin')}'`;
        const sentinel = path.join(root, 'profile-executed');
        const transfers = [
          'return', 'exit 0', 'exec /bin/true', 'exec "$SHELL"',
          'command return 0', 'VALUE=x builtin exit 0',
          'if false; then return; fi', 'stop() { return 0; }',
          'exec -a replacement /bin/true', 'exec 3>&1 /bin/true', 'return\\\n 0',
        ];
        for (const transfer of transfers) {
          const contents = `touch '${sentinel}'\n${transfer}\n` + (existingPath ? line + '\n' : '');
          fs.writeFileSync(profile, contents, { mode: 0o640 });
          const result = run('', { SHELL: `/bin/${shell}` });
          assert.equal(result.status, 1, transfer + result.stdout + result.stderr);
          assert.include(result.stderr, `Manual PATH setup for ${profile}:\n${line}\n`);
          assert.include(result.stderr, 'recognized return, exit, logout, or executable exec form');
          assert.include(result.stderr, 'Place the displayed line where your shell will execute it');
          assert.include(result.stderr, '/docs/installation.md');
          assert.notInclude(result.stdout, 'Use these tools in new Terminal windows?');
          assert.equal(fs.readFileSync(profile, 'utf8'), contents);
          assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
          assert.isFalse(fs.existsSync(sentinel), 'Validation must not execute startup contents');
          assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
        }
        assert.notInclude(readLog(), 'auth status --active');
        assert.notInclude(readLog(), '/main/install.sh');
        assert.notInclude(readLog(), 'install.sh:');
        assert.notInclude(readLog(), 'ballin:');
      });
    }
    it(`accepts harmless transfer words and redirection-only exec in ${shell}`, () => {
      const profile = path.join(home, shell === 'bash' ? '.bash_profile' : '.zshrc');
      const sentinel = path.join(root, 'profile-executed');
      const harmless = [
        '# return; exit 0; exec /bin/true\n',
        "printf '%s\\n' 'return; exit 0; exec /bin/true' # return\n",
        'VALUE="return\nexit 0\nexec /bin/true"\n',
        ": <<'END'\nreturn\nexit 0\nexec /bin/true\nEND\n",
        ': <<-"END"\n\treturn\n\texit 0\n\texec /bin/true\n\tEND\n',
        ": <<< 'return; exit; exec /bin/true'\n: <<< text\n",
        '(( value = 1 << 2 ))\nVALUE=$((1 << 2))\n',
        'exec 3>&1\nexec >"$HOME/output"\n',
        'VALUE=${EXAMPLE:-return}\nprintf %s "$(printf exit)"\n',
        'returnish=1\nexit_status=0\nprintf %s exec\n',
        'case "$TERM" in dumb) : ;; *) printf %s return ;; esac\n',
        "CASE_TEXT='case \"$TERM\" in dumb) return ;; esac'\n# case text) exit ;;\n",
        "case \"$TERM\" in 'dumb) return') : ;; esac\n",
        '[ ${#PATH} -gt 0 ] && printf %s return\n',
        'VALUE=${#PATH} # return; exit; exec /bin/true\n',
        "printf %s '${#PATH} && return'\n",
        '{ # return; exit; exec /bin/true\n:\n}\n',
        "printf %s 'foo{#bar}; return'\n",
      ];
      for (const text of harmless) {
        const contents = `touch '${sentinel}'\n` + text;
        fs.writeFileSync(profile, contents, { mode: 0o640 });
        const result = run('y\ny\n', { SHELL: `/bin/${shell}` });
        assert.equal(result.status, 0, text + result.stdout + result.stderr);
        assert.isTrue(fs.readFileSync(profile, 'utf8').startsWith(contents + '\nexport PATH='));
        assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
        assert.isFalse(fs.existsSync(sentinel), 'Validation must not execute startup contents');
        assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
      }
      assert.include(readLog(), 'ballin:backup open');
    });
  }
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
  for (const existingPath of [false, true]) {
    it('detects supported Bash wrapper options before PATH ' + (existingPath ? 'reuse' : 'append'), () => {
      const profile = path.join(home, '.bash_profile');
      const line = "export PATH='" + path.join(home, '.local/share/ballin-quickstart/bin')
        + "':$PATH:'" + path.join(home, '.local/bin') + "'";
      const sentinel = path.join(root, 'profile-executed');
      const transfers = [
        'command -p return', 'command -- exit 0', 'command -p -- exec /bin/true',
        'builtin -- return', 'command -- builtin -- return',
        'time -p exit 0', 'time -- return', 'time -p command -p builtin -- exec /bin/true',
      ];
      for (const transfer of transfers) {
        const contents = "touch '" + sentinel + "'\n" + transfer + '\n' + (existingPath ? line + '\n' : '');
        fs.writeFileSync(profile, contents, { mode: 0o640 });
        const result = run('', { SHELL: '/bin/bash' });
        assert.equal(result.status, 1, transfer + result.stdout + result.stderr);
        assert.include(result.stderr, 'recognized return, exit, logout, or executable exec');
        assert.include(result.stderr, 'Manual PATH setup for ' + profile);
        assert.equal(fs.readFileSync(profile, 'utf8'), contents);
        assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
        assert.isFalse(fs.existsSync(sentinel));
        assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
      }
      for (const prohibited of ['auth status --active', 'install.sh:', 'ballin:']) assert.notInclude(readLog(), prohibited);
    });
    it('uses manual fallback for unsupported Bash wrapper options before PATH ' + (existingPath ? 'reuse' : 'append'), () => {
      const profile = path.join(home, '.bash_profile');
      const line = "export PATH='" + path.join(home, '.local/share/ballin-quickstart/bin')
        + "':$PATH:'" + path.join(home, '.local/bin') + "'";
      const sentinel = path.join(root, 'profile-executed');
      for (const wrapper of ['command -q return', 'builtin -q exit 0', 'time -q /bin/true']) {
        const contents = "touch '" + sentinel + "'\n" + wrapper + '\n' + (existingPath ? line + '\n' : '');
        fs.writeFileSync(profile, contents, { mode: 0o640 });
        const result = run('', { SHELL: '/bin/bash' });
        assert.equal(result.status, 1, wrapper + result.stdout + result.stderr);
        assert.include(result.stderr, 'shell syntax that this check cannot interpret safely');
        assert.include(result.stderr, 'Manual PATH setup for ' + profile);
        assert.equal(fs.readFileSync(profile, 'utf8'), contents);
        assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
        assert.isFalse(fs.existsSync(sentinel));
        assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
      }
      for (const prohibited of ['auth status --active', 'install.sh:', 'ballin:']) assert.notInclude(readLog(), prohibited);
    });
  }
  for (const shell of ['bash', 'zsh']) {
    for (const existingPath of [false, true]) {
      it('detects logout transfers in ' + shell + ' before PATH ' + (existingPath ? 'reuse' : 'append'), () => {
        const profile = path.join(home, shell === 'bash' ? '.bash_profile' : '.zshrc');
        const line = `export PATH='${path.join(home, '.local/share/ballin-quickstart/bin')}':$PATH:'${path.join(home, '.local/bin')}'`;
        const sentinel = path.join(root, 'profile-executed');
        const transfers = [
          'logout', 'logout 0', 'command logout', 'builtin logout 0',
          'VALUE=x command -- builtin -- logout 0', 'time -p logout',
          'if false; then logout; fi', 'case "$TERM" in dumb) logout ;; esac',
          'stop() { logout; }', 'logout\\\n 0',
          ...(shell === 'zsh' ? ['noglob logout', 'repeat 1 logout', 'repeat 1 nocorrect builtin logout'] : []),
        ];
        for (const transfer of transfers) {
          const contents = `touch '${sentinel}'\n${transfer}\n` + (existingPath ? line + '\n' : '');
          fs.writeFileSync(profile, contents, { mode: 0o640 });
          const result = run('', { SHELL: '/bin/' + shell });
          assert.equal(result.status, 1, transfer + result.stdout + result.stderr);
          assert.include(result.stderr, `Manual PATH setup for ${profile}:\n${line}\n`);
          assert.include(result.stderr, 'recognized return, exit, logout, or executable exec form');
          assert.notInclude(result.stdout, 'Use these tools in new Terminal windows?');
          assert.equal(fs.readFileSync(profile, 'utf8'), contents);
          assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
          assert.isFalse(fs.existsSync(sentinel), 'Validation must not execute startup contents');
          assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
        }
        assert.notInclude(readLog(), 'auth status --active');
        assert.notInclude(readLog(), '/main/install.sh');
        assert.notInclude(readLog(), 'ballin:');
      });
    }
    it('preserves harmless logout data through PATH append and reuse in ' + shell, () => {
      const profile = path.join(home, shell === 'bash' ? '.bash_profile' : '.zshrc');
      const sentinel = path.join(root, 'profile-executed');
      const contents = `touch '${sentinel}'\n`
        + '# logout\n: logout\ncommand -v logout\ncommand -V logout\n'
        + "VALUE='logout'\n: <<'END'\nlogout\nEND\n"
        + ": <<< 'logout'\nlogout_status=0\nprintf %s 'logout'\n";
      fs.writeFileSync(profile, contents, { mode: 0o640 });
      const appended = run('y\ny\n', { SHELL: '/bin/' + shell });
      assert.equal(appended.status, 0, appended.stdout + appended.stderr);
      const installed = fs.readFileSync(profile, 'utf8');
      assert.isTrue(installed.startsWith(contents));
      const reused = run('y\n', { SHELL: '/bin/' + shell });
      assert.equal(reused.status, 0, reused.stdout + reused.stderr);
      assert.equal(fs.readFileSync(profile, 'utf8'), installed);
      assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
      assert.isFalse(fs.existsSync(sentinel), 'Validation must not execute startup contents');
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    });
  }

  for (const existingPath of [false, true]) {
    it('detects zsh repeat bodies before PATH ' + (existingPath ? 'reuse' : 'append'), () => {
      const profile = path.join(home, '.zshrc');
      const line = "export PATH='" + path.join(home, '.local/share/ballin-quickstart/bin')
        + "':$PATH:'" + path.join(home, '.local/bin') + "'";
      const sentinel = path.join(root, 'profile-executed');
      for (const transfer of [
        'repeat 1 return', 'repeat 1 exit 0', 'repeat 2 exec /bin/true',
        'repeat 1 repeat 2 noglob return', 'repeat 1 command -- builtin -- exit 0',
        'repeat 1 do return; done',
      ]) {
        const contents = "touch '" + sentinel + "'\n" + transfer + '\n' + (existingPath ? line + '\n' : '');
        fs.writeFileSync(profile, contents, { mode: 0o640 });
        const result = run('', { SHELL: '/bin/zsh' });
        assert.equal(result.status, 1, transfer + result.stdout + result.stderr);
        assert.include(result.stderr, 'recognized return, exit, logout, or executable exec');
        assert.equal(fs.readFileSync(profile, 'utf8'), contents);
        assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
        assert.isFalse(fs.existsSync(sentinel));
        assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
      }
      for (const prohibited of ['auth status --active', 'install.sh:', 'ballin:']) assert.notInclude(readLog(), prohibited);
    });
    it('requires manual placement for nonliteral zsh repeat counts before PATH ' + (existingPath ? 'reuse' : 'append'), () => {
      const profile = path.join(home, '.zshrc');
      const line = "export PATH='" + path.join(home, '.local/share/ballin-quickstart/bin')
        + "':$PATH:'" + path.join(home, '.local/bin') + "'";
      const sentinel = path.join(root, 'profile-executed');
      for (const count of ['$count', '1+1', '"1"']) {
        const contents = "touch '" + sentinel + "'\nrepeat " + count + ' :\n' + (existingPath ? line + '\n' : '');
        fs.writeFileSync(profile, contents, { mode: 0o640 });
        const result = run('', { SHELL: '/bin/zsh' });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.include(result.stderr, 'shell syntax that this check cannot interpret safely');
        assert.equal(fs.readFileSync(profile, 'utf8'), contents);
        assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
        assert.isFalse(fs.existsSync(sentinel));
        assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
      }
      for (const prohibited of ['auth status --active', 'install.sh:', 'ballin:']) assert.notInclude(readLog(), prohibited);
    });
    it('detects zsh precommand modifiers before PATH ' + (existingPath ? 'reuse' : 'append'), () => {
      const profile = path.join(home, '.zshrc');
      const line = "export PATH='" + path.join(home, '.local/share/ballin-quickstart/bin')
        + "':$PATH:'" + path.join(home, '.local/bin') + "'";
      const sentinel = path.join(root, 'profile-executed');
      for (const transfer of [
        'noglob return', 'nocorrect exit 0', '- return',
        'nocorrect noglob exec /bin/true', 'noglob builtin return',
        'time noglob return', 'nocorrect command -- builtin -- exit 0',
      ]) {
        const contents = "touch '" + sentinel + "'\n" + transfer + '\n' + (existingPath ? line + '\n' : '');
        fs.writeFileSync(profile, contents, { mode: 0o640 });
        const result = run('', { SHELL: '/bin/zsh' });
        assert.equal(result.status, 1, transfer + result.stdout + result.stderr);
        assert.include(result.stderr, 'recognized return, exit, logout, or executable exec');
        assert.include(result.stderr, 'Manual PATH setup for ' + profile);
        assert.equal(fs.readFileSync(profile, 'utf8'), contents);
        assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
        assert.isFalse(fs.existsSync(sentinel));
        assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
      }
      for (const prohibited of ['auth status --active', 'install.sh:', 'ballin:']) assert.notInclude(readLog(), prohibited);
    });
    it('accepts Bash extglob profiles before PATH ' + (existingPath ? 'reuse' : 'append'), () => {
      const selectedDirectory = path.join(root, 'selected shell');
      fs.mkdirSync(selectedDirectory);
      const selectedShell = path.join(selectedDirectory, 'bash');
      fs.writeFileSync(selectedShell, '#!/bin/bash\n'
        + 'printf "selected-parser:%s\\n" "$*" >> "$FAKE_COMMAND_LOG"\n'
        + 'exec /bin/bash "$@"\n', { mode: 0o755 });
      fs.unlinkSync(path.join(tools, 'bash'));
      fs.writeFileSync(path.join(tools, 'bash'), '#!/bin/bash\n'
        + 'if [[ "$1" == -n ]]; then printf "PATH-parser\\n" >> "$FAKE_COMMAND_LOG"; exit 71; fi\n'
        + 'exec /bin/bash "$@"\n', { mode: 0o755 });
      const profile = path.join(home, '.bash_profile');
      const sentinel = path.join(root, 'profile-executed');
      const line = "export PATH='" + path.join(home, '.local/share/ballin-quickstart/bin')
        + "':$PATH:'" + path.join(home, '.local/bin') + "'";
      const contents = "touch '" + sentinel + "'\nshopt -s extglob\ncase foo in +(foo)) :;; esac\n"
        + (existingPath ? line + '\n' : '');
      fs.writeFileSync(profile, contents, { mode: 0o640 });
      const result = run(existingPath ? 'y\n' : 'y\ny\n', { SHELL: selectedShell });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const installed = fs.readFileSync(profile, 'utf8');
      if (existingPath) assert.equal(installed, contents);
      else assert.equal(installed, contents + '\n' + line + '\n');
      const rerun = run('', { SHELL: selectedShell });
      assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
      assert.notInclude(rerun.stdout, 'Use these tools in new Terminal windows?');
      assert.equal(fs.readFileSync(profile, 'utf8'), installed);
      assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
      assert.isFalse(fs.existsSync(sentinel));
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
      const parserCalls = readLog().split('\n').filter((entry) => entry.startsWith('selected-parser:'));
      assert.isNotEmpty(parserCalls);
      for (const entry of parserCalls) assert.include(entry, 'selected-parser:-n -O extglob ');
      assert.notInclude(readLog(), 'PATH-parser');
    });
    it('detects transfers in Bash extglob profiles before PATH ' + (existingPath ? 'reuse' : 'append'), () => {
      const profile = path.join(home, '.bash_profile');
      const line = "export PATH='" + path.join(home, '.local/share/ballin-quickstart/bin')
        + "':$PATH:'" + path.join(home, '.local/bin') + "'";
      const sentinel = path.join(root, 'profile-executed');
      for (const transfer of ['return', 'exit 0', 'exec /bin/true']) {
        const contents = "touch '" + sentinel + "'\nshopt -s extglob\ncase foo in +(foo)) "
          + transfer + ';; esac\n' + (existingPath ? line + '\n' : '');
        fs.writeFileSync(profile, contents, { mode: 0o640 });
        const result = run('', { SHELL: '/bin/bash' });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.include(result.stderr, 'recognized return, exit, logout, or executable exec');
        assert.equal(fs.readFileSync(profile, 'utf8'), contents);
        assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
        assert.isFalse(fs.existsSync(sentinel));
        assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
      }
      for (const prohibited of ['auth status --active', 'install.sh:', 'ballin:']) assert.notInclude(readLog(), prohibited);
    });
  }
  for (const shell of ['bash', 'zsh']) {
    it('preserves harmless repeat forms through PATH append and reuse in ' + shell, () => {
      const profile = path.join(home, shell === 'bash' ? '.bash_profile' : '.zshrc');
      const sentinel = path.join(root, 'profile-executed');
      const contents = "touch '" + sentinel + "'\n"
        + (shell === 'bash' ? 'repeat() { :; }\nrepeat 1 return\n' : 'repeat 2 : return exit exec\nrepeat 1 noglob : return\n')
        + ": 'repeat 1 return'\n# repeat 1 exit\n";
      fs.writeFileSync(profile, contents, { mode: 0o640 });
      const result = run('y\ny\n', { SHELL: '/bin/' + shell });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const installed = fs.readFileSync(profile, 'utf8');
      const rerun = run('', { SHELL: '/bin/' + shell });
      assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
      assert.equal(fs.readFileSync(profile, 'utf8'), installed);
      assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
      assert.isFalse(fs.existsSync(sentinel));
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    });
  }
  it('preserves harmless zsh precommand modifiers and quoted modifier text through PATH append and reuse', () => {
    const profile = path.join(home, '.zshrc');
    const sentinel = path.join(root, 'profile-executed');
    const contents = "touch '" + sentinel + "'\n"
      + "nocorrect noglob : return exit exec\nnoglob builtin : return\n"
      + ": 'noglob return; nocorrect exit; - exec /bin/true'\n# noglob return\n";
    fs.writeFileSync(profile, contents, { mode: 0o640 });
    const result = run('y\ny\n', { SHELL: '/bin/zsh' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const installed = fs.readFileSync(profile, 'utf8');
    const rerun = run('', { SHELL: '/bin/zsh' });
    assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
    assert.equal(fs.readFileSync(profile, 'utf8'), installed);
    assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
    assert.isFalse(fs.existsSync(sentinel));
    assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
  });
  it('rejects malformed Bash extglob profiles without executing or changing them', () => {
    const profile = path.join(home, '.bash_profile');
    const sentinel = path.join(root, 'profile-executed');
    const contents = "touch '" + sentinel + "'\nshopt -s extglob\ncase foo in +(foo)) :;;\n";
    fs.writeFileSync(profile, contents, { mode: 0o640 });
    const result = run('', { SHELL: '/bin/bash' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.include(result.stderr, 'invalid shell syntax');
    assert.equal(fs.readFileSync(profile, 'utf8'), contents);
    assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
    assert.isFalse(fs.existsSync(sentinel));
    assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    for (const prohibited of ['auth status --active', 'install.sh:', 'ballin:']) assert.notInclude(readLog(), prohibited);
  });
  it('keeps zsh-only modifier names as ordinary Bash commands', () => {
    const profile = path.join(home, '.bash_profile');
    const sentinel = path.join(root, 'profile-executed');
    const contents = "touch '" + sentinel + "'\nnoglob() { :; }\nnoglob return\n";
    fs.writeFileSync(profile, contents, { mode: 0o640 });
    const result = run('y\ny\n', { SHELL: '/bin/bash' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.isTrue(fs.readFileSync(profile, 'utf8').startsWith(contents));
    assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
    assert.isFalse(fs.existsSync(sentinel));
    assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
  });
  for (const shell of ['bash', 'zsh']) {
    it('preserves command inspection options through PATH append and reuse in ' + shell, () => {
      const profile = path.join(home, shell === 'bash' ? '.bash_profile' : '.zshrc');
      const sentinel = path.join(root, 'profile-executed');
      const contents = "touch '" + sentinel + "'\n" + [
        'command -v exit', 'command -V return', 'command -pv exec', 'command -pV exit',
        'command -vp return', 'command -Vp exec', 'command -p -v exit',
        'command -- command -pv return',
      ].join('\n') + '\n';
      fs.writeFileSync(profile, contents, { mode: 0o640 });
      const result = run('y\ny\n', { SHELL: '/bin/' + shell });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const installed = fs.readFileSync(profile, 'utf8');
      assert.isTrue(installed.startsWith(contents + '\nexport PATH='));
      const rerun = run('', { SHELL: '/bin/' + shell });
      assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
      assert.notInclude(rerun.stdout, 'Use these tools in new Terminal windows?');
      assert.equal(fs.readFileSync(profile, 'utf8'), installed);
      assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
      assert.isFalse(fs.existsSync(sentinel));
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    });
    for (const invalidProfile of [false, true]) {
      it('uses the exact selected ' + shell + ' parser instead of PATH for ' + (invalidProfile ? 'invalid' : 'valid') + ' profiles', () => {
        const selectedDirectory = path.join(root, 'selected shell');
        fs.mkdirSync(selectedDirectory);
        const selectedShell = path.join(selectedDirectory, shell);
        fs.writeFileSync(selectedShell, '#!/bin/bash\n'
          + 'printf "selected-parser:%s\\n" "$*" >> "$FAKE_COMMAND_LOG"\n'
          + 'exec /bin/' + shell + ' "$@"\n', { mode: 0o755 });
        fs.unlinkSync(path.join(tools, shell));
        fs.writeFileSync(path.join(tools, shell), '#!/bin/bash\n'
          + 'if [[ "$1" == -n ]]; then printf "PATH-parser\\n" >> "$FAKE_COMMAND_LOG"; exit '
          + (invalidProfile ? '0' : '71') + '; fi\n'
          + 'exec /bin/' + shell + ' "$@"\n', { mode: 0o755 });
        const profile = path.join(home, shell === 'bash' ? '.bash_profile' : '.zshrc');
        const sentinel = path.join(root, 'profile-executed');
        const contents = "touch '" + sentinel + "'\n" + (invalidProfile ? 'if\n' : '# Valid fixture\n');
        fs.writeFileSync(profile, contents, { mode: 0o640 });
        const result = run('y\ny\n', { SHELL: selectedShell });
        assert.equal(result.status, invalidProfile ? 1 : 0, result.stdout + result.stderr);
        assert.include(readLog(), 'selected-parser:-n');
        assert.notInclude(readLog(), 'PATH-parser');
        if (invalidProfile) {
          assert.include(result.stderr, 'invalid shell syntax');
          assert.equal(fs.readFileSync(profile, 'utf8'), contents);
          for (const prohibited of ['auth status --active', 'install.sh:', 'ballin:']) assert.notInclude(readLog(), prohibited);
        } else {
          const installed = fs.readFileSync(profile, 'utf8');
          const rerun = run('', { SHELL: selectedShell });
          assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
          assert.equal(fs.readFileSync(profile, 'utf8'), installed);
          assert.notInclude(rerun.stdout, 'Use these tools in new Terminal windows?');
          assert.notInclude(readLog(), 'PATH-parser');
        }
        assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
        assert.isFalse(fs.existsSync(sentinel));
        assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
      });
    }
    for (const failure of ['empty', 'partial', 'helper', 'mktemp', 'none']) {
      it('preserves the copied command status, stdin and cleanup in ' + shell + ' after ' + failure, () => {
        if (failure === 'mktemp') {
          fs.unlinkSync(path.join(tools, 'mktemp'));
          fs.writeFileSync(path.join(tools, 'mktemp'), '#!/bin/bash\nexit 73\n', { mode: 0o755 });
        }
        const result = runCopiedCommand(shell, 'device-code\n', {
          FAKE_QUICK_DOWNLOAD: ['empty', 'partial'].includes(failure) ? failure : 'success',
          FAKE_QUICKSTART_EXIT: failure === 'helper' ? '7' : '0',
        });
        const expected = ['empty', 'partial'].includes(failure) ? 22 : failure === 'helper' ? 7 : failure === 'mktemp' ? 73 : 0;
        assert.equal(result.status, expected, result.stdout + result.stderr);
        const executed = ['helper', 'none'].includes(failure);
        assert.equal(fs.existsSync(path.join(root, 'entrypoint-ran')), executed);
        if (executed) {
          assert.include(result.stdout, 'Native fixture prompt:');
          assert.include(readLog(), 'downloaded-quickstart:stdin-preserved');
        } else assert.notInclude(readLog(), 'downloaded-quickstart:started');
        if (['empty', 'partial'].includes(failure)) assert.include(result.stderr, 'Fixture curl failure');
        assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
        assert.isEmpty(fs.readdirSync(home));
        for (const prohibited of ['auth status --active', 'install.sh:', 'ballin:']) assert.notInclude(readLog(), prohibited);
      });
    }
  }
  it('rejects invalid selected shells before preparing prerequisites or profiles', () => {
    const unavailable = path.join(root, 'unavailable/bash');
    const notExecutable = path.join(root, 'not-executable/bash');
    fs.mkdirSync(path.dirname(notExecutable));
    fs.writeFileSync(notExecutable, '#!/bin/bash\n', { mode: 0o644 });
    const directory = path.join(root, 'directory/bash');
    fs.mkdirSync(directory, { recursive: true });
    const unsupported = path.join(root, 'fish');
    fs.writeFileSync(unsupported, '#!/bin/bash\n', { mode: 0o755 });
    for (const selectedShell of ['bash', '', unavailable, notExecutable, directory, unsupported]) {
      const result = run('', { SHELL: selectedShell });
      assert.equal(result.status, 1, selectedShell + result.stdout + result.stderr);
      assert.match(result.stderr, /selected shell must be an absolute path|supports the standard zsh or Bash/);
      assert.isEmpty(fs.readdirSync(home));
      for (const prohibited of ['node:', 'git:', 'gh:', 'xcode-select:', 'sudo:', 'install.sh:', 'ballin:']) assert.notInclude(readLog(), prohibited);
    }
  });
  it('rejects unsupported platforms before changing home files', () => {
    for (const env of [{ FAKE_OS: 'Linux' }, { FAKE_MACOS: '13.4' }, { FAKE_ARCH: 'i386' }]) {
      assert.equal(run('', env).status, 1);
      assert.isFalse(fs.existsSync(path.join(home, '.local')));
    }
  });
});
