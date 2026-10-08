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
  const run = (input = 'y\ny\n', overrides: NodeJS.ProcessEnv = {}, cwd = home, beforeMain = '') => {
    const shell = overrides.SHELL ?? '/bin/zsh';
    const target = overrides.FAKE_PROFILE_TARGET ?? (shell.endsWith('bash') ? 'login' : overrides.ZDOTDIR ?? 'home');
    const selection = fs.existsSync(shell) && ['bash', 'zsh'].includes(path.basename(shell)) ? target + '\n' : '';
    const missingGit = overrides.FAKE_GIT === 'missing';
    const missingNode = overrides.FAKE_OLD_NODE === '1' && !fs.existsSync(path.join(systemNode, 'node'))
      && !fs.existsSync(path.join(home, '.local/share/ballin-quickstart/bin/node'));
    const missingGh = !(overrides.PATH ?? tools).split(':').some((entry) => fs.existsSync(path.resolve(cwd, entry || '.', 'gh'))) && !fs.existsSync(path.join(home, '.local/share/ballin-quickstart/bin/gh'));
    const answers = input.split('\n');
    const preceding = missingGit || missingNode || missingGh ? (missingGit ? 2 : 1) : 0;
    answers.splice(preceding, 0, ...selection.split('\n').slice(0, -1));
    return spawnSync('/bin/bash', ['-c', `
source "$FAKE_SOURCE"
system_node_bin="$FAKE_SYSTEM_NODE"
system_git="\${FAKE_SYSTEM_GIT:-$FAKE_ROOT/tools/git}"
system_xcode_select="\${FAKE_SYSTEM_XCODE_SELECT:-$FAKE_ROOT/tools/xcode-select}"
${beforeMain}
trap cleanup EXIT
main
`], {
    encoding: 'utf8', input: answers.join('\n'), cwd, timeout: 12000,
    env: testChildEnvironment({
      HOME: home, PATH: tools, TMPDIR: path.join(root, 'tmp'), SHELL: '/bin/zsh',
      FAKE_ROOT: root, FAKE_COMMAND_LOG: log, FAKE_SOURCE: source,
      FAKE_SYSTEM_NODE: systemNode, TEST_NODE_RUNTIME: process.execPath, ...overrides,
    }),
  });
  };

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
        cp "\${FAKE_CORE_INSTALL_SOURCE:-$FAKE_ROOT/fake-tool}" "$target" ;;
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
    if [[ "\${FAKE_CHECK_INSTALL_CWD:-0}" == 1 ]]; then
      (cd "$FAKE_ROOT"; node -p fixture >/dev/null; git --version >/dev/null; gh --version >/dev/null)
      printf 'fixture:changed-cwd-tools-ready\\n' >> "$FAKE_COMMAND_LOG"
    fi
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
    for (const unexpected of ['sudo:', 'xcode-select:--install', 'releases/latest', 'ballin:update', 'brew:']) assert.notInclude(readLog(), unexpected);
    assert.include(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), ":$PATH:'" + path.join(home, '.local/bin') + "'");
  });
  for (const name of ['node', 'git', 'gh']) {
    for (const spelling of ['relative-tools', '.', '']) {
      it('reuses ' + name + ' from a relative PATH entry ' + JSON.stringify(spelling) + ' across installer cwd changes', () => {
        const relativeBin = spelling === 'relative-tools' ? path.join(home, spelling) : home;
        fs.mkdirSync(relativeBin, { recursive: true });
        linkFake(name, relativeBin);
        fs.unlinkSync(path.join(tools, name));
        const result = run('y\ny\n', { PATH: spelling + ':' + tools, FAKE_CHECK_INSTALL_CWD: '1' });
        assert.equal(result.status, 0, result.stdout + result.stderr + readLog());
        assert.notInclude(result.stdout, 'Missing prerequisites:');
        for (const forbidden of ['sudo:', 'xcode-select:--install', 'releases/latest']) assert.notInclude(readLog(), forbidden);
        assert.include(readLog(), 'fixture:changed-cwd-tools-ready');
        assert.include(readLog(), 'ballin:backup open');
        if (name !== 'node') {
          const selected = fs.readlinkSync(path.join(home, '.local/share/ballin-quickstart/bin', name));
          assert.isTrue(path.isAbsolute(selected));
          assert.equal(fs.realpathSync(selected), fs.realpathSync(path.join(relativeBin, name)));
        } else {
          assert.isFalse(fs.existsSync(path.join(home, '.local/share/ballin-quickstart/bin/node')));
        }
      });
    }
  }
  it('refuses unrepresentable relative PATH normalization before setup', () => {
    const cwd = path.join(root, 'working:directory');
    fs.mkdirSync(cwd);
    fs.symlinkSync(tools, path.join(cwd, 'relative-tools'));
    const result = run('', { PATH: 'relative-tools' }, cwd);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.include(result.stderr, 'current directory without colons');
    assert.isFalse(fs.existsSync(path.join(home, '.local/share/ballin-quickstart')));
    assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
    for (const forbidden of ['git:--version', 'sudo:', 'xcode-select:--install', 'auth status --active', 'install.sh:']) assert.notInclude(readLog(), forbidden);
  });
  for (const hardLink of [false, true]) {
    it('protects Git stub aliases before prerequisite consent via ' + (hardLink ? 'hard link' : 'symlink'), () => {
      const directory = path.join(root, 'system-git');
      fs.mkdirSync(directory);
      const stub = path.join(directory, 'git');
      fs.copyFileSync(path.join(root, 'fake-tool'), stub);
      fs.chmodSync(stub, 0o755);
      fs.unlinkSync(path.join(tools, 'git'));
      if (hardLink) fs.linkSync(stub, path.join(tools, 'git'));
      else fs.symlinkSync(stub, path.join(tools, 'git'));
      const result = run('n\n', { FAKE_SYSTEM_GIT: stub, FAKE_GIT: 'missing' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, 'Install these prerequisites?');
      for (const forbidden of ['git:--version', 'xcode-select:--install', 'auth status --active', 'install.sh:']) assert.notInclude(readLog(), forbidden);
      assert.isFalse(fs.existsSync(path.join(home, '.local/share/ballin-quickstart')));
      assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
    });
  }
  it('reuses Git stub aliases after Command Line Tools are available', () => {
    const stub = path.join(root, 'system-git');
    fs.copyFileSync(path.join(root, 'fake-tool'), stub);
    fs.chmodSync(stub, 0o755);
    fs.unlinkSync(path.join(tools, 'git'));
    fs.symlinkSync(stub, path.join(tools, 'git'));
    const result = run('y\ny\n', { FAKE_SYSTEM_GIT: stub });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.notInclude(result.stdout, 'Missing prerequisites:');
    assert.include(readLog(), 'git:--version');
    assert.notInclude(readLog(), 'xcode-select:--install');
    assert.include(readLog(), 'ballin:backup open');
  });
  for (const scenario of ['ready', 'install', 'decline', 'failure']) {
    it(`ignores a PATH-shadowed xcode-select when system Command Line Tools are ${scenario}`, () => {
      const systemTools = path.join(root, 'system-tools');
      fs.mkdirSync(systemTools);
      linkFake('xcode-select', systemTools);
      fs.unlinkSync(path.join(tools, 'xcode-select'));
      fs.writeFileSync(path.join(tools, 'xcode-select'), '#!/bin/bash\nprintf "shadow-xcode:%s\\n" "$*" >> "$FAKE_COMMAND_LOG"\nexit 77\n', { mode: 0o755 });
      const result = run(scenario === 'decline' ? 'n\n' : scenario === 'ready' ? 'y\ny\n' : 'y\n\ny\ny\n', {
        FAKE_SYSTEM_XCODE_SELECT: path.join(systemTools, 'xcode-select'),
        FAKE_GIT: scenario === 'ready' ? 'ready' : 'missing',
        FAKE_XCODE_FAIL: scenario === 'failure' ? '1' : '0',
      });
      assert.equal(result.status, scenario === 'failure' ? 1 : 0, result.stdout + result.stderr);
      assert.notInclude(readLog(), 'shadow-xcode:');
      assert.include(readLog(), 'xcode-select:-p');
      if (scenario === 'ready' || scenario === 'decline') assert.notInclude(readLog(), 'xcode-select:--install');
      else assert.include(readLog(), 'xcode-select:--install');
      if (scenario === 'ready' || scenario === 'install') {
        assert.include(readLog(), 'git:--version');
        assert.include(readLog(), 'ballin:backup open');
      } else {
        for (const forbidden of ['git:--version', 'gh:auth status --active', 'install.sh:', 'ballin:']) assert.notInclude(readLog(), forbidden);
      }
      if (scenario === 'ready') assert.notInclude(result.stdout, 'Missing prerequisites:');
      else assert.include(result.stdout, 'Install these prerequisites?');
      if (scenario === 'failure') assert.include(result.stderr, 'Finish any pending installation, then run this quickstart again.');
      if (scenario === 'decline') assert.isFalse(fs.existsSync(path.join(home, '.local')));
    });
  }
  for (const executableBrew of [false, true]) {
    it(`ignores an exported Homebrew function with executable Homebrew ${executableBrew ? 'present' : 'absent'}`, () => {
      const brewTools = path.join(root, 'Homebrew tools');
      fs.mkdirSync(brewTools);
      if (executableBrew) linkFake('brew', brewTools);
      const executablePrefix = path.join(root, 'real-brew');
      const functionPrefix = path.join(root, 'function-brew');
      const result = spawnSync('/bin/bash', ['-c', [
        'brew() { printf "function-brew:%s\\n" "$*" >> "$FAKE_COMMAND_LOG"; printf "%s\\n" "$FAKE_FUNCTION_BREW_PREFIX"; }',
        'export -f brew',
        '/bin/bash -c \'source "$FAKE_SOURCE"; system_node_bin="$FAKE_SYSTEM_NODE"; system_git="$FAKE_ROOT/tools/git"; system_xcode_select="$FAKE_ROOT/tools/xcode-select"; trap cleanup EXIT; main\'',
      ].join('\n')], {
        encoding: 'utf8', input: 'home\ny\ny\n', cwd: home, timeout: 12000,
        env: testChildEnvironment({
          HOME: home, PATH: `${brewTools}:${tools}`, TMPDIR: path.join(root, 'tmp'), SHELL: '/bin/zsh',
          FAKE_ROOT: root, FAKE_COMMAND_LOG: log, FAKE_SOURCE: source, FAKE_SYSTEM_NODE: systemNode,
          TEST_NODE_RUNTIME: process.execPath, FAKE_BREW_PREFIX: executablePrefix, FAKE_FUNCTION_BREW_PREFIX: functionPrefix,
        }),
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.notInclude(readLog(), 'function-brew:');
      assert.equal(readLog().includes('brew:--prefix'), executableBrew);
      const profile = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
      assert.include(profile, ":$PATH:'" + (executableBrew ? path.join(executablePrefix, 'bin') : path.join(home, '.local/bin')) + "'");
      assert.notInclude(profile, functionPrefix);
      assert.include(readLog(), 'ballin:backup open');
      assert.notInclude(readLog(), 'sudo:');
    });
  }
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
  for (const suffix of ['/', '///', '/cellar/..', ' \t\r\n']) {
    it(`matches actual core setup for a noncanonical Homebrew prefix ending ${JSON.stringify(suffix)}`, () => {
      linkFake('brew');
      const prefix = path.join(root, 'homebrew');
      const result = run('y\ny\n', { FAKE_BREW_PREFIX: prefix + suffix });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const coreRepo = path.join(root, 'core-repo');
      fs.mkdirSync(path.join(coreRepo, 'config'), { recursive: true });
      fs.mkdirSync(path.join(coreRepo, 'bin'));
      fs.writeFileSync(path.join(coreRepo, 'config/.defaultConfig.json'), '{"backup":{}}\n');
      fs.writeFileSync(path.join(coreRepo, 'bin/ballin'), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
      const core = spawnSync('/bin/zsh', ['-f', '-c', 'source "$HOME/.zshrc"; exec "$TEST_NODE_RUNTIME" "$FAKE_SETUP_SOURCE" setup "$FAKE_CORE_REPO" https://example.test/docs "" refresh'], {
        encoding: 'utf8', cwd: home, timeout: 12000,
        env: testChildEnvironment({ HOME: home, PATH: tools, FAKE_ROOT: root, FAKE_COMMAND_LOG: log,
          TEST_NODE_RUNTIME: process.execPath, FAKE_BREW_PREFIX: prefix + suffix, FAKE_CORE_REPO: coreRepo,
          FAKE_SETUP_SOURCE: path.resolve(__dirname, '../commands/install_setup.ts') }),
      });
      assert.equal(core.status, 0, core.stdout + core.stderr);
      assert.isTrue(fs.lstatSync(path.join(prefix, 'bin/ballin')).isSymbolicLink());
      assert.include(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), ":$PATH:'" + path.join(prefix, 'bin') + "'");
    });
  }
  for (const spelling of ['trailing slash', 'dot component', 'parent component']) {
    for (const withBrew of [false, true]) {
      it(`matches actual core setup for HOME with ${spelling} and Homebrew ${withBrew ? 'failing' : 'absent'}`, () => {
        if (withBrew) linkFake('brew');
        fs.mkdirSync(path.join(home, 'child'));
        const selectedHome = home + (spelling === 'trailing slash' ? '/' : spelling === 'dot component' ? '/.' : '/child/..');
        const result = run('y\ny\n', { HOME: selectedHome, FAKE_BREW_FAIL: '1' });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const coreRepo = path.join(root, 'core-repo');
        fs.mkdirSync(path.join(coreRepo, 'config'), { recursive: true });
        fs.mkdirSync(path.join(coreRepo, 'bin'));
        fs.writeFileSync(path.join(coreRepo, 'config/.defaultConfig.json'), '{"backup":{}}\n');
        fs.writeFileSync(path.join(coreRepo, 'bin/ballin'), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
        const core = spawnSync('/bin/zsh', ['-f', '-c', 'source "$HOME/.zshrc"; exec "$TEST_NODE_RUNTIME" "$FAKE_SETUP_SOURCE" setup "$FAKE_CORE_REPO" https://example.test/docs "" refresh'], {
          encoding: 'utf8', cwd: home, timeout: 12000,
          env: testChildEnvironment({ HOME: selectedHome, PATH: tools, FAKE_ROOT: root, FAKE_COMMAND_LOG: log,
            TEST_NODE_RUNTIME: process.execPath, FAKE_BREW_FAIL: '1', FAKE_CORE_REPO: coreRepo,
            FAKE_SETUP_SOURCE: path.resolve(__dirname, '../commands/install_setup.ts') }),
        });
        assert.equal(core.status, 0, core.stdout + core.stderr);
        assert.isTrue(fs.lstatSync(path.join(home, '.local/bin/ballin')).isSymbolicLink());
        assert.include(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), ":$PATH:'" + path.join(home, '.local/bin') + "'");
      });
    }
  }
  for (const name of ['git', 'node', 'gh']) {
    it(`ignores an exported ${name} function while selecting prerequisites for the actual core installer`, () => {
      linkFake('node', systemNode);
      const inner = 'source "$FAKE_SOURCE"; system_node_bin="$FAKE_SYSTEM_NODE"; system_git="$FAKE_ROOT/tools/git"; system_xcode_select="$FAKE_ROOT/tools/xcode-select"; trap cleanup EXIT; main';
      const result = spawnSync('/bin/bash', ['-c', [
        `${name}() { printf "exported-${name}:called\\n" >> "$FAKE_COMMAND_LOG"; return 73; }`,
        `export -f ${name}`,
        '/bin/bash -c ' + "'" + inner.replace(/'/g, "'\\''") + "'",
        'status=$?',
        `declare -F ${name} >/dev/null && printf 'parent-function-preserved\\n' >> "$FAKE_COMMAND_LOG"`,
        'exit "$status"',
      ].join('\n')], {
        encoding: 'utf8', input: 'home\ny\nn\n', cwd: home, timeout: 12000,
        env: testChildEnvironment({ HOME: home, PATH: tools, TMPDIR: path.join(root, 'tmp'), SHELL: '/bin/zsh',
          FAKE_ROOT: root, FAKE_COMMAND_LOG: log, FAKE_SOURCE: source, FAKE_SYSTEM_NODE: systemNode,
          TEST_NODE_RUNTIME: process.execPath, FAKE_CORE_INSTALL_SOURCE: path.resolve(__dirname, '../install.sh') }),
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.notInclude(result.stdout, 'Missing prerequisites:');
      assert.include(result.stdout, 'Proceed with installation?');
      assert.include(result.stdout, 'Installation cancelled; no installation changes were made.');
      assert.notInclude(readLog(), `exported-${name}:called`);
      assert.include(readLog(), 'parent-function-preserved');
      assert.include(readLog(), 'git:--version');
      assert.notInclude(readLog(), 'git:clone');
      assert.notInclude(readLog(), 'ballin:');
    });
  }
  for (const existingProfile of [false, true]) {
    it(`stops before profile, auth, install or backup for an empty Homebrew prefix (existing profile: ${existingProfile})`, () => {
      linkFake('brew');
      const profile = path.join(home, '.zshrc');
      const contents = '# Existing settings\n';
      if (existingProfile) fs.writeFileSync(profile, contents, { mode: 0o640 });
      const result = run('y\ny\n', { FAKE_BREW_PREFIX: '' });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.include(result.stderr, 'Homebrew returned an empty installation prefix');
      assert.include(result.stderr, 'Inspect and fix `brew --prefix`, then rerun this quickstart');
      assert.notInclude(result.stdout, 'Add this PATH line?');
      assert.equal(fs.existsSync(profile), existingProfile);
      if (existingProfile) {
        assert.equal(fs.readFileSync(profile, 'utf8'), contents);
        assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
      }
      for (const forbidden of ['gh:auth status --active', 'gh:auth login', '/main/install.sh', 'install.sh:', 'ballin:']) {
        assert.notInclude(readLog(), forbidden);
      }
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
      const retry = run('y\ny\n', { FAKE_BREW_PREFIX: path.join(root, 'brew') });
      assert.equal(retry.status, 0, retry.stdout + retry.stderr);
      assert.include(fs.readFileSync(profile, 'utf8'), ":$PATH:'" + path.join(root, 'brew/bin') + "'");
      assert.include(readLog(), 'ballin:backup open');
    });
  }
  it('rejects a whitespace-only Homebrew prefix before changing a profile or authenticating', () => {
    linkFake('brew');
    const profile = path.join(home, '.zshrc');
    fs.writeFileSync(profile, '# Existing settings\n', { mode: 0o640 });
    const result = run('y\ny\n', { FAKE_BREW_PREFIX: ' \t\r\n' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.include(result.stderr, 'Homebrew returned an empty installation prefix');
    assert.equal(fs.readFileSync(profile, 'utf8'), '# Existing settings\n');
    assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
    assert.notInclude(readLog(), 'gh:auth status --active');
    assert.notInclude(readLog(), 'install.sh:');
  });
  for (const [name, kind] of [['git', 'broken'], ['node', 'broken'], ['node', 'outdated'], ['gh', 'broken'], ['gh', 'unsupported']]) {
    it(`uses a later working PATH ${name} past a ${kind} executable in the actual core installer`, () => {
      const early = path.join(root, 'invalid-first');
      const later = path.join(root, 'working-later');
      fs.mkdirSync(early);
      fs.mkdirSync(later);
      const invalid = kind === 'outdated' ? 'printf "false\\n"\n'
        : kind === 'unsupported' ? 'case "$*" in --version) printf "old gh\\n";; "auth status --help") printf "unsupported\\n";; *) exit 97;; esac\n'
          : 'exit 73\n';
      fs.writeFileSync(path.join(early, name), '#!/bin/bash\n' + invalid, { mode: 0o755 });
      linkFake(name, later);
      if (name === 'node') linkFake('npm', later);
      const result = run('y\nn\n', {
        PATH: `${early}:${later}:${tools}`, FAKE_SYSTEM_GIT: path.join(root, 'missing-system-git'),
        FAKE_CORE_INSTALL_SOURCE: path.resolve(__dirname, '../install.sh'),
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.notInclude(result.stdout, 'Missing prerequisites:');
      assert.include(result.stdout, 'Proceed with installation?');
      assert.include(result.stdout, 'Installation cancelled; no installation changes were made.');
      const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
      assert.equal(fs.readlinkSync(path.join(quickBin, name)), path.join(later, name));
      if (name === 'node') assert.equal(fs.readlinkSync(path.join(quickBin, 'npm')), path.join(later, 'npm'));
      for (const forbidden of ['sudo:', 'xcode-select:--install', '/releases/latest', 'git:clone', 'ballin:']) {
        assert.notInclude(readLog(), forbidden);
      }
    });
  }
  it('releases the later working PATH Node after an invalid earlier executable is removed', () => {
    const early = path.join(root, 'invalid-first');
    fs.mkdirSync(early);
    fs.writeFileSync(path.join(early, 'node'), '#!/bin/bash\nexit 73\n', { mode: 0o755 });
    const first = path.join(home, '.nvm/versions/node/v24.12.0/bin');
    const next = path.join(home, '.nvm/versions/node/v24.21.0/bin');
    for (const bin of [first, next]) {
      fs.mkdirSync(bin, { recursive: true });
      for (const name of ['node', 'npm']) linkFake(name, bin);
    }
    const core = { FAKE_CORE_INSTALL_SOURCE: path.resolve(__dirname, '../install.sh') };
    const installed = run('y\nn\n', { ...core, PATH: `${early}:${first}:${tools}` });
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    assert.include(installed.stdout, 'Proceed with installation?');
    const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
    assert.equal(fs.readlinkSync(path.join(quickBin, 'node')), path.join(first, 'node'));
    const before = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
    fs.unlinkSync(path.join(early, 'node'));
    const rerun = run('n\n', { ...core, PATH: `${quickBin}:${early}:${next}:${tools}` });
    assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
    assert.include(rerun.stdout, 'Proceed with installation?');
    for (const name of ['node', 'npm']) assert.isFalse(fs.existsSync(path.join(quickBin, name)));
    assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), before);
    const fresh = spawnSync('/bin/zsh', ['-f', '-c', 'source "$HOME/.zshrc"; command -v node; command -v npm'], {
      encoding: 'utf8', cwd: home,
      env: testChildEnvironment({ HOME: home, PATH: `${early}:${next}:${tools}` }),
    });
    assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
    assert.deepEqual(fresh.stdout.trim().split('\n'), [path.join(next, 'node'), path.join(next, 'npm')]);
    assert.notInclude(readLog(), 'sudo:');
  });
  for (const prefixResult of ['failure', 'empty']) {
    it(`keeps core Homebrew semantics when the first PATH brew returns ${prefixResult} before a working later brew`, () => {
      const early = path.join(root, 'first-brew');
      const later = path.join(root, 'later-brew');
      fs.mkdirSync(early);
      fs.mkdirSync(later);
      fs.writeFileSync(path.join(early, 'brew'), '#!/bin/bash\n'
        + 'printf "first-brew:%s\\n" "$*" >> "$FAKE_COMMAND_LOG"\n'
        + (prefixResult === 'failure' ? 'exit 42\n' : 'printf "\\n"\n'), { mode: 0o755 });
      linkFake('brew', later);
      const result = run('y\ny\n', { PATH: `${early}:${later}:${tools}`, FAKE_BREW_PREFIX: later });
      assert.equal(result.status, prefixResult === 'failure' ? 0 : 1, result.stdout + result.stderr);
      assert.notMatch(readLog(), /^brew:/m);
      if (prefixResult === 'empty') {
        assert.include(result.stderr, 'Homebrew returned an empty installation prefix');
        assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
        assert.notInclude(readLog(), 'gh:auth status --active');
        assert.notInclude(readLog(), 'install.sh:');
        return;
      }
      const coreRepo = path.join(root, 'core-repo');
      fs.mkdirSync(path.join(coreRepo, 'config'), { recursive: true });
      fs.mkdirSync(path.join(coreRepo, 'bin'));
      fs.writeFileSync(path.join(coreRepo, 'config/.defaultConfig.json'), '{"backup":{}}\n');
      fs.writeFileSync(path.join(coreRepo, 'bin/ballin'), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
      const core = spawnSync('/bin/zsh', ['-f', '-c', 'source "$HOME/.zshrc"; exec "$TEST_NODE_RUNTIME" "$FAKE_SETUP_SOURCE" setup "$FAKE_CORE_REPO" https://example.test/docs "" refresh'], {
        encoding: 'utf8', cwd: home, timeout: 12000,
        env: testChildEnvironment({ HOME: home, PATH: `${early}:${later}:${tools}`, FAKE_ROOT: root, FAKE_COMMAND_LOG: log,
          TEST_NODE_RUNTIME: process.execPath, FAKE_BREW_PREFIX: later, FAKE_CORE_REPO: coreRepo,
          FAKE_SETUP_SOURCE: path.resolve(__dirname, '../commands/install_setup.ts') }),
      });
      assert.equal(core.status, 0, core.stdout + core.stderr);
      assert.isTrue(fs.lstatSync(path.join(home, '.local/bin/ballin')).isSymbolicLink());
      assert.notMatch(readLog(), /^brew:/m);
    });
  }
  for (const kind of ['absolute', 'relative', 'multihop', 'newline hop', 'managed parent alias']) {
    it(`retains an executable Node alias through ${kind} links and permits independent same-binary manager takeover`, () => {
      linkFake('npm', systemNode);
      const first = run('y\ny\ny\n', { FAKE_OLD_NODE: '1' });
      assert.equal(first.status, 0, first.stdout + first.stderr);
      const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
      const aliasBin = path.join(home, 'bin');
      fs.mkdirSync(aliasBin);
      const alias = path.join(aliasBin, 'node');
      let target = path.join(quickBin, 'node');
      if (kind === 'relative') target = path.relative(aliasBin, target);
      if (kind === 'multihop' || kind === 'newline hop') {
        const hop = kind === 'newline hop' ? 'current-node\n' : 'current-node';
        fs.symlinkSync(path.relative(aliasBin, target), path.join(aliasBin, hop));
        target = './' + hop;
      }
      if (kind === 'managed parent alias') {
        const parentAlias = path.join(root, 'managed-parent');
        fs.symlinkSync(path.dirname(quickBin), parentAlias);
        target = path.join(parentAlias, 'bin/node');
      }
      fs.symlinkSync(target, alias);
      const profile = path.join(home, '.zshrc');
      const before = fs.readFileSync(profile, 'utf8');
      const rerun = run('', { PATH: `${aliasBin}:${quickBin}:${tools}`, FAKE_OLD_NODE: '1' });
      assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
      for (const name of ['node', 'npm']) {
        assert.isTrue(fs.existsSync(path.join(quickBin, name)), `${name} fallback must remain available`);
        assert.equal(fs.readlinkSync(path.join(quickBin, name)), path.join(systemNode, name));
      }
      assert.equal(fs.realpathSync(alias), fs.realpathSync(path.join(systemNode, 'node')));
      assert.equal(fs.readFileSync(profile, 'utf8'), before);
      assert.notInclude(rerun.stderr, 'Persistent PATH setup incomplete');
      const managerBin = path.join(home, '.nvm/current/bin');
      fs.mkdirSync(managerBin, { recursive: true });
      for (const name of ['node', 'npm']) fs.symlinkSync(path.join(systemNode, name), path.join(managerBin, name));
      assert.equal(fs.realpathSync(path.join(managerBin, 'node')), fs.realpathSync(alias));
      const takeover = run('', { PATH: `${aliasBin}:${quickBin}:${managerBin}:${tools}`, FAKE_OLD_NODE: '1' });
      assert.equal(takeover.status, 0, takeover.stdout + takeover.stderr);
      for (const name of ['node', 'npm']) {
        assert.isFalse(fs.existsSync(path.join(quickBin, name)));
        assert.isTrue(fs.existsSync(path.join(managerBin, name)));
      }
      const resolved = spawnSync('/bin/bash', ['-c', 'command -v node; command -v npm'], {
        encoding: 'utf8', cwd: home,
        env: testChildEnvironment({ HOME: home, PATH: `${aliasBin}:${quickBin}:${managerBin}:${tools}` }),
      });
      assert.equal(resolved.status, 0, resolved.stdout + resolved.stderr);
      assert.deepEqual(resolved.stdout.trim().split('\n'), [path.join(managerBin, 'node'), path.join(managerBin, 'npm')]);
      assert.equal(fs.readFileSync(profile, 'utf8'), before);
      assert.equal(readLog().split('sudo:').length - 1, 1);
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    });
  }
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
  for (const spelling of ['direct', 'directory alias', 'executable alias']) {
    it(`lets an independent Git replace the managed link through ${spelling}`, () => {
      assert.equal(run().status, 0);
      const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
      const managedGit = path.join(quickBin, 'git');
      let entry = quickBin;
      if (spelling === 'directory alias') {
        entry = path.join(root, 'git-directory-alias');
        fs.symlinkSync(quickBin, entry);
      } else if (spelling === 'executable alias') {
        entry = path.join(root, 'git-executable-alias');
        fs.mkdirSync(entry);
        fs.symlinkSync(path.relative(entry, managedGit), path.join(entry, 'git'));
      }
      const externalBin = path.join(root, 'external-git');
      fs.mkdirSync(externalBin);
      const externalGit = path.join(externalBin, 'git');
      fs.writeFileSync(externalGit, '#!/bin/bash\nprintf "external-git:%s\\n" "$*" >> "$FAKE_COMMAND_LOG"\n[[ "$*" == --version ]]\n', { mode: 0o755 });
      const before = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
      const result = run('', { PATH: `${entry}:${quickBin}:${externalBin}:${tools}` });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(fs.readlinkSync(managedGit), externalGit);
      assert.equal(fs.realpathSync(path.join(entry, 'git')), fs.realpathSync(externalGit));
      assert.include(readLog(), 'external-git:--version');
      assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), before);
      // Keep the working managed fallback when no independent Git remains on PATH.
      fs.unlinkSync(path.join(tools, 'git'));
      const fallback = run('', { PATH: `${entry}:${quickBin}:${tools}`, FAKE_SYSTEM_GIT: path.join(root, 'missing-system-git') });
      assert.equal(fallback.status, 0, fallback.stdout + fallback.stderr);
      assert.equal(fs.readlinkSync(managedGit), externalGit);
      assert.notInclude(fallback.stdout, 'Missing prerequisites:');
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
  for (const spelling of ['direct', 'directory alias', 'executable alias', 'newline alias']) {
    it(`lets an independent GitHub CLI replace a downloaded fallback through ${spelling}`, () => {
      fs.unlinkSync(path.join(tools, 'gh'));
      const first = run('y\ny\ny\n');
      assert.equal(first.status, 0, first.stdout + first.stderr);
      const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
      const managedGh = path.join(quickBin, 'gh');
      const archiveGh = fs.readlinkSync(managedGh);
      const before = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
      let entry = quickBin;
      if (spelling === 'directory alias') {
        entry = path.join(root, 'managed-alias');
        fs.symlinkSync(quickBin, entry);
      } else if (spelling === 'executable alias' || spelling === 'newline alias') {
        entry = path.join(root, 'executable-alias');
        fs.mkdirSync(entry);
        if (spelling === 'newline alias') {
          fs.symlinkSync(managedGh, path.join(entry, 'current-gh\n'));
          fs.symlinkSync('./current-gh\n', path.join(entry, 'gh'));
        } else fs.symlinkSync(path.relative(entry, managedGh), path.join(entry, 'gh'));
      }
      const fallback = run('', { PATH: `${entry}:${quickBin}:${tools}` });
      assert.equal(fallback.status, 0, fallback.stdout + fallback.stderr);
      assert.equal(fs.readlinkSync(managedGh), archiveGh);
      const managerBin = path.join(root, 'external-gh/bin');
      fs.mkdirSync(managerBin, { recursive: true });
      const externalGh = path.join(managerBin, 'gh');
      fs.writeFileSync(externalGh, fs.readFileSync(path.join(root, 'fake-tool'), 'utf8').replace(
        'name="${0##*/}"', 'name="${0##*/}"\nprintf "external-gh:%s\\n" "$*" >> "$FAKE_COMMAND_LOG"',
      ), { mode: 0o755 });
      const result = run('', { PATH: `${entry}:${quickBin}:${managerBin}:${tools}` });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(fs.readlinkSync(managedGh), externalGh);
      assert.equal(fs.realpathSync(path.join(entry, 'gh')), fs.realpathSync(externalGh));
      assert.include(readLog(), 'external-gh:auth status --active --hostname github.com');
      assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), before);
      assert.equal(readLog().split('/releases/latest -o').length - 1, 1);
      assert.isTrue(fs.existsSync(archiveGh));
      const fresh = spawnSync('/bin/zsh', ['-f', '-c', 'source "$HOME/.zshrc"; gh --version'], {
        encoding: 'utf8', cwd: home,
        env: testChildEnvironment({ HOME: home, PATH: `${managerBin}:${tools}`, FAKE_ROOT: root, FAKE_COMMAND_LOG: log }),
      });
      assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
      assert.include(readLog(), 'external-gh:--version');
      assert.include(readLog(), 'ballin:backup open');
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    });
  }
  for (const kind of ['broken', 'unsupported']) {
    it(`retains the downloaded GitHub CLI when the external candidate is ${kind}`, () => {
      fs.unlinkSync(path.join(tools, 'gh'));
      assert.equal(run('y\ny\ny\n').status, 0);
      const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
      const archiveGh = fs.readlinkSync(path.join(quickBin, 'gh'));
      const managerBin = path.join(root, 'external-gh/bin');
      fs.mkdirSync(managerBin, { recursive: true });
      fs.writeFileSync(path.join(managerBin, 'gh'), '#!/bin/bash\n'
        + 'printf "external-gh:%s\\n" "$*" >> "$FAKE_COMMAND_LOG"\n'
        + (kind === 'broken' ? 'exit 1\n' : 'case "$*" in --version) printf "fixture old gh\\n";; "auth status --help") printf "missing capability\\n";; *) exit 97;; esac\n'), { mode: 0o755 });
      const result = run('', { PATH: `${quickBin}:${managerBin}:${tools}` });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(readLog(), 'external-gh:--version');
      assert.notInclude(readLog(), 'external-gh:auth status --active');
      assert.equal(fs.readlinkSync(path.join(quickBin, 'gh')), archiveGh);
      assert.equal(readLog().split('/releases/latest -o').length - 1, 1);
      assert.include(readLog(), 'ballin:backup open');
    });
  }
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
      assert.notInclude(readLog(), 'brew:');
      assert.include(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), ":$PATH:'" + path.join(home, '.local/bin') + "'");
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
  it('rejects an incompatible Node package version before requesting admin access', () => {
    fs.writeFileSync(path.join(root, 'node-checksums.txt'), 'a'.repeat(64) + '  node-v24.11.0.pkg\n');
    const result = run('y\n', { FAKE_OLD_NODE: '1' });
    assert.equal(result.status, 1);
    assert.include(result.stderr, 'older than the required 24.12');
    assert.notInclude(readLog(), 'sudo:');
    assert.notInclude(readLog(), '/node-v24.11.0.pkg -o');
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
  for (const shell of ['bash', 'zsh']) {
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
  const pathLine = () => `export PATH='${path.join(home, '.local/share/ballin-quickstart/bin')}':$PATH:'${path.join(home, '.local/bin')}'`;
  for (const shell of ['bash', 'zsh']) {
    const profileName = shell === 'bash' ? '.bash_profile' : '.zshrc';
    it(`preserves hard-linked ${shell} startup aliases while continuing the first backup`, () => {
      const profile = path.join(home, profileName);
      const alias = path.join(home, 'dotfiles-startup');
      const contents = '# Shared startup settings\n';
      fs.writeFileSync(profile, contents, { mode: 0o640 });
      fs.linkSync(profile, alias);
      const before = fs.statSync(profile);
      const result = run('y\ny\n', { SHELL: '/bin/' + shell });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stderr, 'Persistent PATH setup incomplete');
      assert.notInclude(result.stdout, 'Add this PATH line?');
      for (const file of [profile, alias]) {
        const after = fs.statSync(file);
        assert.equal(after.ino, before.ino);
        assert.equal(after.nlink, 2);
        assert.equal(after.mode & 0o777, 0o640);
        assert.equal(fs.readFileSync(file, 'utf8'), contents);
      }
      assert.include(readLog(), 'ballin:backup\nballin:backup open\n');
      assert.notInclude(fs.readdirSync(home).join('\n'), '.ballin-quickstart.');
    });
    it(`appends to normal custom ${shell} profiles without executing or interpreting commands`, () => {
      const profile = path.join(home, profileName);
      const sentinel = path.join(root, 'profile-executed');
      // These remain true observations about runtime reachability. The new
      // contract installs literal text and deliberately makes no active claim.
      const forms = [
        "'return'", '"ret\\\nurn"', 'exec /bin/true', 'logout',
        'function custom() { return; }\nif false; then exit; fi',
        'case "$TERM" in dumb) return ;; esac',
        '(( value = (1 << 2) ))', 'exec {fd}>file', 'exec >foo{bar}',
        "cat <<'END'\nreturn\nEND", 'command -q return',
        ...(shell === 'bash'
          ? ['shopt -s extglob\nshopt -u extglob\ncase foo in +(foo)) :;; esac']
          : ['repeat "1" return', 'nocorrect noglob exec /bin/true', '{# comment\n:\n}']),
      ];
      for (const form of forms) {
        const contents = `touch '${sentinel}'\n${form}\n`;
        fs.writeFileSync(profile, contents, { mode: 0o640 });
        const result = run('y\ny\n', { SHELL: '/bin/' + shell });
        assert.equal(result.status, 0, form + result.stdout + result.stderr);
        assert.equal(fs.readFileSync(profile, 'utf8'), contents + '\n' + pathLine() + '\n');
        assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
        assert.include(result.stdout, `PATH line added to ${profile}; open a new Terminal.`);
        assert.include(result.stdout, 'also run this in your current Bash/zsh Terminal');
        assert.include(result.stdout, 'If ballin is unavailable in a new Terminal');
        assert.isFalse(fs.existsSync(sentinel));
        const retry = run('', { SHELL: '/bin/' + shell });
        assert.equal(retry.status, 0, retry.stdout + retry.stderr);
        assert.include(retry.stdout, 'already present');
        assert.include(retry.stdout, 'Its activation was not checked.');
        assert.notInclude(retry.stdout, 'Add this PATH line?');
        assert.equal(fs.readFileSync(profile, 'utf8'), contents + '\n' + pathLine() + '\n');
      }
      assert.include(readLog(), 'ballin:backup\nballin:backup open\n');
    });
    it(`reports literal presence in ${shell} even inside inactive or unfinished constructs`, () => {
      const profile = path.join(home, profileName);
      for (const contents of [
        `if false; then\n${pathLine()}\nfi\n`,
        `cat <<'END'\n${pathLine()}\nEND\n`,
        `cat <<'END'\n${pathLine()}\n`,
        `: \\\n${pathLine()}\n`,
        `return\n${pathLine()}`, `${pathLine()}\nif\n`,
      ]) {
        fs.writeFileSync(profile, contents);
        const result = run('y\n', { SHELL: '/bin/' + shell });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.include(result.stdout, 'already present');
        assert.include(result.stdout, 'Its activation was not checked.');
        assert.notInclude(result.stdout, 'Add this PATH line?');
        assert.equal(fs.readFileSync(profile, 'utf8'), contents);
      }
    });
    it(`preserves unsafe append boundaries in ${shell} and continues the first backup`, () => {
      const profile = path.join(home, profileName);
      const sentinel = path.join(root, 'profile-executed');
      for (const unfinished of ['if true; then\n', "VALUE='open\n", 'cat <<EOF\ntext\n', 'export VALUE=1 \\', 'export VALUE=1 \\\n']) {
        const contents = `touch '${sentinel}'\n${unfinished}`;
        fs.writeFileSync(profile, contents, { mode: 0o640 });
        const result = run('y\n', { SHELL: '/bin/' + shell });
        assert.equal(result.status, 0, unfinished + result.stdout + result.stderr);
        assert.include(result.stderr, 'Persistent PATH setup incomplete:');
        assert.notInclude(result.stderr, 'invalid shell');
        assert.include(result.stderr, 'rerun this quickstart to retry');
        assert.equal(fs.readFileSync(profile, 'utf8'), contents);
        assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
        assert.isFalse(fs.existsSync(sentinel));
        assert.notInclude(result.stdout, 'Add this PATH line?');
      }
      assert.include(readLog(), 'ballin:backup\nballin:backup open\n');
    });
    it(`separates the appended line from comments and missing final newlines in ${shell}`, () => {
      const profile = path.join(home, profileName);
      for (const contents of ['# No newline', '# Comment \\', '# Comment \\\n', ': <<EOF\ntext\nEOF\n']) {
        fs.writeFileSync(profile, contents, { mode: 0o640 });
        const result = run('y\ny\n', { SHELL: '/bin/' + shell });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(fs.readFileSync(profile, 'utf8'), contents + '\n' + pathLine() + '\n');
      }
    });
    it(`uses the selected ${shell} parser and suppresses zsh user startup loading`, () => {
      const selectedDirectory = path.join(root, 'selected-shell');
      fs.mkdirSync(selectedDirectory);
      const selected = path.join(selectedDirectory, shell);
      fs.writeFileSync(selected, '#!/bin/bash\nprintf "selected-parser:%s\\n" "$*" >> "$FAKE_COMMAND_LOG"\nexec /bin/' + shell + ' "$@"\n', { mode: 0o755 });
      const sentinel = path.join(root, 'zshenv-executed');
      fs.writeFileSync(path.join(home, '.zshenv'), `touch '${sentinel}'\n`);
      const result = run('y\ny\n', { SHELL: selected });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(readLog(), shell === 'bash' ? 'selected-parser:-n -O extglob ' : 'selected-parser:-n -f ');
      assert.isFalse(fs.existsSync(sentinel));
    });
  }
  it('keeps declines separate from prerequisite consent and permits an idempotent PATH retry', () => {
    fs.unlinkSync(path.join(tools, 'gh'));
    // No startup selection is reached when prerequisite installation is declined.
    const declined = run('n\n', { FAKE_PROFILE_TARGET: 'n' });
    assert.equal(declined.status, 0, declined.stdout + declined.stderr);
    assert.isFalse(fs.existsSync(path.join(home, '.local')));
    linkFake('gh');
    const profile = path.join(home, '.zshrc');
    fs.writeFileSync(profile, '# Existing settings\n', { mode: 0o640 });
    const first = run('n\ny\n');
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.include(first.stderr, 'PATH setup was declined');
    assert.equal(fs.readFileSync(profile, 'utf8'), '# Existing settings\n');
    assert.include(readLog(), 'ballin:backup open');
    const retry = run('y\n');
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.include(retry.stdout, 'PATH line added');
    const again = run('');
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(fs.readFileSync(profile, 'utf8').split(pathLine()).length, 2);
  });
  it('quotes apostrophes in managed paths while preserving startup bytes and modes', () => {
    home = path.join(root, "home with apostrophe'and spaces");
    fs.mkdirSync(home);
    const profile = path.join(home, '.zshrc');
    fs.writeFileSync(profile, '# User settings without final newline', { mode: 0o640 });
    const result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const contents = fs.readFileSync(profile, 'utf8');
    assert.isTrue(contents.startsWith('# User settings without final newline\n'));
    assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
    const fresh = spawnSync('/bin/zsh', ['-f', '-c', 'source "$HOME/.zshrc"; printf "%s" "$PATH"'], {
      encoding: 'utf8', cwd: home, env: testChildEnvironment({ HOME: home, PATH: tools }),
    });
    assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
    assert.equal(fresh.stdout, `${home}/.local/share/ballin-quickstart/bin:${tools}:${home}/.local/bin`);
  });
  it('uses the selected Bash rc or existing login target without hiding the login chain', () => {
    fs.writeFileSync(path.join(home, '.profile'), '# Login\n');
    const result = run('y\ny\n', { SHELL: '/bin/bash', FAKE_PROFILE_TARGET: 'bashrc' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.isTrue(fs.existsSync(path.join(home, '.bashrc')));
    assert.isFalse(fs.existsSync(path.join(home, '.bash_profile')));
    assert.equal(fs.readFileSync(path.join(home, '.profile'), 'utf8'), '# Login\n');
  });
  it('keeps empty ZDOTDIR distinct from unset and permits an explicit actual startup target', () => {
    const profile = path.join(home, '.zshrc');
    const skipped = run('y\n', { ZDOTDIR: '' });
    assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
    assert.include(skipped.stdout, 'an empty value does not mean home');
    assert.include(skipped.stderr, 'Persistent PATH setup incomplete');
    assert.isFalse(fs.existsSync(profile));
    const directory = path.join(home, 'actual-zsh');
    fs.mkdirSync(directory);
    const selected = run('y\n', { ZDOTDIR: '', FAKE_PROFILE_TARGET: directory });
    assert.equal(selected.status, 0, selected.stdout + selected.stderr);
    assert.isTrue(fs.existsSync(path.join(directory, '.zshrc')));
    assert.isFalse(fs.existsSync(profile));
  });
  for (const selectedShell of ['', 'bash', '/missing/bash', '/bin/sh']) {
    it(`continues first backup when persistent setup has unavailable shell ${JSON.stringify(selectedShell)}`, () => {
      const result = run('y\n', { SHELL: selectedShell });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stderr, 'Persistent PATH setup incomplete');
      assert.include(result.stdout, pathLine());
      assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
      assert.include(readLog(), 'ballin:backup open');
    });
  }
  for (const kind of ['symlink', 'dangling-symlink', 'directory', 'parent-symlink', 'missing-parent']) {
    it(`leaves ${kind} startup targets untouched while continuing setup`, () => {
      const profile = path.join(home, '.zshrc');
      const target = path.join(home, 'settings');
      let selection = 'home';
      if (kind === 'symlink' || kind === 'dangling-symlink') {
        if (kind === 'symlink') fs.writeFileSync(target, '# Settings\n');
        fs.symlinkSync(target, profile);
      } else if (kind === 'directory') fs.mkdirSync(profile);
      else if (kind === 'parent-symlink') { fs.symlinkSync(home, target); selection = target; }
      else selection = path.join(home, 'missing');
      const result = run('y\n', { FAKE_PROFILE_TARGET: selection });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stderr, 'Persistent PATH setup incomplete');
      assert.include(readLog(), 'ballin:backup open');
      if (kind === 'symlink') assert.equal(fs.readFileSync(target, 'utf8'), '# Settings\n');
      if (kind === 'dangling-symlink') assert.isTrue(fs.lstatSync(profile).isSymbolicLink());
    });
  }
  it('preserves a startup hard link added during PATH consent', () => {
    const profile = path.join(home, '.zshrc');
    const alias = path.join(home, 'dotfiles-startup');
    const contents = '# Original settings\n';
    fs.writeFileSync(profile, contents, { mode: 0o640 });
    const before = fs.statSync(profile);
    const result = run('y\ny\n', {}, home, `
original_confirm=$(declare -f confirm)
eval "\${original_confirm/confirm ()/original_confirm ()}"
confirm() {
  original_confirm "$@" || return
  if [[ "$1" == 'Add this PATH line?' ]]; then ln "$HOME/.zshrc" "$HOME/dotfiles-startup"; fi
}
`);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, 'Add this PATH line?');
    assert.include(result.stderr, 'The startup file changed during setup.');
    for (const file of [profile, alias]) {
      const after = fs.statSync(file);
      assert.equal(after.ino, before.ino);
      assert.equal(after.nlink, 2);
      assert.equal(after.mode & 0o777, 0o640);
      assert.equal(fs.readFileSync(file, 'utf8'), contents);
    }
    assert.include(readLog(), 'ballin:backup open');
  });
  for (const mutation of ['bytes', 'inode', 'mode', 'symlink', 'hard-link']) {
    it(`refuses a concurrent ${mutation} change after inspection`, () => {
      const profile = path.join(home, '.zshrc');
      const contents = '# Original settings\n';
      fs.writeFileSync(profile, contents, { mode: 0o640 });
      fs.unlinkSync(path.join(tools, 'cp'));
      const action = {
        bytes: 'printf "# Changed\\n" > "$2"',
        inode: '/bin/cp "$2" "$2.replacement"; /bin/mv "$2.replacement" "$2"',
        mode: '/bin/chmod 600 "$2"',
        symlink: '/bin/mv "$2" "$2.target"; /bin/ln -s "$2.target" "$2"',
        'hard-link': '/bin/ln "$2" "$2.alias"',
      }[mutation];
      fs.writeFileSync(path.join(tools, 'cp'), '#!/bin/bash\nif [[ "$1" == -p && "$2" == "$HOME/.zshrc" ]]; then ' + action + '; fi\nexec /bin/cp "$@"\n', { mode: 0o755 });
      const result = run('y\ny\n');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stderr, 'Persistent PATH setup incomplete');
      assert.notInclude(fs.readFileSync(profile, 'utf8'), 'export PATH=');
      assert.include(readLog(), 'ballin:backup open');
      assert.notInclude(fs.readdirSync(home).join('\n'), '.ballin-quickstart.');
      if (mutation === 'hard-link') {
        assert.equal(fs.statSync(profile).ino, fs.statSync(profile + '.alias').ino);
        assert.equal(fs.statSync(profile).nlink, 2);
        assert.equal(fs.readFileSync(profile + '.alias', 'utf8'), contents);
        assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
      }
    });
  }
  it('does not claim presence when the file changes after its literal-line inspection', () => {
    const profile = path.join(home, '.zshrc');
    fs.writeFileSync(profile, pathLine() + '\n');
    const result = run('y\n', { FAKE_CHANGE_PROFILE: '1' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stderr, 'startup file changed during setup');
    assert.notInclude(result.stdout, 'already present');
    assert.equal(fs.readFileSync(profile, 'utf8'), '# Changed while validating\n');
  });
  for (const flag of ['FAKE_INSTALL_FAIL', 'FAKE_BACKUP_FAIL']) {
    it(`preserves ${flag} failure status after PATH setup was declined`, () => {
      const result = run('n\ny\n', { [flag]: '1' });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.include(result.stderr, 'Persistent PATH setup incomplete');
      assert.notInclude(readLog(), 'ballin:backup open');
      assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
    });
  }
  it('rejects unsupported platforms before changing home files', () => {
    for (const env of [{ FAKE_OS: 'Linux' }, { FAKE_MACOS: '13.4' }, { FAKE_ARCH: 'i386' }]) {
      assert.equal(run('', env).status, 1);
      assert.isFalse(fs.existsSync(path.join(home, '.local')));
    }
  });
});

describe('quickstart with the real guarded onboarding sandbox', function() {
  this.timeout(120000);
  const { createSandbox, cleanupSandbox, runSandbox, sandboxEnvironment } = require('./helpers/onboarding.ts');
  it('keeps network, child-command, download, and mode restrictions in quickstart sandbox mode', () => {
    const sandbox = createSandbox({ quickstart: true });
    try {
      const env = sandboxEnvironment(sandbox);
      for (const script of ["fetch('https://example.invalid')", "require('child_process').spawnSync('/bin/sh', ['-c', 'true'])"]) {
        const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env, cwd: sandbox.home });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.include(result.stderr, 'sandbox safeguard refused');
      }
      const unknownDownload = spawnSync(path.join(sandbox.tools, 'curl'), ['https://example.invalid'], { env });
      assert.equal(unknownDownload.status, 97);
      const widenedPath = spawnSync(process.execPath, ['-e', ''], { env: { ...env, PATH: env.PATH + ':/usr/bin' } });
      assert.equal(widenedPath.status, 1);
      const marker = path.join(sandbox.root, '.ballin-onboarding-sandbox.json');
      const original = JSON.parse(fs.readFileSync(marker, 'utf8'));
      fs.writeFileSync(marker, JSON.stringify({ ...original, quickstart: false }));
      assert.throws(() => sandboxEnvironment(sandbox), /Sandbox mode was changed/u);
    } finally { cleanupSandbox(sandbox.root); }
  });
  it('hands its process PATH to the core installer, separately enables completion, captures and opens, and activates in a fresh shell', () => {
    const sandbox = createSandbox({ quickstart: true });
    try {
      const profile = path.join(sandbox.home, '.bash_profile');
      fs.writeFileSync(profile, '# Synthetic Bash login settings\n', { mode: 0o640 });
      const result = runSandbox(sandbox, ['quickstart'], 'login\ny\ny\nn\nlogin\ny\ny\ncreate\n\ny\ny\nn\n');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, `PATH line added to ${profile}; open a new Terminal.`);
      assert.include(result.stdout, 'Shell completion enabled.');
      assert.include(result.stdout, 'Ballin backup is optional.');
      assert.include(result.stdout, 'create');
      assert.isTrue(fs.lstatSync(path.join(sandbox.bin, 'ballin')).isSymbolicLink());
      const contents = fs.readFileSync(profile, 'utf8');
      assert.include(contents, "export PATH='");
      assert.include(contents, 'completions/ballin.bash');
      assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
      const state = JSON.parse(fs.readFileSync(path.join(sandbox.remote, 'repository.json'), 'utf8'));
      const publish = state.requests.findIndex((request: { payload?: { query?: string } }) => request.payload?.query?.includes('BallinPublish'));
      const opened = state.requests.findIndex((request: { endpoint?: string }) => request.endpoint === 'open');
      assert.isAtLeast(publish, 0);
      assert.isAbove(opened, publish);
      assert.isFalse(fs.existsSync(path.join(sandbox.repo, '.analytics/install-id')));
      const fresh = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c',
        'source "$HOME/.bash_profile"; command -v node git gh ballin; complete -p ballin; ballin --help'], {
        encoding: 'utf8', cwd: sandbox.home, timeout: 15000,
        env: { ...sandboxEnvironment(sandbox), PATH: sandbox.tools },
      });
      assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
      assert.include(fresh.stdout, sandbox.bin + '/ballin');
      assert.include(fresh.stdout, '.local/share/ballin-quickstart/bin/git');
      assert.include(fresh.stdout, '.local/share/ballin-quickstart/bin/gh');
      assert.include(fresh.stdout, 'complete -F _ballin_completion ballin');
      const retry = runSandbox(sandbox, ['quickstart'], 'login\n');
      assert.equal(retry.status, 0, retry.stdout + retry.stderr);
      assert.include(retry.stdout, 'PATH line already present');
      assert.equal(fs.readFileSync(profile, 'utf8'), contents);
      const managedGit = path.join(sandbox.home, '.local/share/ballin-quickstart/bin/git');
      fs.unlinkSync(managedGit);
      fs.symlinkSync(path.join(sandbox.tools, 'node'), managedGit);
      assert.throws(() => sandboxEnvironment(sandbox), /Quickstart tool was changed/u);
    } finally { cleanupSandbox(sandbox.root); }
  });
});
