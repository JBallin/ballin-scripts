const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { testChildEnvironment } = require('./helpers/environment.ts');

const terminalGuidanceMessage = '😎 Setup complete! Open a new Terminal and run `ballin help`.';
const terminalGuidance = `\n${terminalGuidanceMessage}\n`;

describe('beginner quickstart bootstrap', function() {
  this.timeout(15000);
  let root: string;
  let home: string;
  let tools: string;
  let systemNode: string;
  let log: string;
  const source = path.resolve(__dirname, '../quickstart.sh');
  const nodeInstallPrompt = 'Install Node.js and Ballin? [y/N]';
  const cltInstallQuestion = 'Install Xcode Command Line Tools and Ballin?';
  const firstBackupPrompt = '\nRun a backup now and open its GitHub destination? [Y/n] ';
  const incompletePathGuidance = '\nBallin is installed. PATH setup wasn’t verified. Manual setup: https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md#manual-path-setup\n';
  const readLog = (): string => fs.readFileSync(log, 'utf8');
  const brewInterruption = `if [[ "\${FAKE_BREW_INTERRUPT_AT:-}" == "$stage" ]]; then
  printf 'brew-interruption:%s:%s\\n' "$stage" "$FAKE_BREW_INTERRUPTION" >> "$FAKE_COMMAND_LOG"
  if [[ "$stage" == install ]]; then printf 'partial tool state\\n' > "$FAKE_ROOT/approved-brew-effect"; fi
  case "$FAKE_BREW_INTERRUPTION" in
    130|143) exit "$FAKE_BREW_INTERRUPTION" ;;
    INT|TERM) kill -"$FAKE_BREW_INTERRUPTION" $$ ;;
    *) exit 97 ;;
  esac
fi`;
  const nativeBrew = (arch = 'arm'): string => {
    const prefix = path.join(root, 'native-brew-' + arch);
    const repository = arch === 'intel' ? path.join(prefix, 'Homebrew') : prefix;
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(prefix, 'Cellar'));
    for (const directory of ['etc', 'include', 'lib', 'opt', 'sbin', 'share', 'var/homebrew/linked', 'var/homebrew/locks']) {
      fs.mkdirSync(path.join(prefix, directory), { recursive: true });
    }
    fs.mkdirSync(path.join(repository, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repository, 'Library/Homebrew'), { recursive: true });
    fs.writeFileSync(path.join(repository, 'Library/Homebrew/brew.sh'), '# fixture native launcher\n');
    fs.writeFileSync(path.join(prefix, 'bin/brew'), `#!/bin/bash
set -euo pipefail
printf 'native-brew:%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
stage=$1
if [[ "$stage" == ruby ]]; then
  if [[ "$2" == -rjson ]]; then stage=ruby-metadata; else stage=ruby-plan; fi
fi
${brewInterruption}
case "$1" in
  --prefix) printf '%s\\n' "$FAKE_NATIVE_PREFIX" ;;
  --cellar) printf '%s/Cellar\\n' "$FAKE_NATIVE_PREFIX" ;;
  info) printf '{"formulae":[]}\\n' ;;
  ruby)
    [[ "\${FAKE_BREW_PREFLIGHT_FAIL:-0}" != 1 ]] || exit 42
    [[ "$HOMEBREW_DEV_CMD_RUN" == 1 && "$HOMEBREW_NO_INSTALL_UPGRADE" == 1 && "$HOMEBREW_NO_INSTALL_CLEANUP" == 1 && "$HOMEBREW_NO_AUTO_UPDATE" == 1 ]] || exit 96
    [[ -z "\${HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK:-}" ]] || exit 96 ;;
  install)
    [[ "$2" == --formula ]] || exit 96
    shift 2
    for tool in "$@"; do
      [[ "$tool" == node || "$tool" == gh || "$tool" == git ]] || exit 96
      cp "$FAKE_ROOT/fake-tool" "$FAKE_NATIVE_PREFIX/bin/$tool"
    done ;;
  *) exit 97 ;;
esac
`, { mode: 0o755 });
    return prefix;
  };
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
  const run = (input = 'y\ny\n', overrides: NodeJS.ProcessEnv = {}, cwd = home, beforeMain = '', backupInput = 'y\n', afterMain = '') => {
    // Package-install fixtures start with Node genuinely missing.
    if (overrides.FAKE_MISSING_NODE === '1') {
      const first = path.join(tools, 'node');
      if (fs.existsSync(first) && fs.lstatSync(first).isSymbolicLink() && fs.readlinkSync(first) === path.join(root, 'fake-tool')) fs.unlinkSync(first);
    }
    const shell = overrides.SHELL ?? '/bin/zsh';
    const target = overrides.FAKE_PROFILE_TARGET ?? (shell.endsWith('bash') ? 'login' : overrides.ZDOTDIR ?? 'home');
    const selection = fs.existsSync(shell) && ['bash', 'zsh'].includes(path.basename(shell)) ? target + '\n' : '';
    const missingGit = overrides.FAKE_GIT === 'missing';
    const missingNode = overrides.FAKE_MISSING_NODE === '1' && !fs.existsSync(path.join(systemNode, 'node'))
      && !fs.existsSync(path.join(home, '.local/share/ballin-quickstart/bin/node'));
    const missingGh = !(overrides.PATH ?? tools).split(':').some((entry) => fs.existsSync(path.resolve(cwd, entry || '.', 'gh'))) && !fs.existsSync(path.join(home, '.local/share/ballin-quickstart/bin/gh'));
    const commandDirectory = overrides.FAKE_BREW_PREFIX ? path.join(overrides.FAKE_BREW_PREFIX, 'bin') : path.join(home, '.local/bin');
    const originalHasCommands = (overrides.PATH ?? tools).split(':').some(entry => {
      try { return fs.realpathSync(path.resolve(cwd, entry || '.')) === fs.realpathSync(commandDirectory); }
      catch { return path.resolve(cwd, entry || '.') === commandDirectory; }
    });
    const pathSufficient = originalHasCommands && !missingGit && !missingNode && !missingGh;
    const answers = input.split('\n');
    let alreadyManaged = false;
    try { alreadyManaged = fs.readFileSync(path.join(home, '.zshrc'), 'utf8').includes('export PATH='); } catch { /* Missing is normal. */ }
    if (pathSufficient && !alreadyManaged && answers.length > 1) answers.shift();
    const preceding = missingGit || missingNode || missingGh ? (missingGit ? 2 : 1) : 0;
    if (!pathSufficient) answers.splice(preceding, 0, ...selection.split('\n').slice(0, -1));
    const missingTools = missingGit || missingNode || missingGh;
    if (missingTools && !fs.existsSync(path.join(home, '.ballin-scripts'))) {
      // The core installer consumes the combined yes, leaving backup input next.
      const installationAnswer = preceding + (pathSufficient ? 0 : 2);
      if (answers.length > installationAnswer) answers.splice(installationAnswer, 1);
    }
    if (missingGit) answers.splice(1, 0, 'y');
    const early = overrides.FAKE_EARLY_ANSWER ?? 'y\n';
    const earlyYes = early.endsWith('\n') && !/^(?:n|no)\n/iu.test(early);
    let configured = false;
    try { configured = !!JSON.parse(fs.readFileSync(path.join(home, '.ballin-scripts/ballin.config.json'), 'utf8')).backup?.repository; } catch { /* Fresh installation. */ }
    if (earlyYes && !configured && overrides.FAKE_RAW_INPUT !== '1') {
      answers.splice(preceding + (missingGit ? 1 : 0), 0, overrides.FAKE_HOST_ANSWER ?? '');
    }

    return spawnSync('/bin/bash', ['-c', `
source "$FAKE_SOURCE"
system_node_bin="$FAKE_SYSTEM_NODE"
system_brew_arm="$FAKE_ROOT/native-brew-arm"
system_brew_intel="$FAKE_ROOT/native-brew-intel"
system_git="\${FAKE_SYSTEM_GIT:-$FAKE_ROOT/tools/git}"
system_xcode_select="\${FAKE_SYSTEM_XCODE_SELECT:-$FAKE_ROOT/tools/xcode-select}"
system_softwareupdate="$FAKE_ROOT/tools/softwareupdate"
system_pkgutil="\${FAKE_SYSTEM_PKGUTIL:-$FAKE_ROOT/tools/pkgutil}"
system_sudo="\${FAKE_SYSTEM_SUDO:-$FAKE_ROOT/tools/sudo}"
${beforeMain}
trap cleanup EXIT
main
${afterMain}
`], {
    encoding: 'utf8', input: (overrides.FAKE_EARLY_ANSWER ?? 'y\n') + (overrides.FAKE_RAW_INPUT === '1' ? input : answers.join('\n') + backupInput), cwd, timeout: 12000,
    env: testChildEnvironment({
      HOME: home, PATH: tools, TMPDIR: path.join(root, 'tmp'), SHELL: '/bin/zsh',
      FAKE_ROOT: root, FAKE_COMMAND_LOG: log, FAKE_SOURCE: source,
      FAKE_SYSTEM_NODE: systemNode, TEST_NODE_RUNTIME: process.execPath, ...overrides,
      FAKE_PRIVILEGED_HELPER: path.join(__dirname, 'helpers/quickstart_privileged.ts'),
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
  softwareupdate)
    [[ "$*" == --list ]] || exit 97
    case "\${FAKE_CLT_MODE:-fallback}:$1" in
      terminal:--list|failed:--list|unusable:--list|interrupt:--list)
        printf '  * Label: Command Line Tools for Xcode-16.4\\n' ;;
      ambiguous:--list)
        printf '  * Label: Command Line Tools for Xcode-16.3\\n  * Label: Command Line Tools for Xcode-16.4\\n' ;;
      *:--list) ;;
      *) exit 97 ;;
    esac ;;
  xcode-select)
    if [[ "$*" == -p ]]; then [[ "\${FAKE_GIT:-ready}" == ready || -f "$FAKE_ROOT/git-installed" ]]; exit; fi
    [[ "$*" == --install ]] || exit 97
    [[ "\${FAKE_XCODE_FAIL:-0}" != 1 ]] || exit 1
    touch "$FAKE_ROOT/git-installed" ;;
  node)
    if [[ -n "\${FAKE_ORIGINAL_PATH_RESULT:-}" && "$1" == -e && $# == 8 && "\${4:-}" == "$HOME/.local/bin" ]]; then
      printf 'original-path-probe:%s\\n' "$FAKE_ORIGINAL_PATH_RESULT" >> "$FAKE_COMMAND_LOG"
      case "$FAKE_ORIGINAL_PATH_RESULT" in
        130|143) exit "$FAKE_ORIGINAL_PATH_RESULT" ;;
        INT) kill -INT $$ ;;
        TERM) kill -TERM $$ ;;
        real)
          status=0
          "$TEST_NODE_RUNTIME" "$@" || status=$?
          printf 'original-path-result:%s\\n' "$status" >> "$FAKE_COMMAND_LOG"
          exit "$status" ;;
        *) exit 97 ;;
      esac
    fi
    if [[ "$1" == -p ]]; then
      if [[ "$0" == "$FAKE_ROOT/tools/node" && "\${FAKE_MISSING_NODE:-0}" == 1 ]]; then printf 'false\\n'; else printf 'true\\n'; fi
    elif [[ "\${FAKE_CHANGE_PROFILE:-0}" == 1 && "$1" == -e && "$3" == "$HOME/.zshrc" ]]; then
      "$TEST_NODE_RUNTIME" "$@"
      printf '# Changed while validating\\n' > "$3"
    else exec "$TEST_NODE_RUNTIME" "$@"; fi ;;
  npm)
    [[ "$*" == --version ]] || exit 97
    printf '11.0.0\\n' ;;
  gh)
    if [[ "\${FAKE_RECORD_GH_NOTIFIER:-0}" == 1 ]]; then
      printf 'gh-notifier:%s:%s\\n' "$*" "\${GH_NO_UPDATE_NOTIFIER-unset}" >> "$FAKE_COMMAND_LOG"
    fi
    # Synthetic notice mirrors gh 2.102.0 newline writers; no live authentication.
    fake_gh_notice() {
      if [[ "\${FAKE_GH_UPDATE_NOTICE:-0}" == 1 && -z "\${GH_NO_UPDATE_NOTIFIER:-}" ]]; then
        printf '\\n\\nA new release of gh is available: fixture-old → fixture-new\\nhttps://github.com/cli/cli/releases/tag/fixture-new\\n\\n' >&2
      fi
    }
    case "$*" in
      --version) printf 'gh version fixture\\n'; fake_gh_notice ;;
      'auth status --help') printf '%s\\n' '--active' ;;
      'auth status --active --hostname '*)
        if [[ -n "\${FAKE_TOKEN_SOURCE:-}" ]]; then
          [[ "\${!FAKE_TOKEN_SOURCE}" == fixture-invalid-token ]] || exit 97
          printf 'token-preserved:status:%s\\n' "$FAKE_TOKEN_SOURCE" >> "$FAKE_COMMAND_LOG"
          exit 1
        fi
        [[ "\${FAKE_AUTH:-ready}" == ready || -f "$FAKE_ROOT/login-complete" ]] ;;
      'auth login --hostname '*' --git-protocol https --web')
        if [[ -n "\${FAKE_TOKEN_SOURCE:-}" ]]; then
          [[ "\${!FAKE_TOKEN_SOURCE}" == fixture-invalid-token ]] || exit 97
          printf 'token-preserved:login:%s\\n' "$FAKE_TOKEN_SOURCE" >> "$FAKE_COMMAND_LOG"
          printf 'The %s environment variable controls authentication.\\nClear it from the environment before logging in.\\n' "$FAKE_TOKEN_SOURCE" >&2
          exit 1
        fi
        if [[ -n "\${FAKE_GH_LOGIN_FAILURE:-}" ]]; then
          printf 'Native login failure output\\n'
          printf 'Native login failure diagnostic\\n' >&2
          case "$FAKE_GH_LOGIN_FAILURE" in
            INT|TERM) kill -"$FAKE_GH_LOGIN_FAILURE" $$ ;;
            *) exit "$FAKE_GH_LOGIN_FAILURE" ;;
          esac
        fi
        printf 'Native login prompt: '; IFS= read -r answer
        [[ "$answer" == device-code ]] || exit 1
        printf '✓ Logged in as fixture-user\\n' >&2
        fake_gh_notice
        touch "$FAKE_ROOT/login-complete" ;;
      *) exit 97 ;;
    esac ;;
  curl)
    if [[ "\${FAKE_REQUIRE_CURL_Q:-0}" == 1 && "$1" != -q ]]; then exit 96; fi
    url=''; target=''
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -o) target="$2"; shift 2 ;;
        --proto|--proto-redir) shift 2 ;;
        -q|-fsSL|-fL|--progress-bar|--tlsv1.2) shift ;;
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
        if [[ -n "$target" && "$target" != - ]]; then cp "\${FAKE_QUICK_SOURCE:-$FAKE_ROOT/quickstart-entrypoint}" "$target"
        else cat "\${FAKE_QUICK_SOURCE:-$FAKE_ROOT/quickstart-entrypoint}"; fi
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
    if [[ "$1" == "$FAKE_ROOT/tools/softwareupdate" ]]; then
      [[ "$2" == --install && "$3" == 'Command Line Tools for Xcode-16.4' && $# == 3 ]] || exit 97
      case "\${FAKE_CLT_MODE:-}" in
        failed) exit 42 ;;
        interrupt) exit 130 ;;
        unusable) exit 0 ;;
      esac
      touch "$FAKE_ROOT/git-installed"
      exit 0
    fi
    exec "$TEST_NODE_RUNTIME" "$FAKE_PRIVILEGED_HELPER" "$@" ;;
  ditto)
    [[ "$1" == -x && "$2" == -k && "$3" == "$FAKE_ROOT"/tmp/ballin-quickstart.*/gh_2.102.0_macOS_*.zip && "$4" == "$FAKE_ROOT"/tmp/ballin-quickstart.*/gh-extract && $# == 4 ]] || exit 97
    folder="\${3##*/}"; folder="\${folder%.zip}"
    mkdir -p "$4/$folder/bin"
    cp "$FAKE_ROOT/fake-tool" "$4/$folder/bin/gh" ;;
  install.sh)
    printf "==> Installing Ballin\\n"
    [[ "\${FAKE_INSTALL_FAIL:-0}" != 1 ]] || exit 1
    if [[ "\${FAKE_CHECK_INSTALL_CWD:-0}" == 1 ]]; then
      (cd "$FAKE_ROOT"; node -p fixture >/dev/null; git --version >/dev/null; gh --version >/dev/null)
      printf 'fixture:changed-cwd-tools-ready\\n' >> "$FAKE_COMMAND_LOG"
    fi
    printf 'installer-host:%s\\n' "\${BALLIN_BACKUP_HOSTNAME:-}" >> "$FAKE_COMMAND_LOG"
    repo="$HOME/.ballin-scripts"
    if [[ ! -f "$repo/ballin.config.json" ]]; then
      answer=y
      if [[ "\${BALLIN_APPROVED_INSTALL_ROOT:-}" != "$repo" ]]; then printf 'Native installation prompt: '; IFS= read -r answer || answer=''; fi
      [[ "$answer" == y ]] || { printf 'cancelled\\n' > "$BALLIN_SETUP_RESULT_FILE"; exit 0; }
      mkdir -p "$repo/bin" "$repo/commands"
      if [[ "\${FAKE_SKIP_BACKUP:-0}" == 1 || "\${BALLIN_BACKUP_CHOICE:-}" == no ]]; then printf '{"backup":{}}\\n' > "$repo/ballin.config.json"
      else printf '{"backup":{"repository":{"id":"R_fixture","ownerId":"U_fixture","name":"ballin-backups","branch":"main"}}}\\n' > "$repo/ballin.config.json"; fi
    fi
    if grep -q '"repository":{' "$repo/ballin.config.json"; then printf 'complete configured open\\n' > "$BALLIN_SETUP_RESULT_FILE"
    else printf 'complete skipped open\\n' > "$BALLIN_SETUP_RESULT_FILE"; fi
    printf 'Installed fixture.\\n'
    cp "$FAKE_ROOT/fake-tool" "$repo/bin/ballin"
    printf '%s\\n' 'module.exports = { configuredBackupDestination: c => ({ kind: c.backup.repository ? "repository" : "unconfigured" }) };' > "$repo/commands/backup_config.ts" ;;
  ballin)
    case "$*" in
      'backup setup')
        printf 'Native backup setup prompt: '; IFS= read -r answer
        [[ "\${FAKE_SETUP_FAIL:-0}" != 1 ]] || exit 1
        [[ "$answer" == y ]] || { printf 'Backup setup skipped.\\n'; exit 0; }
        printf '{"backup":{"repository":{"id":"R_fixture","ownerId":"U_fixture","name":"ballin-backups","branch":"main"}}}\\n' > "$HOME/.ballin-scripts/ballin.config.json" ;;
      backup)
        [[ "\${FAKE_BACKUP_FAIL:-0}" != 1 ]] || exit 1
        if [[ "\${FAKE_CHECK_NPM_COLLECTOR:-0}" == 1 ]]; then npm list -g --depth=0 >/dev/null; fi
        if ! grep -q '"repository":{' "$HOME/.ballin-scripts/ballin.config.json"; then printf 'Backup is not configured\\n' >&2; exit 1; fi ;;
      'backup open') [[ "\${FAKE_OPEN_FAIL:-0}" != 1 ]] || exit 1 ;;
      *) exit 97 ;;
    esac ;;
  *) exit 97 ;;
esac
`, { mode: 0o755 });
    for (const name of ['uname', 'sw_vers', 'git', 'xcode-select', 'node', 'gh', 'curl', 'pkgutil', 'sudo', 'ditto', 'softwareupdate']) linkFake(name);
  });
  for (const declined of [false, true]) {
    it(`uses ordinary node through suitable existing Homebrew after consent (decline ${declined})`, () => {
      const prefix = nativeBrew();
      const result = run(declined ? 'no\n' : 'yes\nyes\ny\n', {
        FAKE_MISSING_NODE: '1', PATH: path.join(prefix, 'bin') + ':' + tools, FAKE_NATIVE_PREFIX: prefix,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, nodeInstallPrompt);
      assert.equal(readLog().includes('native-brew:install --formula node\n'), !declined);
      assert.notInclude(readLog(), 'node@24'); assert.notInclude(readLog(), 'nodejs.org');
      if (declined) { assert.notInclude(readLog(), 'native-brew:ruby'); assert.notInclude(readLog(), 'native-brew:info'); }
      else assert.include(readLog(), 'native-brew:info --json=v2 node');
    });
  }
  it('stops on Homebrew preflight failure without a direct fallback or installation', () => {
    const prefix = nativeBrew();
    const result = run('yes\n', { FAKE_MISSING_NODE: '1', PATH: path.join(prefix, 'bin') + ':' + tools,
      FAKE_NATIVE_PREFIX: prefix, FAKE_BREW_PREFLIGHT_FAIL: '1' });
    assert.equal(result.status, 1); assert.include(result.stderr, 'Homebrew cannot safely install');
    assert.notInclude(readLog(), 'native-brew:install'); assert.notInclude(readLog(), 'nodejs.org');
  });
  for (const stage of ['select-prefix', 'sysctl', '--prefix', '--cellar', 'info', 'ruby-metadata', 'ruby-plan', 'install']) {
    for (const outcome of ['130', '143', 'INT', 'TERM']) {
      it(`preserves Homebrew interruption ${outcome} at ${stage} without later setup`, () => {
        const checkedOperation = ['info', 'ruby-metadata', 'ruby-plan', 'install'].includes(stage);
        const prefix = stage === 'select-prefix' ? path.join(root, 'non-native-brew') : nativeBrew();
        if (stage === 'select-prefix') {
          fs.writeFileSync(path.join(tools, 'brew'), `#!/bin/bash
printf 'selected-brew:%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
stage=select-prefix
${brewInterruption}
printf '%s\\n' "$FAKE_NATIVE_PREFIX"
`, { mode: 0o755 });
        }
        fs.writeFileSync(path.join(tools, 'sysctl'), `#!/bin/bash
printf 'sysctl:%s\\n' "$*" >> "$FAKE_COMMAND_LOG"
stage=sysctl
${brewInterruption}
printf '0\\n'
`, { mode: 0o755 });
        const profile = path.join(home, '.zshrc');
        fs.writeFileSync(profile, '# existing settings\n', { mode: 0o640 });
        const before = fs.statSync(profile);
        const earlier = path.join(home, 'earlier-approved-change');
        fs.writeFileSync(earlier, 'keep this change\n');
        // Raw valid follow-on answers let swallowed cancellation reach later work.
        const input = (stage === 'select-prefix' ? '' : 'yes\n') + 'home\nyes\nyes\nyes\n';
        const result = run(input, {
          FAKE_RAW_INPUT: '1', FAKE_BREW_INTERRUPT_AT: stage, FAKE_BREW_INTERRUPTION: outcome,
          FAKE_NATIVE_PREFIX: prefix, FAKE_MISSING_NODE: stage === 'select-prefix' ? '0' : '1',
          PATH: stage === 'select-prefix' ? tools : path.join(prefix, 'bin') + ':' + tools,
        }, home, 'system_sysctl="$FAKE_ROOT/tools/sysctl"');
        const commands = readLog();
        const marker = `brew-interruption:${stage}:${outcome}\n`;
        assert.equal(result.status, outcome === '130' || outcome === 'INT' ? 130 : 143, result.stdout + result.stderr);
        assert.lengthOf(commands.split(marker), 2, 'the intended fault must run exactly once');
        assert.equal(commands.slice(commands.indexOf(marker) + marker.length), '', 'no later tool invocation');
        assert.equal(result.stdout.includes(nodeInstallPrompt), checkedOperation);
        if (stage !== 'select-prefix') assert.include(commands, 'sysctl:-in sysctl.proc_translated');
        if (stage !== 'sysctl' && stage !== 'select-prefix') assert.include(commands, 'native-brew:--prefix');
        if (checkedOperation || stage === '--cellar') assert.include(commands, 'native-brew:--cellar');
        if (checkedOperation) assert.include(commands, 'native-brew:info --json=v2 node');
        const rubyCalls = commands.match(/^native-brew:ruby /gm) ?? [];
        assert.lengthOf(rubyCalls, ['ruby-plan', 'install'].includes(stage) ? 2 : stage === 'ruby-metadata' ? 1 : 0);
        assert.equal(commands.includes('native-brew:install --formula node'), stage === 'install');
        for (const later of ['Zsh settings directory', 'Add Ballin setup', 'Native login prompt', 'Native installation prompt', 'Run a backup now', 'Setup complete!']) {
          assert.notInclude(result.stdout, later);
        }
        for (const forbidden of ['nodejs.org', 'xcode-select:--install', 'auth status --active', 'auth login', '/main/install.sh', 'install.sh:', 'git:clone', 'ballin:', 'sudo:']) {
          assert.notInclude(commands, forbidden);
        }
        assert.equal(fs.readFileSync(profile, 'utf8'), '# existing settings\n');
        const after = fs.statSync(profile);
        for (const key of ['ino', 'mode', 'mtimeMs']) assert.equal(after[key], before[key], key);
        assert.equal(fs.readFileSync(earlier, 'utf8'), 'keep this change\n');
        assert.isFalse(fs.existsSync(path.join(home, '.ballin-scripts')));
        assert.isFalse(fs.existsSync(path.join(root, 'login-complete')));
        assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
        const managed = path.join(home, '.local/share/ballin-quickstart/.managed');
        assert.equal(fs.existsSync(managed), checkedOperation || stage === 'select-prefix');
        if (fs.existsSync(managed)) assert.equal(fs.readFileSync(managed, 'utf8'), '1\n');
        const partial = path.join(root, 'approved-brew-effect');
        assert.equal(fs.existsSync(partial), stage === 'install');
        if (stage === 'install') assert.equal(fs.readFileSync(partial, 'utf8'), 'partial tool state\n');
      });
    }
  }
  for (const blocked of ['', 'Homebrew', 'Homebrew/.git', 'Cellar', 'bin', 'lib', 'var/homebrew/linked']) {
    it(`checks existing Intel Homebrew managed locations with an unwritable parent (blocked: ${blocked || 'none'})`, () => {
      const prefix = nativeBrew('intel');
      const blockedPath = blocked ? path.join(prefix, blocked) : '';
      fs.chmodSync(prefix, 0o555);
      if (blockedPath) fs.chmodSync(blockedPath, 0o555);
      try {
        const result = run(blocked ? 'no\n' : 'yes\nyes\ny\n', {
          FAKE_ARCH: 'x86_64', FAKE_MISSING_NODE: '1', FAKE_NATIVE_PREFIX: prefix,
          PATH: path.join(prefix, 'bin') + ':' + tools,
        });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(readLog().includes('native-brew:install --formula node\n'), !blocked);
        if (!blocked) assert.isTrue(fs.existsSync(path.join(prefix, 'bin/node')));
        else assert.notInclude(readLog(), 'native-brew:ruby');
        assert.notInclude(readLog(), 'nodejs.org');
      } finally {
        if (blockedPath) fs.chmodSync(blockedPath, 0o755);
        fs.chmodSync(prefix, 0o755);
      }
    });
  }
  for (const state of ['compatible', 'incompatible', 'unknown', '130', '143']) {
    it(`classifies a hidden Homebrew Node as ${state} without installing or switching it`, () => {
      const prefix = nativeBrew();
      const installed = path.join(prefix, 'Cellar/node/25.0.0/bin/node');
      fs.mkdirSync(path.dirname(installed), { recursive: true });
      const contents = '#!/bin/bash\n' + (state === 'compatible' ? "printf 'true\\n'\n"
        : state === 'incompatible' ? "printf 'false\\n'\n" : state === 'unknown' ? 'exit 27\n' : `exit ${state}\n`);
      fs.writeFileSync(installed, contents, { mode: 0o755 });
      fs.symlinkSync('../Cellar/node/25.0.0/bin/node', path.join(prefix, 'bin/node'));
      const result = run('', { FAKE_MISSING_NODE: '1' });
      assert.equal(result.status, ['130', '143'].includes(state) ? Number(state) : 1, result.stdout + result.stderr);
      if (state === 'compatible') {
        assert.include(result.stderr, 'is not active on PATH.');
        assert.include(result.stderr, 'Activate it using its existing installation method');
        assert.notInclude(result.stderr, 'brew upgrade node');
      } else if (state === 'incompatible') assert.include(result.stderr, 'Homebrew (review `brew upgrade node` yourself)');
      else if (state === 'unknown') {
        assert.include(result.stderr, 'could not be verified.');
        assert.notInclude(result.stderr, 'brew upgrade node');
      }
      assert.equal(fs.readFileSync(installed, 'utf8'), contents);
      assert.equal(fs.readlinkSync(path.join(prefix, 'bin/node')), '../Cellar/node/25.0.0/bin/node');
      for (const forbidden of ['native-brew:install', 'native-brew:info', 'native-brew:ruby', 'nodejs.org', 'auth status --active', 'install.sh:', 'sudo:']) assert.notInclude(readLog(), forbidden);
      assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
    });
  }
  it('never skips an incompatible first Node to silently select a later runtime', () => {
    const later = path.join(root, 'later'); fs.mkdirSync(later); linkFake('node', later);
    fs.unlinkSync(path.join(tools, 'node'));
    fs.writeFileSync(path.join(tools, 'node'), "#!/bin/bash\nprintf 'false\\n'\n", { mode: 0o755 });
    const result = run('', { PATH: tools + ':' + later });
    assert.equal(result.status, 1); assert.include(result.stderr, 'Existing Node.js at ' + path.join(tools, 'node'));
    assert.include(result.stderr, 'Update or select Node using its existing installation method');
    assert.notInclude(result.stderr, 'brew upgrade node');
    for (const forbidden of ['nodejs.org', 'auth status --active', 'install.sh:', 'native-brew:install']) assert.notInclude(readLog(), forbidden);
  });
  for (const kind of ['relative', 'absolute', 'broken', 'cyclic']) {
    it(`gives safe existing-Node guidance for a ${kind} Homebrew link`, () => {
      const prefix = nativeBrew();
      const node = path.join(prefix, 'bin/node');
      const installed = path.join(prefix, 'Cellar/node/22.0.0/bin/node');
      fs.mkdirSync(path.dirname(installed), { recursive: true });
      const contents = "#!/bin/bash\nprintf 'false\\n'\n";
      if (kind !== 'broken') fs.writeFileSync(installed, contents, { mode: 0o755 });
      const target = kind === 'absolute' ? installed : kind === 'cyclic' ? '../bin/node' : '../Cellar/node/22.0.0/bin/node';
      fs.symlinkSync(target, node);
      const result = run('', { PATH: path.join(prefix, 'bin') + ':' + tools, FAKE_NATIVE_PREFIX: prefix, FAKE_MISSING_NODE: '1' });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      if (kind === 'relative' || kind === 'absolute') {
        assert.include(result.stderr, `Existing Node.js at ${node} needs manual attention.`);
        assert.include(result.stderr, 'Homebrew (review `brew upgrade node` yourself)');
      }
      else {
        assert.include(result.stderr, `Existing Node.js at ${node} could not be verified.`);
        assert.include(result.stderr, 'using its existing installation method');
        assert.notInclude(result.stderr, 'brew upgrade node');
      }
      assert.equal(fs.readlinkSync(node), target);
      if (kind !== 'broken') assert.equal(fs.readFileSync(installed, 'utf8'), contents);
      for (const forbidden of ['native-brew:install', 'native-brew:info', 'native-brew:ruby', 'nodejs.org', 'auth status --active', 'install.sh:', 'sudo:']) assert.notInclude(readLog(), forbidden);
    });
  }
  it('retains existing nvm ownership guidance without switching Node', () => {
    const node = path.join(home, '.nvm/versions/node/v22.0.0/bin/node');
    fs.mkdirSync(path.dirname(node), { recursive: true });
    fs.writeFileSync(node, "#!/bin/bash\nprintf 'false\\n'\n", { mode: 0o755 });
    const result = run('', { PATH: path.dirname(node) + ':' + tools });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.include(result.stderr, 'nvm (select a supported version in your shell)');
    for (const forbidden of ['nodejs.org', 'auth status --active', 'install.sh:', 'sudo:']) assert.notInclude(readLog(), forbidden);
  });
  for (const fnmRoot of ['.local/share/fnm', '.fnm', 'Library/Application Support/fnm']) {
    for (const installed of [false, true]) {
      it(`requires actual Node evidence in inactive fnm root ${fnmRoot} (installed ${installed})`, () => {
        const directory = path.join(home, fnmRoot, 'node-versions/v24.22.0/installation/bin');
        fs.mkdirSync(directory, { recursive: true });
        const node = path.join(directory, 'node');
        if (installed) fs.writeFileSync(node, '#!/bin/sh\nexit 97\n', { mode: 0o755 });
        const result = run('no\n', { FAKE_MISSING_NODE: '1', FNM_DIR: undefined });
        assert.equal(result.status, installed ? 1 : 0, result.stdout + result.stderr);
        if (installed) {
          assert.include(result.stderr, `Existing Node.js at ${node} could not be verified.`);
          assert.include(result.stderr, 'Check it using its existing installation method and make a supported Node.js available on PATH');
          assert.notInclude(result.stderr, 'Update or select Node');
          assert.equal(fs.readFileSync(node, 'utf8'), '#!/bin/sh\nexit 97\n');
          assert.notInclude(result.stdout, 'Install Node.js and Ballin?');
        } else assert.include(result.stdout, nodeInstallPrompt);
        for (const forbidden of ['nodejs.org', 'auth status --active', 'install.sh:', 'sudo:']) assert.notInclude(readLog(), forbidden);
      });
    }
  }
  for (const answer of ['', 'y', 'yes']) {
    it(`requires a completed prerequisite consent before installing on EOF ${JSON.stringify(answer)}`, () => {
      fs.unlinkSync(path.join(tools, 'gh'));
      const result = run(answer, { FAKE_RAW_INPUT: '1' }, home, '', '');
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.include(result.stderr, 'No answer received. Quickstart stopped before installing prerequisites.');
      assert.notInclude(readLog(), 'curl:'); assert.isFalse(fs.existsSync(path.join(home, '.local/share/ballin-quickstart')));
    });
  }
  it('ends early-backup EOF normally before prerequisites or installation', () => {
    const result = run('', { FAKE_EARLY_ANSWER: '' }, home, '', '');
    assert.equal(result.status, 0); assert.include(result.stdout, 'Quickstart stopped.');
    assert.notInclude(readLog(), 'node:'); assert.notInclude(result.stdout, 'Setup complete!');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const mode of ['launcher', 'normal', 'progress']) {
    it(`disables curl configuration as the first argument for ${mode} downloads`, () => {
      const result = mode === 'launcher' ? runCopiedCommand('bash', 'device-code\n', { FAKE_REQUIRE_CURL_Q: '1' })
        : run(mode === 'progress' ? 'y\ny\ny\n' : 'y\ny\n', { FAKE_REQUIRE_CURL_Q: '1', FAKE_MISSING_NODE: mode === 'progress' ? '1' : '0' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      for (const line of readLog().split('\n').filter((line) => line.startsWith('curl:'))) assert.match(line, /^curl:-q /u);
    });
  }
  it('rejects a Node package swapped before privileged staging', () => {
    const result = run('y\ny\ny\n', { FAKE_MISSING_NODE: '1', FAKE_SWAP_NODE: 'before-stage' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.isFalse(fs.existsSync(path.join(root, 'installed.pkg')));
    for (const forbidden of ['auth status --active', 'install.sh:', 'ballin:']) assert.notInclude(readLog(), forbidden);
    assert.include(result.stderr, 'staged Node.js package checksum');
    assert.isEmpty(fs.readdirSync(path.join(root, 'privileged-parent')));
  });
  for (const swap of ['after-stage', 'after-signature', 'manifest-before-stage', 'manifest-after-stage', 'manifest-only']) {
    it(`keeps the captured digest and staged Node package through ${swap}`, () => {
      const original = fs.readFileSync(path.join(root, 'node.pkg'));
      const result = run('y\ny\ny\n', { FAKE_MISSING_NODE: '1', FAKE_SWAP_NODE: swap });
      const rejects = swap === 'manifest-before-stage';
      assert.equal(result.status, rejects ? 1 : 0, result.stdout + result.stderr);
      assert.equal(fs.readFileSync(path.join(root, 'captured-digest'), 'utf8'), crypto.createHash('sha256').update(original).digest('hex'));
      if (rejects) {
        assert.isFalse(fs.existsSync(path.join(root, 'installed.pkg')));
        assert.notInclude(readLog(), 'privileged-pkgutil:');
        assert.include(result.stderr, 'staged Node.js package checksum');
      } else {
        assert.deepEqual(fs.readFileSync(path.join(root, 'installed.pkg')), original);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'stage-metadata.json'), 'utf8')), { mode: 0o600, nlink: 1, parentMode: 0o700 });
        const ordered = ['pkgutil:--check-signature', 'sudo:/usr/bin/env', 'privileged-mktemp:', 'privileged-cat:',
          'privileged-shasum:', 'privileged-pkgutil:', 'privileged-grep:', 'privileged-installer:', 'privileged-rm:'];
        for (let index = 1; index < ordered.length; index++) assert.isAbove(readLog().indexOf(ordered[index]), readLog().indexOf(ordered[index - 1]));
        assert.include(readLog(), 'ballin:backup open');
      }
      assert.isEmpty(fs.readdirSync(path.join(root, 'privileged-parent')));
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    });
  }
  for (const [failure, status, next] of [
    ['FAKE_STAGE_FAIL', 71, 'cat'], ['FAKE_COPY_FAIL', 72, 'shasum'], ['FAKE_STAGED_HASH_FAIL', 73, 'pkgutil'],
    ['FAKE_STAGED_SIGNATURE_FAIL', 1, 'grep'], ['FAKE_STAGED_BAD_PUBLISHER', 1, 'installer'],
    ['FAKE_STAGED_GREP_FAIL', 1, 'installer'], ['FAKE_STAGED_INSTALL_FAIL', 64, ''],
    ['FAKE_CANCEL_SUDO', 130, 'mktemp'], ['FAKE_STAGE_CANCEL', 143, 'shasum'],
  ] as const) {
    it(`fails closed and cleans Node staging after ${failure}`, () => {
      const result = run('y\ny\ny\n', { FAKE_MISSING_NODE: '1', [failure]: '1' });
      assert.equal(result.status, status, result.stdout + result.stderr);
      if (next) assert.notInclude(readLog(), `privileged-${next}:`);
      for (const forbidden of ['auth status --active', 'install.sh:', 'ballin:']) assert.notInclude(readLog(), forbidden);
      assert.isFalse(fs.existsSync(path.join(root, 'installed.pkg')));
      if (failure !== 'FAKE_CANCEL_SUDO') assert.isEmpty(fs.readdirSync(path.join(root, 'privileged-parent')));
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    });
  }
  for (const installerFails of [false, true]) {
    it(`preserves Node operation status on cleanup failure with installer failure ${installerFails}`, () => {
      const result = run('y\ny\ny\n', { FAKE_MISSING_NODE: '1', FAKE_STAGE_CLEANUP_FAIL: '1', FAKE_STAGED_INSTALL_FAIL: installerFails ? '1' : '0' });
      assert.equal(result.status, installerFails ? 64 : 1, result.stdout + result.stderr);
      assert.include(readLog(), 'privileged-rm:');
      for (const forbidden of ['auth status --active', 'install.sh:', 'ballin:']) assert.notInclude(readLog(), forbidden);
    });
  }
  it('clears inherited shell startup and runtime settings at the privileged Node boundary', () => {
    const startup = path.join(root, 'injected-startup');
    fs.writeFileSync(startup, 'printf "injected-startup\\n" >> "$FAKE_COMMAND_LOG"\nexit 77\n');
    const result = run('y\ny\ny\n', { FAKE_MISSING_NODE: '1' }, home, `
fixture_sudo() (
  export BASH_ENV="$FAKE_ROOT/injected-startup" ENV="$FAKE_ROOT/injected-startup" PERL5OPT=-MDoesNotExist
  "$TEST_NODE_RUNTIME" "$FAKE_PRIVILEGED_HELPER" "$@"
)
system_sudo=fixture_sudo
`);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.notInclude(readLog(), 'injected-startup');
    assert.isTrue(fs.existsSync(path.join(root, 'installed.pkg')));
  });
  for (const kind of ['copy', 'hard link', 'other checkout']) {
    it(`rejects an earlier ballin ${kind} before PATH persistence without executing it`, () => {
      const intended = path.join(home, '.ballin-scripts/bin/ballin');
      const conflict = path.join(tools, 'ballin');
      fs.mkdirSync(path.dirname(intended), { recursive: true });
      fs.writeFileSync(intended, '#!/bin/bash\nprintf "conflict-ran\\n" >> "$FAKE_COMMAND_LOG"\n', { mode: 0o755 });
      if (kind === 'hard link') fs.linkSync(intended, conflict);
      else if (kind === 'copy') fs.copyFileSync(intended, conflict);
      else {
        const other = path.join(root, 'other-checkout/bin/ballin');
        fs.mkdirSync(path.dirname(other), { recursive: true });
        fs.copyFileSync(intended, other);
        fs.symlinkSync(other, conflict);
      }
      const before = fs.readFileSync(conflict);
      const result = run();
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.include(result.stderr, `Another ballin command would take precedence: ${conflict}.`);
      assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
      assert.deepEqual(fs.readFileSync(conflict), before);
      for (const forbidden of ['conflict-ran', 'auth status --active', 'install.sh:', 'ballin:']) assert.notInclude(readLog(), forbidden);
    });
  }
  for (const kind of ['absolute symlink', 'relative symlink chain', 'checkout directory alias', 'PATH directory alias']) {
    it(`accepts the intended ballin pathname through an earlier ${kind}`, () => {
      const bin = path.join(home, '.ballin-scripts/bin');
      const intended = path.join(bin, 'ballin');
      fs.mkdirSync(bin, { recursive: true });
      fs.copyFileSync(path.join(root, 'fake-tool'), intended);
      let entry = tools;
      if (kind === 'checkout directory alias') {
        entry = path.join(root, 'checkout-bin');
        fs.symlinkSync(bin, entry);
      } else {
        if (kind === 'relative symlink chain') {
          fs.symlinkSync('../home/.ballin-scripts/bin/ballin', path.join(tools, 'ballin-chain'));
          fs.symlinkSync('./ballin-chain', path.join(tools, 'ballin'));
        } else fs.symlinkSync(intended, path.join(tools, 'ballin'));
        if (kind === 'PATH directory alias') {
          entry = path.join(root, 'tools-alias');
          fs.symlinkSync(tools, entry);
        }
      }
      const result = run('y\ny\n', { PATH: `${entry}:${tools}` });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(readLog(), 'ballin:backup open');
      assert.isFalse(readLog().split('gh:auth status --active')[0].includes('ballin:'));
      assert.equal(fs.realpathSync(path.join(entry, 'ballin')), fs.realpathSync(intended));
    });
  }
  for (const kind of ['file', 'hard link', 'wrong symlink', 'directory alias', 'missing entry']) {
    it(`allows the replaceable ballin destination ${kind} ahead of a later conflict`, () => {
      const commandBin = path.join(home, '.local/bin');
      fs.mkdirSync(commandBin, { recursive: true });
      const conflict = path.join(tools, 'ballin');
      fs.writeFileSync(conflict, '#!/bin/bash\nprintf "conflict-ran\\n" >> "$FAKE_COMMAND_LOG"\n', { mode: 0o755 });
      const destination = path.join(commandBin, 'ballin');
      let entry = commandBin;
      if (kind === 'hard link') fs.linkSync(conflict, destination);
      else if (kind === 'wrong symlink') fs.symlinkSync(conflict, destination);
      else if (kind !== 'missing entry') fs.copyFileSync(conflict, destination);
      if (kind === 'directory alias') {
        entry = path.join(root, 'command-bin-alias');
        fs.symlinkSync(commandBin, entry);
      }
      const result = run('y\ny\n', { PATH: `${entry}:${tools}` });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.notInclude(readLog(), 'conflict-ran');
      const core = spawnSync(process.execPath, [path.resolve(__dirname, '../commands/install_setup.ts'), 'symlink-binaries', path.join(home, '.ballin-scripts'), commandBin], {
        encoding: 'utf8', env: testChildEnvironment({ HOME: home, PATH: tools }),
      });
      assert.equal(core.status, 0, core.stdout + core.stderr);
      const fresh = spawnSync('/bin/zsh', ['-f', '-c', 'source "$HOME/.zshrc"; command -v ballin; ballin backup'], {
        encoding: 'utf8', env: testChildEnvironment({ HOME: home, PATH: `${entry}:${tools}`, FAKE_ROOT: root, FAKE_COMMAND_LOG: log }),
      });
      assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
      assert.equal(fresh.stdout.trim(), path.join(entry, 'ballin'));
      assert.equal(fs.realpathSync(destination), fs.realpathSync(path.join(home, '.ballin-scripts/bin/ballin')));
      assert.notInclude(readLog(), 'conflict-ran');
    });
  }
  for (const kind of ['non-executable', 'directory', 'dangling link', 'non-directory PATH entry']) {
    it(`ignores a ballin ${kind} that cannot win command lookup`, () => {
      let entry = tools;
      const candidate = path.join(tools, 'ballin');
      if (kind === 'non-executable') fs.writeFileSync(candidate, 'not executable\n', { mode: 0o644 });
      else if (kind === 'directory') fs.mkdirSync(candidate);
      else if (kind === 'dangling link') fs.symlinkSync(path.join(root, 'absent'), candidate);
      else { entry = path.join(root, 'file'); fs.writeFileSync(entry, 'not a directory\n'); }
      const result = run('y\ny\n', { PATH: `${entry}:${tools}` });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(readLog(), 'ballin:backup open');
    });
  }
  it('checks ballin after Homebrew reconciliation without changing Node or npm priority', () => {
    const commandBin = path.join(home, '.local/bin');
    const brewPrefix = path.join(root, 'brew-prefix');
    fs.mkdirSync(commandBin, { recursive: true });
    fs.mkdirSync(path.join(brewPrefix, 'bin'), { recursive: true });
    linkFake('brew', commandBin);
    linkFake('npm');
    for (const name of ['node', 'npm', 'ballin']) fs.writeFileSync(path.join(commandBin, name),
      '#!/bin/bash\nprintf "conflict-ran\\n" >> "$FAKE_COMMAND_LOG"\nexit 77\n', { mode: 0o755 });
    const result = run('y\ny\n', { FAKE_BREW_PREFIX: brewPrefix });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.include(result.stderr, `Another ballin command would take precedence: ${path.join(commandBin, 'ballin')}.`);
    assert.notInclude(readLog(), 'conflict-ran');
    assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
    assert.notInclude(readLog(), 'auth status --active');
    fs.unlinkSync(path.join(commandBin, 'ballin'));
    const retry = run('y\ny\n', { FAKE_BREW_PREFIX: brewPrefix });
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    const core = spawnSync(process.execPath, [path.resolve(__dirname, '../commands/install_setup.ts'), 'symlink-binaries', path.join(home, '.ballin-scripts'), path.join(brewPrefix, 'bin')], {
      encoding: 'utf8', env: testChildEnvironment({ HOME: home, PATH: tools }),
    });
    assert.equal(core.status, 0, core.stdout + core.stderr);
    const fresh = spawnSync('/bin/zsh', ['-f', '-c', 'source "$HOME/.zshrc"; command -v node npm ballin; ballin backup'], {
      encoding: 'utf8', env: testChildEnvironment({ HOME: home, PATH: tools, FAKE_ROOT: root, FAKE_COMMAND_LOG: log }),
    });
    assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
    assert.deepEqual(fresh.stdout.trim().split('\n'), [path.join(tools, 'node'), path.join(tools, 'npm'), path.join(brewPrefix, 'bin/ballin')]);
    assert.notInclude(readLog(), 'conflict-ran');
  });

  for (const signal of ['INT', 'TERM']) {
    for (const tool of ['node', 'git', 'gh', 'gh-help', 'gh-help-consumer', 'npm']) {
      it(`stops on child SIG${signal} from ${tool} qualification without offering installation or continuing setup`, () => {
        const executable = path.join(tools, tool === 'gh-help' ? 'gh' : tool === 'gh-help-consumer' ? 'grep' : tool);
        fs.rmSync(executable, { force: true });
        fs.writeFileSync(executable, `#!/bin/bash\n${tool === 'gh-help' ? 'if [[ "$*" == --version ]]; then exit 0; fi\n' : ''}kill -${signal} $$\n`, { mode: 0o755 });
        const result = run('yes\nyes\n');
        assert.equal(result.status, signal === 'INT' ? 130 : 143, result.stdout + result.stderr);
        assert.notInclude(result.stdout, 'Install ');
        assert.notInclude(result.stderr, 'needs manual attention');
        assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
        for (const forbidden of ['auth status --active', 'auth login', 'install.sh:', 'ballin:', 'sudo:']) assert.notInclude(readLog(), forbidden);
      });
    }
  }
  for (const outcome of ['130', '143', 'INT', 'TERM']) {
    for (const existingProfile of [false, true]) {
      it(`stops at the late original-PATH probe on ${outcome} (existing profile: ${existingProfile})`, () => {
        const localBin = path.join(home, '.local/bin');
        fs.mkdirSync(localBin, { recursive: true });
        const profile = path.join(home, '.zshrc');
        const contents = '# Preserve existing settings\n';
        if (existingProfile) fs.writeFileSync(profile, contents, { mode: 0o640 });
        const before = existingProfile ? fs.statSync(profile) : null;
        // The helper anticipates sufficient PATH and rewrites answers. Supply raw
        // fallback answers so a swallowed interruption really continues setup.
        const result = run('\nhome\ny\ndevice-code\ny\ny\n', {
          PATH: `${tools}:${localBin}`, FAKE_RAW_INPUT: '1', FAKE_AUTH: 'missing',
          FAKE_ORIGINAL_PATH_RESULT: outcome,
        });
        const commands = readLog();
        assert.match(commands, /^node:-p .*process\.versions\.node/m);
        assert.include(commands, 'git:--version');
        assert.include(commands, 'gh:--version');
        assert.lengthOf(commands.match(/^original-path-probe:/gm) ?? [], 1);
        assert.include(commands, `original-path-probe:${outcome}\n`);
        assert.equal(result.status, outcome === '130' || outcome === 'INT' ? 130 : 143, result.stdout + result.stderr);
        for (const prompt of ['Zsh settings directory', 'Add Ballin setup', 'Native login prompt', 'Native installation prompt', 'Run a backup now', 'Setup complete!']) {
          assert.notInclude(result.stdout, prompt);
        }
        assert.equal(fs.existsSync(profile), existingProfile);
        if (before) {
          assert.equal(fs.readFileSync(profile, 'utf8'), contents);
          const after = fs.statSync(profile);
          for (const key of ['ino', 'mode', 'mtimeMs']) assert.equal(after[key], before[key], key);
        }
        for (const forbidden of ['gh:auth status --active', 'gh:auth login', '/main/install.sh', 'install.sh:', 'ballin:', 'sudo:']) {
          assert.notInclude(commands, forbidden);
        }
        assert.isFalse(fs.existsSync(path.join(root, 'login-complete')));
        assert.isFalse(fs.existsSync(path.join(home, '.ballin-scripts')));
        assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
        assert.equal(fs.readFileSync(path.join(home, '.local/share/ballin-quickstart/.managed'), 'utf8'), '1\n');
      });
    }
  }
  for (const sufficient of [false, true]) {
    it(`preserves real ${Number(!sufficient)} from the late original-PATH probe`, () => {
      const localBin = path.join(home, '.local/bin');
      fs.mkdirSync(localBin, { recursive: true });
      const result = run(sufficient ? '\ny\ny\n' : '\nhome\ny\ny\ny\n', {
        PATH: sufficient ? `${tools}:${localBin}` : tools,
        FAKE_RAW_INPUT: '1', FAKE_ORIGINAL_PATH_RESULT: 'real',
      });
      const commands = readLog();
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(commands, `original-path-result:${Number(!sufficient)}\n`);
      assert.equal(result.stdout.includes('Zsh settings directory'), !sufficient);
      assert.equal(result.stdout.includes('Add Ballin setup'), !sufficient);
      const profile = path.join(home, '.zshrc');
      assert.equal(fs.existsSync(profile), !sufficient);
      if (!sufficient) assert.include(fs.readFileSync(profile, 'utf8'), localBin);
      assert.include(commands, 'gh:auth status --active');
      assert.include(commands, 'install.sh:');
      assert.include(commands, 'ballin:backup open');
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    });
  }
  it('reuses working tools, preserves native stdin, and opens only after capture', () => {
    assert.isFalse(fs.existsSync(path.join(tools, 'npm')));
    const result = run();
    assert.equal(result.status, 0, result.stdout + result.stderr + readLog());
    assert.include(result.stdout, 'Native installation prompt:');
    assert.notInclude(readLog(), 'sudo:');
    assert.include(readLog(), 'ballin:backup\nballin:backup open\n');
    for (const unexpected of ['sudo:', 'xcode-select:--install', 'releases/latest', 'ballin:update', 'brew:']) assert.notInclude(readLog(), unexpected);
    assert.include(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), "PATH=$PATH:'" + path.join(home, '.local/bin') + "'");
  });
  for (const name of ['node', 'npm', 'git', 'gh']) {
    for (const kind of ['executable', 'file', 'directory']) {
      it(`rejects managed ${name} ${kind} in slot preflight before tool probes`, () => {
        assert.equal(run().status, 0);
        const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
        const target = path.join(quickBin, name);
        fs.rmSync(target, { force: true });
        if (kind === 'directory') fs.mkdirSync(target);
        const content = kind === 'directory' ? path.join(target, 'keep') : target;
        const bytes = '#!/bin/bash\nprintf "executed\\n" > "$FAKE_ROOT/conflict-ran"\nexit 1\n';
        fs.writeFileSync(content, bytes, { mode: kind === 'executable' ? 0o755 : 0o640 });
        const before = fs.lstatSync(target);
        const profile = fs.readFileSync(path.join(home, '.zshrc'));
        if (name !== 'npm') fs.unlinkSync(path.join(tools, name));
        fs.writeFileSync(log, '');

        const result = run();

        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.include(result.stderr, `Refusing to replace an existing file at ${target}.`);
        assert.isFalse(fs.existsSync(path.join(root, 'conflict-ran')));
        assert.equal(fs.lstatSync(target).ino, before.ino);
        assert.equal(fs.lstatSync(target).mode, before.mode);
        assert.equal(fs.readFileSync(content, 'utf8'), bytes);
        assert.deepEqual(fs.readFileSync(path.join(home, '.zshrc')), profile);
        for (const forbidden of ['node:', 'npm:', 'git:', 'gh:', 'curl:', 'sudo:', 'install.sh:', 'ballin:']) {
          assert.notInclude(readLog(), forbidden);
        }
      });
    }
    it(`allows a dangling managed ${name} symlink through slot preflight on rerun`, () => {
      assert.equal(run().status, 0);
      const target = path.join(home, '.local/share/ballin-quickstart/bin', name);
      fs.rmSync(target, { force: true });
      const missing = path.join(root, 'missing-' + name);
      fs.symlinkSync(missing, target);
      fs.writeFileSync(log, '');

      const result = run();

      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.isFalse(fs.existsSync(missing));
      assert.notInclude(result.stderr, 'Refusing to replace');
      assert.include(readLog(), 'ballin:backup open');
    });
  }
  for (const name of ['node', 'git', 'gh']) {
    for (const shadowed of [false, true]) {
      it(`qualifies sibling-relative ${name} wrappers at the final handoff (shadowed: ${shadowed})`, () => {
        const wrapperDir = path.join(root, 'wrapper tools');
        fs.mkdirSync(wrapperDir);
        const wrapper = path.join(wrapperDir, name);
        fs.writeFileSync(wrapper, '#!/bin/bash\nexec "${0%/*}/support/' + name + '" "$@"\n', { mode: 0o755 });
        fs.mkdirSync(path.join(wrapperDir, 'support'));
        linkFake(name, path.join(wrapperDir, 'support'));
        const original = fs.readFileSync(wrapper);
        const wrapperMode = fs.statSync(wrapper).mode;
        const early = path.join(root, 'early');
        fs.mkdirSync(early);
        if (shadowed) fs.writeFileSync(path.join(early, name), '#!/bin/bash\nexit 73\n', { mode: 0o755 });
        const result = run('y\ny\n', {
          PATH: `${early}:${wrapperDir}:${tools}`, FAKE_CHECK_INSTALL_CWD: '1',
          FAKE_SYSTEM_GIT: path.join(root, 'absent-system-git'),
        });
        assert.equal(result.status, shadowed ? 1 : 0, result.stdout + result.stderr);
        assert.deepEqual(fs.readFileSync(wrapper), original);
        if (shadowed) {
          assert.include(result.stderr, name === 'node' ? 'Existing Node.js at' : 'cannot run through the final PATH');
          assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
          for (const forbidden of ['auth status --active', 'install.sh:', 'ballin:', 'sudo:']) assert.notInclude(readLog(), forbidden);
        } else {
          assert.include(readLog(), 'fixture:changed-cwd-tools-ready');
          assert.include(readLog(), 'ballin:backup open');
          const fresh = spawnSync('/bin/zsh', ['-f', '-c', 'source "$HOME/.zshrc" && node -p fixture && git --version && gh --version'], {
            encoding: 'utf8', cwd: root,
            env: testChildEnvironment({ HOME: home, PATH: `${wrapperDir}:${tools}`, FAKE_ROOT: root,
              FAKE_COMMAND_LOG: log, TEST_NODE_RUNTIME: process.execPath }),
          });
          assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
        }
        const profile = path.join(home, '.zshrc');
        const beforeRetry = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : null;
        const retry = run(shadowed ? 'y\ny\n' : '', {
          PATH: `${wrapperDir}:${tools}`, FAKE_CHECK_INSTALL_CWD: '1',
          FAKE_SYSTEM_GIT: path.join(root, 'absent-system-git'),
        });
        assert.equal(retry.status, 0, retry.stdout + retry.stderr);
        assert.include(readLog(), 'ballin:backup open');
        if (beforeRetry !== null) assert.equal(fs.readFileSync(profile, 'utf8'), beforeRetry);
        assert.deepEqual(fs.readFileSync(wrapper), original);
        assert.equal(fs.statSync(wrapper).mode, wrapperMode);
      });
    }
  }
  for (const placement of ['original PATH', 'local bin', 'discovered Homebrew bin']) {
    for (const state of ['missing', 'non-executable', 'working', 'broken']) {
      it(`validates exposed npm ${state} in ${placement} while Node wins PATH`, () => {
        const localBin = path.join(home, '.local/bin');
        const brewPrefix = path.join(root, 'brew');
        const npmBin = placement === 'original PATH' ? tools : placement === 'local bin'
          ? localBin : path.join(brewPrefix, 'bin');
        fs.mkdirSync(npmBin, { recursive: true });
        if (placement === 'discovered Homebrew bin') {
          fs.mkdirSync(localBin, { recursive: true });
          linkFake('brew', localBin);
        }
        const npm = path.join(npmBin, 'npm');
        const bytes = '#!/bin/bash\n'
          + 'printf "exposed-npm:%s:node=%s\\n" "$*" "$(command -v node)" >> "$FAKE_COMMAND_LOG"\n'
          + '[[ "${FAKE_BROKEN_NPM:-0}" != 1 ]] || exit 73\n';
        if (state !== 'missing') fs.writeFileSync(npm, bytes, { mode: state === 'non-executable' ? 0o644 : 0o755 });
        const profile = path.join(home, '.zshrc');
        fs.writeFileSync(profile, '# Existing settings\n', { mode: 0o640 });
        const before = fs.statSync(profile);
        const overrides = { FAKE_BREW_PREFIX: brewPrefix, FAKE_BROKEN_NPM: state === 'broken' ? '1' : '0',
          FAKE_CHECK_NPM_COLLECTOR: ['missing', 'non-executable'].includes(state) ? '0' : '1' };

        const result = run('y\ny\n', overrides);

        assert.equal(result.status, state === 'broken' ? 1 : 0, result.stdout + result.stderr);
        if (state === 'broken') {
          assert.include(result.stderr, `npm cannot run through the final PATH: ${npm}.`);
          assert.equal(fs.readFileSync(profile, 'utf8'), '# Existing settings\n');
          assert.equal(fs.statSync(profile).ino, before.ino);
          assert.equal(fs.statSync(profile).mode, before.mode);
          for (const forbidden of ['auth status --active', 'install.sh:', 'ballin:']) assert.notInclude(readLog(), forbidden);
          fs.writeFileSync(log, '');
          const retry = run('y\ny\n', { ...overrides, FAKE_BROKEN_NPM: '0' });
          assert.equal(retry.status, 0, retry.stdout + retry.stderr);
        }
        assert.include(readLog(), 'ballin:backup open');
        const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
        for (const tool of ['node', 'npm']) assert.isFalse(fs.existsSync(path.join(quickBin, tool)));
        if (state === 'working' || state === 'broken') {
          assert.include(readLog(), `exposed-npm:--version:node=${path.join(tools, 'node')}`);
          assert.include(readLog(), `exposed-npm:list -g --depth=0:node=${path.join(tools, 'node')}`);
          assert.equal(fs.readFileSync(npm, 'utf8'), bytes);
          assert.isFalse(fs.lstatSync(npm).isSymbolicLink());
        } else assert.notInclude(readLog(), 'exposed-npm:');
        if (state === 'non-executable') {
          assert.equal(fs.readFileSync(npm, 'utf8'), bytes);
          assert.equal(fs.statSync(npm).mode & 0o777, 0o644);
        }
      });
    }
  }
  for (const placement of ['reachable', 'outside PATH', 'shadowed']) {
    it(`qualifies the paired npm wrapper when its original invocation is ${placement}`, () => {
      linkFake('node', systemNode);
      const npm = path.join(systemNode, 'npm');
      fs.mkdirSync(path.join(systemNode, 'support'));
      fs.writeFileSync(npm, '#!/bin/bash\nexec "${0%/*}/support/npm" "$@"\n', { mode: 0o755 });
      fs.writeFileSync(path.join(systemNode, 'support/npm'), '#!/bin/bash\n'
        + 'case "$*" in --version|"list -g --depth=0") ;; *) exit 97;; esac\n'
        + 'printf "paired-npm:%s:node=%s\\n" "$*" "$(command -v node)" >> "$FAKE_COMMAND_LOG"\n', { mode: 0o755 });
      const original = fs.readFileSync(npm);
      const originalMode = fs.statSync(npm).mode;
      const other = path.join(root, 'independent-npm');
      fs.mkdirSync(other);
      fs.writeFileSync(path.join(other, 'npm'), '#!/bin/bash\nif [[ "$*" == --version ]]; then exit 73; fi\nprintf "wrong-npm\\n" >> "$FAKE_COMMAND_LOG"\n', { mode: 0o755 });
      const profile = path.join(home, '.zshrc');
      fs.writeFileSync(profile, '# Existing profile\n', { mode: 0o640 });
      const before = fs.statSync(profile);
      const fixturePath = placement === 'outside PATH' ? tools
        : [tools, ...(placement === 'shadowed' ? [other] : []), systemNode].join(':');
      const result = run('y\ny\n', { PATH: fixturePath, FAKE_MISSING_NODE: '1', FAKE_CHECK_NPM_COLLECTOR: '1' });
      assert.equal(result.status, placement === 'reachable' ? 0 : 1, result.stdout + result.stderr);
      if (placement !== 'reachable') {
        assert.include(result.stderr, placement === 'outside PATH' ? 'Selected npm cannot run through the final PATH' : 'npm cannot run through the final PATH');
        assert.equal(fs.readFileSync(profile, 'utf8'), '# Existing profile\n');
        assert.equal(fs.statSync(profile).ino, before.ino);
        assert.equal(fs.statSync(profile).mode, before.mode);
        for (const forbidden of ['auth status --active', 'install.sh:', 'ballin:', 'wrong-npm']) assert.notInclude(readLog(), forbidden);
      }
      const retry = run(placement === 'reachable' ? '' : 'y\ny\n', {
        PATH: `${tools}:${systemNode}`, FAKE_MISSING_NODE: '1', FAKE_CHECK_NPM_COLLECTOR: '1',
      });
      assert.equal(retry.status, 0, retry.stdout + retry.stderr);
      const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
      assert.isFalse(fs.existsSync(path.join(quickBin, 'node')));
      assert.isFalse(fs.existsSync(path.join(quickBin, 'npm')));
      assert.include(readLog(), `paired-npm:list -g --depth=0:node=${path.join(systemNode, 'node')}`);
      assert.include(readLog(), 'ballin:backup open');
      assert.notInclude(readLog(), 'wrong-npm');
      assert.deepEqual(fs.readFileSync(npm), original);
      assert.equal(fs.statSync(npm).mode, originalMode);
      const fresh = spawnSync('/bin/zsh', ['-f', '-c', 'source "$HOME/.zshrc" && npm list -g --depth=0'], {
        encoding: 'utf8', cwd: root,
        env: testChildEnvironment({ HOME: home, PATH: `${tools}:${systemNode}`, FAKE_ROOT: root, FAKE_COMMAND_LOG: log }),
      });
      assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
    });
  }
  for (const prefix of ['', 'relative-prefix', '/invalid:prefix', '/invalid\nprefix']) {
    it(`rejects a newly exposed Homebrew prefix ${JSON.stringify(prefix)} before profile or auth`, () => {
      const localBin = path.join(home, '.local/bin');
      fs.mkdirSync(localBin, { recursive: true });
      linkFake('brew', localBin);
      const profile = path.join(home, '.zshrc');
      fs.writeFileSync(profile, '# Existing settings\n', { mode: 0o640 });
      const before = fs.statSync(profile);
      const result = run('', { FAKE_BREW_PREFIX: prefix });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.equal(fs.readFileSync(profile, 'utf8'), '# Existing settings\n');
      assert.equal(fs.statSync(profile).ino, before.ino);
      assert.equal(fs.statSync(profile).mode, before.mode);
      for (const forbidden of ['auth status --active', 'install.sh:', 'ballin:', 'sudo:']) assert.notInclude(readLog(), forbidden);
    });
  }
  for (const brewPlacement of ['initial PATH', 'newly exposed', 'absent']) {
    for (const declineFirst of [false, true]) {
      it(`keeps one PATH line across four fresh-shell reruns with Homebrew ${brewPlacement} (decline first: ${declineFirst})`, () => {
        const localBin = path.join(home, '.local/bin');
        const prefix = path.join(root, 'homebrew');
        fs.mkdirSync(localBin, { recursive: true });
        if (brewPlacement !== 'absent') linkFake('brew', brewPlacement === 'initial PATH' ? tools : localBin);
        const coreRepo = path.join(root, 'core-repo');
        fs.mkdirSync(path.join(coreRepo, 'config'), { recursive: true });
        fs.mkdirSync(path.join(coreRepo, 'bin'));
        fs.writeFileSync(path.join(coreRepo, 'config/.defaultConfig.json'), '{"backup":{}}\n');
        fs.writeFileSync(path.join(coreRepo, 'bin/ballin'), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
        const core = path.join(root, 'core-handoff');
        fs.writeFileSync(core, '#!/bin/bash\nexec "$TEST_NODE_RUNTIME" "$FAKE_SETUP_SOURCE" setup "$FAKE_CORE_REPO" https://example.test/docs "" refresh\n');
        const overrides = { FAKE_EARLY_ANSWER: 'no\n', FAKE_BREW_PREFIX: prefix, FAKE_CORE_INSTALL_SOURCE: core, FAKE_CORE_REPO: coreRepo,
          FAKE_SETUP_SOURCE: path.resolve(__dirname, '../commands/install_setup.ts') };
        const profile = path.join(home, '.zshrc');
        fs.writeFileSync(profile, '# Existing settings\n', { mode: 0o640 });
        const before = fs.statSync(profile);
        const destination = path.join(brewPlacement === 'absent' ? localBin : path.join(prefix, 'bin'), 'ballin');
        let fixturePath = tools;
        let expectedProfile = '';
        let expectedFresh: string[] = [];
        for (let index = 0; index < 4 + Number(declineFirst); index++) {
          const declined = declineFirst && index === 0;
          const result = run(declined ? 'n\n' : 'y\n', { ...overrides, PATH: fixturePath });
          assert.equal(result.status, 0, result.stdout + result.stderr);
          assert.equal(fs.realpathSync(destination), fs.realpathSync(path.join(coreRepo, 'bin/ballin')));
          fs.unlinkSync(path.join(coreRepo, 'ballin.config.json'));
          const contents = fs.readFileSync(profile, 'utf8');
          if (declined) {
            assert.equal(contents, '# Existing settings\n');
            assert.equal(fs.statSync(profile).ino, before.ino);
            assert.equal(fs.statSync(profile).mode, before.mode);
            assert.include(result.stdout, 'PATH setup skipped.');
          } else {
            assert.lengthOf(contents.split('\n').filter((line: string) => line.startsWith('export PATH=')), 1);
            if (expectedProfile) {
              assert.equal(contents, expectedProfile);
              assert.notInclude(result.stdout, 'PATH entry already present');
              assert.notInclude(result.stdout, 'Add this PATH line');
            } else {
              expectedProfile = contents;
              assert.notInclude(result.stdout, 'PATH line added');
            }
          }
          const fresh = spawnSync('/bin/zsh', ['-f', '-c',
            'source "$HOME/.zshrc"; printf "%s\\n" "$PATH"; for tool in node git gh brew ballin; do command -v "$tool" || true; done'], {
            encoding: 'utf8', cwd: home,
            env: testChildEnvironment({ HOME: home, PATH: tools, FAKE_ROOT: root, FAKE_COMMAND_LOG: log, ...overrides }),
          });
          assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
          const freshState = fresh.stdout.trim().split('\n');
          fixturePath = freshState[0];
          if (!declined) {
            if (expectedFresh.length) assert.deepEqual(freshState, expectedFresh);
            else expectedFresh = freshState;
            assert.equal(freshState.at(-1), destination);
          }
        }
        for (const forbidden of ['sudo:', 'xcode-select:--install', 'ballin:backup', 'gh:auth', 'gh:api']) assert.notInclude(readLog(), forbidden);
      });
    }
  }
  it('keeps newly exposed Homebrew stable through the core handoff and fresh shells', () => {
    const localBin = path.join(home, '.local/bin');
    const prefix = path.join(root, 'homebrew');
    fs.mkdirSync(localBin, { recursive: true });
    linkFake('brew', localBin);
    const coreRepo = path.join(root, 'core-repo');
    fs.mkdirSync(path.join(coreRepo, 'config'), { recursive: true });
    fs.mkdirSync(path.join(coreRepo, 'bin'));
    fs.writeFileSync(path.join(coreRepo, 'config/.defaultConfig.json'), '{"backup":{}}\n');
    fs.writeFileSync(path.join(coreRepo, 'bin/ballin'), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
    const core = path.join(root, 'core-handoff');
    fs.writeFileSync(core, '#!/bin/bash\nexec "$TEST_NODE_RUNTIME" "$FAKE_SETUP_SOURCE" setup "$FAKE_CORE_REPO" https://example.test/docs "" refresh\n');
    const overrides = { FAKE_EARLY_ANSWER: 'no\n', FAKE_BREW_PREFIX: prefix, FAKE_CORE_INSTALL_SOURCE: core, FAKE_CORE_REPO: coreRepo,
      FAKE_SETUP_SOURCE: path.resolve(__dirname, '../commands/install_setup.ts') };
    const result = run('y\n', overrides);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.isTrue(fs.lstatSync(path.join(prefix, 'bin/ballin')).isSymbolicLink());
    fs.unlinkSync(path.join(coreRepo, 'ballin.config.json'));
    const fresh = spawnSync('/bin/zsh', ['-f', '-c', 'source "$HOME/.zshrc"; bash "$FAKE_CORE_INSTALL_SOURCE"'], {
      encoding: 'utf8', cwd: root,
      env: testChildEnvironment({ HOME: home, PATH: tools, FAKE_ROOT: root, FAKE_COMMAND_LOG: log,
        TEST_NODE_RUNTIME: process.execPath, ...overrides }),
    });
    assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
    assert.include(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), localBin + ':' + path.join(prefix, 'bin'));
    for (const forbidden of ['sudo:', 'xcode-select:--install', 'ballin:backup', 'gh:auth', 'gh:api']) assert.notInclude(readLog(), forbidden);
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
      assert.include(result.stdout, cltInstallQuestion);
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
      else assert.include(result.stdout, cltInstallQuestion);
      if (scenario === 'failure') assert.include(result.stderr, 'Finish any pending installation, then rerun Quickstart.');
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
        encoding: 'utf8', input: 'y\n\nhome\ny\ny\n\n', cwd: home, timeout: 12000,
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
      assert.include(profile, "PATH=$PATH:'" + (executableBrew ? path.join(executablePrefix, 'bin') : path.join(home, '.local/bin')) + "'");
      assert.notInclude(profile, functionPrefix);
      assert.include(readLog(), 'ballin:backup open');
      assert.notInclude(readLog(), 'sudo:');
    });
  }
  it('keeps the local command directory when optional Homebrew prefix lookup fails', () => {
    linkFake('brew');
    const result = run('y\ny\n', { FAKE_BREW_FAIL: '1' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), "PATH=$PATH:'" + path.join(home, '.local/bin') + "'");
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
      assert.include(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), "PATH=$PATH:'" + path.join(prefix, 'bin') + "'");
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
        assert.include(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), "PATH=$PATH:'" + path.join(home, '.local/bin') + "'");
      });
    }
  }
  for (const override of ['git', 'node', 'PATH']) {
    it(`does not reload inherited BASH_ENV ${override} overrides in the actual core installer`, () => {
      const startup = path.join(root, 'injected-startup');
      const startupTools = path.join(root, 'startup-tools');
      fs.mkdirSync(startupTools);
      fs.writeFileSync(path.join(startupTools, 'git'), '#!/bin/sh\nexit 73\n', { mode: 0o755 });
      fs.writeFileSync(startup, 'printf "bash-env-loaded\\n" >> "$FAKE_COMMAND_LOG"\n'
        + 'case "$0" in */install.sh) printf "core-startup-reloaded\\n" >> "$FAKE_COMMAND_LOG" ;; esac\n'
        + (override === 'PATH' ? 'export PATH="$FAKE_STARTUP_TOOLS:$PATH"\n'
          : `${override}() { return 73; }\n`));
      const core = path.join(root, 'core-with-environment-probe');
      // Execute the real installer body after recording its inherited environment.
      fs.writeFileSync(core, '"$TEST_NODE_RUNTIME" -e \'require("fs").writeFileSync(process.env.FAKE_CORE_ENV, JSON.stringify(process.env))\'\n'
        + fs.readFileSync(path.resolve(__dirname, '../install.sh'), 'utf8'));
      const retained = { HOME: home, GH_TOKEN: 'fixture-token', GH_CONFIG_DIR: path.join(home, 'gh-config'),
        HTTPS_PROXY: 'https://proxy.example.invalid:8443', CUSTOM_SETTING: 'keep this value' };
      const result = run('y\nn\n', {
        ...retained, BASH_ENV: startup, FAKE_STARTUP_TOOLS: startupTools, FAKE_CORE_INSTALL_SOURCE: core,
        FAKE_CORE_ENV: path.join(root, 'core-env.json'), FAKE_PARENT_ENV: path.join(root, 'parent-env.json'),
      }, home, '', 'y\n', '"$TEST_NODE_RUNTIME" -e \'require("fs").writeFileSync(process.env.FAKE_PARENT_ENV, JSON.stringify(process.env))\'');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(readLog(), 'bash-env-loaded');
      assert.notInclude(readLog(), 'core-startup-reloaded');
      assert.notInclude(result.stdout, 'Missing prerequisites:');
      assert.include(result.stdout, 'and make the ballin command available? [y/N]');
      assert.include(result.stdout, 'Ballin installation cancelled. Rerun the installer when you’re ready.');
      const childEnv = JSON.parse(fs.readFileSync(path.join(root, 'core-env.json'), 'utf8'));
      const parentEnv = JSON.parse(fs.readFileSync(path.join(root, 'parent-env.json'), 'utf8'));
      assert.equal(childEnv.BASH_ENV, '');
      assert.equal(parentEnv.BASH_ENV, startup);
      assert.equal(childEnv.PATH, parentEnv.PATH);
      assert.isTrue(childEnv.PATH.startsWith(path.join(home, '.local/share/ballin-quickstart/bin') + ':'));
      for (const [key, value] of Object.entries(retained)) assert.equal(childEnv[key], value, key);
      assert.notInclude(readLog(), 'git:clone');
      assert.notInclude(readLog(), 'ballin:');
      assert.isFalse(fs.existsSync(path.join(home, '.ballin-scripts')));
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    });
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
        encoding: 'utf8', input: 'y\n\nhome\ny\nn\n', cwd: home, timeout: 12000,
        env: testChildEnvironment({ HOME: home, PATH: tools, TMPDIR: path.join(root, 'tmp'), SHELL: '/bin/zsh',
          FAKE_ROOT: root, FAKE_COMMAND_LOG: log, FAKE_SOURCE: source, FAKE_SYSTEM_NODE: systemNode,
          TEST_NODE_RUNTIME: process.execPath, FAKE_CORE_INSTALL_SOURCE: path.resolve(__dirname, '../install.sh') }),
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.notInclude(result.stdout, 'Missing prerequisites:');
      assert.include(result.stdout, 'and make the ballin command available? [y/N]');
      assert.include(result.stdout, 'Ballin installation cancelled. Rerun the installer when you’re ready.');
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
      assert.notInclude(result.stdout, 'so it works in new Terminal windows? [y/N]');
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
      assert.include(fs.readFileSync(profile, 'utf8'), "PATH=$PATH:'" + path.join(root, 'brew/bin') + "'");
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
  for (const name of ['node', 'git', 'gh']) {
    for (const regular of [false, true]) {
      it(`handles a managed ${name} fallback rerun with a ${regular ? 'regular file' : 'symlink'} slot`, () => {
        assert.equal(run().status, 0);
        const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
        const target = path.join(quickBin, name);
        const fallback = path.join(root, 'fallback');
        fs.mkdirSync(fallback);
        const executable = path.join(fallback, name);
        fs.copyFileSync(path.join(root, 'fake-tool'), executable);
        fs.chmodSync(executable, 0o755);
        fs.rmSync(target, { force: true });
        if (regular) fs.copyFileSync(executable, target);
        else fs.symlinkSync(executable, target);
        fs.unlinkSync(path.join(tools, name));
        const before = fs.lstatSync(target);
        const profile = fs.readFileSync(path.join(home, '.zshrc'));
        fs.writeFileSync(log, '');

        const result = run();

        assert.equal(result.status, regular ? 1 : 0, result.stdout + result.stderr);
        assert.equal(fs.lstatSync(target).ino, before.ino);
        assert.equal(fs.lstatSync(target).mode, before.mode);
        assert.deepEqual(fs.readFileSync(target), fs.readFileSync(executable));
        assert.deepEqual(fs.readFileSync(path.join(home, '.zshrc')), profile);
        if (regular) {
          assert.include(result.stderr, `Refusing to replace an existing file at ${target}.`);
          for (const forbidden of ['auth status --active', 'install.sh:', 'ballin:', 'sudo:']) {
            assert.notInclude(readLog(), forbidden);
          }
        } else {
          assert.equal(fs.readlinkSync(target), executable);
          assert.include(readLog(), 'ballin:backup open');
        }
      });
    }
  }
  for (const kind of ['file', 'directory']) {
    for (const self of [true, false]) {
      it(`refuses a managed ${kind} conflict when binding ${self ? 'the same' : 'another'} path`, () => {
        const quickBin = path.join(root, 'binding slots');
        fs.mkdirSync(quickBin);
        const target = path.join(quickBin, 'npm');
        if (kind === 'directory') fs.mkdirSync(target);
        const content = kind === 'directory' ? path.join(target, 'sentinel') : target;
        fs.writeFileSync(content, 'preserve this content\n');
        const before = fs.lstatSync(target);
        const result = spawnSync('/bin/bash', ['-c',
          'source "$1"; quick_bin="$2"; bind_tool npm "$3"', 'fixture', source, quickBin,
          self ? target : path.join(tools, 'node')], {
          encoding: 'utf8', env: testChildEnvironment({ HOME: home, PATH: tools }),
        });
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.include(result.stderr, `Refusing to replace an existing file at ${target}.`);
        assert.equal(fs.lstatSync(target).ino, before.ino);
        assert.equal(fs.lstatSync(target).mode, before.mode);
        assert.equal(fs.readFileSync(content, 'utf8'), 'preserve this content\n');
      });
    }
  }
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
      if (name === 'node') {
        assert.equal(result.status, 1, result.stdout + result.stderr);
        assert.include(result.stderr, 'Existing Node.js at ' + path.join(early, name));
        assert.notInclude(readLog(), 'install.sh:'); return;
      }
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.notInclude(result.stdout, 'Missing prerequisites:');
      assert.include(result.stdout, 'and make the ballin command available? [y/N]');
      assert.include(result.stdout, 'Ballin installation cancelled. Rerun the installer when you’re ready.');
      const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
      assert.equal(fs.readlinkSync(path.join(quickBin, name)), path.join(later, name));
      if (name === 'node') assert.equal(fs.readlinkSync(path.join(quickBin, 'npm')), path.join(later, 'npm'));
      for (const forbidden of ['sudo:', 'xcode-select:--install', '/releases/latest', 'git:clone', 'ballin:']) {
        assert.notInclude(readLog(), forbidden);
      }
    });
  }
  for (const helpExit of [0, 42]) {
    it(`drains streamed GitHub CLI help and respects producer exit ${helpExit}`, () => {
      const early = path.join(root, 'streamed-help');
      fs.mkdirSync(early);
      const candidate = path.join(early, 'gh');
      fs.writeFileSync(candidate, '#!/bin/bash\n'
        + 'printf "streamed-gh:%s\\n" "$*" >> "$FAKE_COMMAND_LOG"\n'
        + 'if [[ "$*" == "auth status --help" ]]; then exec "$TEST_NODE_RUNTIME" "$FAKE_ROOT/streamed-help.cjs"; fi\n'
        + 'exec "$FAKE_ROOT/tools/gh" "$@"\n', { mode: 0o755 });
      fs.writeFileSync(path.join(root, 'streamed-help.cjs'),
        'process.stdout.on("error", error => { if (error.code === "EPIPE") process.exit(141); throw error; });\n'
        + 'process.stdout.write("--active\\n");\n'
        // Exceed the pipe buffer so accepting the flag must still drain the producer.
        + 'process.stdout.write("Additional help.\\n".repeat(65536), () => {\n'
        + `  process.exitCode = ${helpExit};\n`
        + '});\n');
      const result = run('y\nn\n', {
        PATH: `${early}:${tools}`, FAKE_CORE_INSTALL_SOURCE: path.resolve(__dirname, '../install.sh'),
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.notInclude(result.stdout, 'Missing prerequisites:');
      assert.include(result.stdout, 'Ballin installation cancelled. Rerun the installer when you’re ready.');
      const selected = fs.readlinkSync(path.join(home, '.local/share/ballin-quickstart/bin/gh'));
      assert.equal(selected, helpExit === 0 ? candidate : path.join(tools, 'gh'));
      assert.include(readLog(), 'streamed-gh:auth status --help');
      if (helpExit === 0) assert.include(readLog(), 'streamed-gh:auth status --active --hostname github.com');
      else assert.notInclude(readLog(), 'streamed-gh:auth status --active');
      for (const forbidden of ['sudo:', 'xcode-select:--install', '/releases/latest', 'git:clone', 'ballin:']) {
        assert.notInclude(readLog(), forbidden);
      }
    });
  }
  for (const boundary of ['active', 'PATH revalidation']) {
    for (const state of ['incompatible', 'failed', 'unavailable', 'empty', 'malformed', '130', '143']) {
      it(`preserves ${state} Node guidance at ${boundary} before any setup changes`, () => {
        const prefix = nativeBrew();
        const candidate = path.join(prefix, 'Cellar/node/25.0.0/bin/node');
        fs.mkdirSync(path.dirname(candidate), { recursive: true });
        const firstProbe = boundary === 'PATH revalidation'
          ? 'if [[ ! -e "$FAKE_ROOT/node-probes" ]]; then touch "$FAKE_ROOT/node-probes"; printf "true\\n"; exit 0; fi\n' : '';
        const response = state === 'incompatible' ? "printf 'false\\n'\n"
          : state === 'failed' ? 'exit 73\n' : state === 'unavailable' ? 'exit 126\n' : state === 'empty' ? 'exit 0\n'
          : state === 'malformed' ? "printf 'v24.22.0\\n'\n" : `exit ${state}\n`;
        const contents = '#!/bin/bash\n' + firstProbe + response;
        fs.writeFileSync(candidate, contents, { mode: 0o755 });
        fs.symlinkSync('../Cellar/node/25.0.0/bin/node', path.join(prefix, 'bin/node'));
        const result = run('', { PATH: path.join(prefix, 'bin') + ':' + tools });
        assert.equal(result.status, ['130', '143'].includes(state) ? Number(state) : 1, result.stdout + result.stderr);
        if (state === 'incompatible') {
          assert.include(result.stderr, 'Homebrew (review `brew upgrade node` yourself)');
          assert.include(result.stderr, 'Ballin requires Node.js 24.12 or newer.');
          assert.notInclude(result.stderr, 'could not be verified');
        } else if (['failed', 'unavailable', 'empty', 'malformed'].includes(state)) {
          assert.include(result.stderr, `Existing Node.js at ${path.join(prefix, 'bin/node')} could not be verified.`);
          assert.include(result.stderr, 'Check it using its existing installation method');
          for (const unsupported of ['brew upgrade', 'Update or select', 'Ballin requires', 'v24.22.0']) assert.notInclude(result.stderr, unsupported);
        } else {
          assert.notInclude(result.stderr, 'could not be verified');
          assert.notInclude(result.stderr, 'Update or select');
        }
        assert.equal(fs.readFileSync(candidate, 'utf8'), contents);
        assert.equal(fs.readlinkSync(path.join(prefix, 'bin/node')), '../Cellar/node/25.0.0/bin/node');
        assert.isFalse(fs.existsSync(path.join(home, '.local')));
        assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
        for (const forbidden of ['native-brew:install', 'native-brew:info', 'native-brew:ruby', 'nodejs.org', 'auth status', 'install.sh:', 'git:clone', 'ballin:', 'sudo:']) assert.notInclude(readLog(), forbidden);
      });
    }
  }
  it('requires manual repair of an incompatible first Node before reusing a later compatible manager', () => {
    const early = path.join(root, 'invalid-first'); fs.mkdirSync(early);
    fs.writeFileSync(path.join(early, 'node'), "#!/bin/bash\nprintf 'false\\n'\n", { mode: 0o755 });
    const manager = path.join(home, '.nvm/versions/node/v24.22.0/bin'); fs.mkdirSync(manager, { recursive: true });
    for (const name of ['node', 'npm']) linkFake(name, manager);
    const options = { PATH: `${early}:${manager}:${tools}`, FAKE_CORE_INSTALL_SOURCE: path.resolve(__dirname, '../install.sh') };
    const blocked = run('y\nn\n', options);
    assert.equal(blocked.status, 1); assert.include(blocked.stderr, 'Existing Node.js at ' + early + '/node');
    assert.isFalse(fs.existsSync(path.join(home, '.local')));
    fs.unlinkSync(path.join(early, 'node'));
    const repaired = run('y\nn\n', options);
    assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
    assert.notInclude(readLog(), 'sudo:');
    for (const name of ['node', 'npm']) assert.isFalse(fs.existsSync(path.join(home, '.local/share/ballin-quickstart/bin', name)));
  });
  for (const shell of ['bash', 'zsh']) {
    for (const scenario of ['live link', 'dangling link', 'absent link', 'non-executable sibling', 'replacement sibling']) {
      it(`reconciles the managed npm fallback on a ${shell} rerun with ${scenario}`, () => {
        const early = path.join(root, 'invalid-first');
        const first = path.join(root, 'first-node');
        const next = path.join(root, 'next-node');
        const npmBin = path.join(root, 'independent-npm');
        for (const dir of [early, first, next, npmBin]) fs.mkdirSync(dir);
        fs.unlinkSync(path.join(tools, 'node'));
        linkFake('node', first);
        fs.copyFileSync(path.join(root, 'fake-tool'), path.join(next, 'node'));
        const npmContents = '#!/bin/bash\nexit 0\n';
        for (const dir of [first, npmBin]) fs.writeFileSync(path.join(dir, 'npm'), npmContents, { mode: 0o755 });
        const core = { SHELL: '/bin/' + shell, FAKE_CORE_INSTALL_SOURCE: path.resolve(__dirname, '../install.sh') };
        const installed = run('y\nn\n', { ...core, PATH: `${early}:${npmBin}:${tools}` }, home, 'system_node_bin="$FAKE_ROOT/first-node"');
        assert.equal(installed.status, 0, installed.stdout + installed.stderr);
        const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
        const managedNpm = path.join(quickBin, 'npm');
        assert.equal(fs.readlinkSync(managedNpm), path.join(first, 'npm'));
        if (scenario === 'dangling link') fs.unlinkSync(path.join(first, 'npm'));
        if (scenario === 'absent link') fs.unlinkSync(managedNpm);
        if (scenario.includes('sibling')) {
          fs.writeFileSync(path.join(next, 'npm'), npmContents, { mode: scenario === 'replacement sibling' ? 0o755 : 0o644 });
        }
        const profile = path.join(home, shell === 'bash' ? '.bash_profile' : '.zshrc');
        const before = fs.readFileSync(profile, 'utf8');
        fs.writeFileSync(log, '');
        const rerun = run('n\n', { ...core, PATH: `${quickBin}:${early}:${next}:${npmBin}:${tools}` });
        assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
        for (const name of ['node', 'npm']) assert.notInclude(fs.readdirSync(quickBin), name, 'Release even a dangling link');
        assert.equal(fs.readFileSync(profile, 'utf8'), before);
        if (scenario !== 'dangling link') assert.equal(fs.readFileSync(path.join(first, 'npm'), 'utf8'), npmContents);
        assert.equal(fs.readFileSync(path.join(npmBin, 'npm'), 'utf8'), npmContents);
        if (scenario.includes('sibling')) assert.equal(fs.readFileSync(path.join(next, 'npm'), 'utf8'), npmContents);
        const fresh = spawnSync('/bin/' + shell, ['-f', '-c', 'source "$FAKE_PROFILE"; command -v node; command -v npm'], {
          encoding: 'utf8', cwd: home,
          env: testChildEnvironment({ HOME: home, PATH: `${early}:${next}:${npmBin}:${tools}`, FAKE_PROFILE: profile }),
        });
        assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
        assert.deepEqual(fresh.stdout.trim().split('\n'), [path.join(next, 'node'),
          scenario === 'replacement sibling' ? path.join(next, 'npm') : path.join(npmBin, 'npm')]);
        for (const forbidden of ['sudo:', 'xcode-select:--install', 'ballin:']) assert.notInclude(readLog(), forbidden);
      });
    }
  }
  for (const kind of ['file', 'directory']) {
    it(`refuses to remove a non-symlink npm ${kind} while rebinding Node`, () => {
      const early = path.join(root, 'invalid-first');
      fs.mkdirSync(early);

      const core = { FAKE_CORE_INSTALL_SOURCE: path.resolve(__dirname, '../install.sh'), PATH: `${early}:${tools}` };
      const first = run('y\nn\n', core);
      assert.equal(first.status, 0, first.stdout + first.stderr);
      const target = path.join(home, '.local/share/ballin-quickstart/bin/npm');
      if (kind === 'directory') fs.mkdirSync(target);
      const protectedFile = kind === 'file' ? target : path.join(target, 'keep');
      fs.writeFileSync(protectedFile, 'Do not remove.\n', { mode: 0o640 });
      const before = fs.statSync(protectedFile);
      fs.writeFileSync(log, '');
      const rerun = run('n\n', core);
      assert.equal(rerun.status, 1, rerun.stdout + rerun.stderr);
      assert.include(rerun.stderr, `Refusing to replace an existing file at ${target}`);
      assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'Do not remove.\n');
      const after = fs.statSync(protectedFile);
      for (const key of ['ino', 'mode', 'mtimeMs']) assert.equal(after[key], before[key], key);
      for (const forbidden of ['auth status --active', 'install.sh:', 'ballin:', 'sudo:']) assert.notInclude(readLog(), forbidden);
    });
  }
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
      const first = run('y\ny\ny\n', { FAKE_MISSING_NODE: '1' });
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
      const rerun = run('', { PATH: `${aliasBin}:${quickBin}:${tools}`, FAKE_MISSING_NODE: '1' });
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
      const takeover = run('', { PATH: `${aliasBin}:${quickBin}:${managerBin}:${tools}`, FAKE_MISSING_NODE: '1' });
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
  for (const spelling of ['direct', 'directory alias', 'executable alias']) {
    for (const managedFirst of [true, false]) {
      it(`preserves Node PATH precedence with an older external runtime (${spelling}, managed first: ${managedFirst})`, () => {
        linkFake('npm', systemNode);
        const first = run('y\ny\ny\n', { FAKE_MISSING_NODE: '1' });
        assert.equal(first.status, 0, first.stdout + first.stderr);
        const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
        let entry = quickBin;
        if (spelling === 'directory alias') {
          entry = path.join(root, 'managed-directory-alias');
          fs.symlinkSync(quickBin, entry);
        } else if (spelling === 'executable alias') {
          entry = path.join(root, 'managed-executable-alias'); fs.mkdirSync(entry);
          fs.symlinkSync(path.relative(entry, path.join(quickBin, 'node')), path.join(entry, 'node'));
        }
        const older = path.join(home, '.nvm/versions/node/v18.0.0/bin');
        fs.mkdirSync(older, { recursive: true });
        const oldBytes = "#!/bin/bash\nprintf 'false\\n'\n";
        fs.writeFileSync(path.join(older, 'node'), oldBytes, { mode: 0o755 });
        const profile = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
        const links = ['node', 'npm'].map(name => fs.readlinkSync(path.join(quickBin, name)));
        fs.writeFileSync(log, '');
        const entries = managedFirst ? [entry, older] : [older, entry];
        const result = run('', { PATH: [...entries, quickBin, tools].join(':'), FAKE_MISSING_NODE: '1' });
        assert.equal(result.status, managedFirst ? 0 : 1, result.stdout + result.stderr);
        if (managedFirst) assert.notInclude(result.stderr, 'needs manual attention');
        else {
          assert.include(result.stderr, `Existing Node.js at ${path.join(older, 'node')} needs manual attention`);
          assert.notInclude(readLog(), 'auth status --active'); assert.notInclude(readLog(), 'install.sh:');
        }
        assert.deepEqual(['node', 'npm'].map(name => fs.readlinkSync(path.join(quickBin, name))), links);
        assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), profile);
        assert.equal(fs.readFileSync(path.join(older, 'node'), 'utf8'), oldBytes);
        for (const forbidden of ['sudo:', 'nodejs.org', 'native-brew:install']) assert.notInclude(readLog(), forbidden);
      });
    }
  }
  it('releases managed fallback links when a compatible version manager becomes available on rerun', () => {
    linkFake('npm', systemNode);
    const first = run('y\ny\ny\n', { FAKE_MISSING_NODE: '1' });
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
    for (const name of ['node', 'npm']) assert.isTrue(fs.lstatSync(path.join(quickBin, name)).isSymbolicLink());
    const managerBin = path.join(home, '.nvm/versions/node/v24.21.0/bin');
    fs.mkdirSync(managerBin, { recursive: true });
    linkFake('node', managerBin);
    linkFake('npm', managerBin);
    const before = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
    const rerun = run('', { PATH: `${quickBin}:${managerBin}:${tools}`, FAKE_MISSING_NODE: '1' });
    assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
    for (const name of ['node', 'npm']) assert.isFalse(fs.existsSync(path.join(quickBin, name)));
    assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), before);
    assert.equal(readLog().split('sudo:').length - 1, 1);
  });
  for (const inheritedFromFirstRun of [false, true]) {
    it(`preserves a recognized marker on noclobber reruns with initial inheritance ${inheritedFromFirstRun}`, () => {
      const core = path.resolve(__dirname, '../install.sh');
      const wrapper = path.join(root, 'core-with-noclobber-probe');
      const unrelated = path.join(root, 'unrelated');
      fs.writeFileSync(unrelated, 'Keep this file.\n');
      fs.writeFileSync(wrapper, '#!/bin/bash\n'
        + '[[ -o noclobber ]] || exit 97\n'
        + 'if printf "overwritten" > "$FAKE_ROOT/unrelated"; then exit 98; fi\n'
        + 'exec /bin/bash "$FAKE_ACTUAL_CORE"\n');
      const inherited = { SHELLOPTS: 'noclobber', FAKE_CORE_INSTALL_SOURCE: wrapper, FAKE_ACTUAL_CORE: core };
      const first = run('y\nn\n', inheritedFromFirstRun ? inherited : { FAKE_CORE_INSTALL_SOURCE: core });
      assert.equal(first.status, 0, first.stdout + first.stderr);
      const marker = path.join(home, '.local/share/ballin-quickstart/.managed');
      const before = fs.statSync(marker);
      const profile = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
      fs.writeFileSync(log, '');
      const retry = run('n\n', inherited);
      assert.equal(retry.status, 0, retry.stdout + retry.stderr);
      assert.include(retry.stdout, 'and make the ballin command available? [y/N]');
      assert.include(retry.stdout, 'Ballin installation cancelled. Rerun the installer when you’re ready.');
      assert.include(retry.stderr, 'unrelated: cannot overwrite existing file');
      assert.equal(fs.readFileSync(unrelated, 'utf8'), 'Keep this file.\n');
      assert.equal(fs.readFileSync(marker, 'utf8'), '1\n');
      const after = fs.statSync(marker);
      for (const key of ['ino', 'mode', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key], key);
      assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), profile);
      assert.include(readLog(), 'gh:auth status --active --hostname github.com');
      assert.notInclude(readLog(), 'ballin:');
    });
  }
  for (const kind of ['missing', 'invalid', 'symlink']) {
    it(`still refuses ${kind} managed markers with inherited noclobber`, () => {
      const managed = path.join(home, '.local/share/ballin-quickstart');
      const marker = path.join(managed, '.managed');
      const unrelated = path.join(root, 'unrelated');
      fs.mkdirSync(managed, { recursive: true });
      fs.writeFileSync(unrelated, '1\n');
      if (kind === 'invalid') fs.writeFileSync(marker, 'unrecognized\n');
      if (kind === 'symlink') fs.symlinkSync(unrelated, marker);
      const result = run('', { SHELLOPTS: 'noclobber' });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.include(result.stderr, 'Refusing to change an unrecognized directory');
      assert.isFalse(fs.existsSync(path.join(managed, 'bin')));
      assert.equal(fs.readFileSync(unrelated, 'utf8'), '1\n');
      if (kind === 'missing') assert.isFalse(fs.existsSync(marker));
      if (kind === 'invalid') assert.equal(fs.readFileSync(marker, 'utf8'), 'unrecognized\n');
      if (kind === 'symlink') assert.isTrue(fs.lstatSync(marker).isSymbolicLink());
      assert.notInclude(readLog(), 'gh:auth status --active');
      assert.notInclude(readLog(), 'install.sh:');
    });
  }
  it('keeps links and one PATH line usable when rerun through the new PATH', () => {
    assert.equal(run('y\ny\ny\n', { FAKE_MISSING_NODE: '1' }).status, 0);
    const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
    const before = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
    const result = run('', { PATH: `${quickBin}:${tools}`, FAKE_MISSING_NODE: '1' });
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
      const first = run('y\ny\ny\n', { FAKE_MISSING_NODE: '1' });
      assert.equal(first.status, 0, first.stdout + first.stderr);
      const quickBin = path.join(home, '.local/share/ballin-quickstart/bin');
      const alias = path.join(root, 'managed-bin-alias');
      fs.symlinkSync(quickBin, alias);
      const entry = spelling === 'trailing slash' ? quickBin + '/'
        : spelling === 'directory symlink' ? alias : quickBin + '/../bin';
      const profile = path.join(home, '.zshrc');
      const before = fs.readFileSync(profile, 'utf8');
      const rerun = run('', { PATH: `${entry}:${tools}`, FAKE_MISSING_NODE: '1' });
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
      const takeover = run('', { PATH: `${entry}:${managerBin}:${tools}`, FAKE_MISSING_NODE: '1' });
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
      const result = run('y\n\ny\ny\n', { FAKE_GIT: 'missing', FAKE_ARCH: arch, FAKE_MISSING_NODE: '1' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, 'Install Xcode Command Line Tools, Node.js, and GitHub CLI and Ballin? [y/N]');
      assert.include(readLog(), 'xcode-select:--install');
      assert.notInclude(readLog(), 'brew:');
      assert.include(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), "PATH='" + path.join(home, '.local/share/ballin-quickstart/bin') + "':$PATH:'" + path.join(home, '.local/bin') + "'");
      assert.include(readLog(), 'sudo:/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/bash -c');
      assert.include(readLog(), `gh_2.102.0_macOS_${arch === 'arm64' ? 'arm64' : 'amd64'}.zip`);
      assert.include(readLog(), 'ballin:backup open');
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    });
  }
  for (const needsNode of [true, false]) {
    it(`omits generic password/replacement notices for missing tools (Node missing: ${needsNode})`, () => {
      fs.unlinkSync(path.join(tools, 'gh'));
      const result = run('n\n', { FAKE_MISSING_NODE: needsNode ? '1' : '0' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const consent = result.stdout.indexOf(needsNode ? 'Install Node.js and GitHub CLI and Ballin?' : 'Install GitHub CLI and Ballin?');
      assert.isAtLeast(consent, 0);
      const notice = 'Installation may ask for your Mac password.';
      assert.notInclude(result.stdout, notice);
      assert.notInclude(result.stdout, 'may replace existing Node.js/npm');
      for (const forbidden of ['sudo:', 'xcode-select:--install', 'curl:', 'auth status', 'install.sh:', 'ballin:']) {
        assert.notInclude(readLog(), forbidden);
      }
      assert.isFalse(fs.existsSync(path.join(home, '.local')));
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    });
  }
  for (const shadow of ['function', 'PATH']) {
    for (const outcome of ['success', 'decline', 'failure']) {
      it(`uses system sudo with a ${shadow} shadow and prerequisite ${outcome}`, () => {
        const systemTools = path.join(root, 'system tools');
        const shadowTools = path.join(root, 'shadow tools');
        fs.mkdirSync(systemTools);
        fs.mkdirSync(shadowTools);
        linkFake('sudo', systemTools);
        const intercept = 'printf "shadow-sudo\\n" >> "$FAKE_COMMAND_LOG"; return 73;';
        if (shadow === 'PATH') fs.writeFileSync(path.join(shadowTools, 'sudo'),
          '#!/bin/bash\nprintf "shadow-sudo\\n" >> "$FAKE_COMMAND_LOG"\nexit 73\n', { mode: 0o755 });
        const result = run(outcome === 'decline' ? 'n\n' : 'y\ny\ny\n', {
          PATH: `${shadowTools}:${tools}`, FAKE_MISSING_NODE: '1',
          FAKE_SYSTEM_SUDO: path.join(systemTools, 'sudo'),
          FAKE_SUDO_FAIL: outcome === 'failure' ? '1' : '0',
        }, home, shadow === 'function' ? `sudo() { ${intercept} }; export -f sudo` : '');
        assert.equal(result.status, outcome === 'failure' ? 1 : 0, result.stdout + result.stderr);
        assert.notInclude(readLog(), 'shadow-sudo');
        if (outcome === 'decline') {
          assert.notInclude(readLog(), 'sudo:');
          assert.notInclude(readLog(), 'pkgutil:');
          assert.isFalse(fs.existsSync(path.join(home, '.local')));
        } else {
          assert.equal(readLog().split('sudo:/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/bash -c').length - 1, 1);
          assert.isAbove(readLog().indexOf('sudo:/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/bash -c'), readLog().indexOf('pkgutil:--check-signature'));
        }
        if (outcome === 'success') assert.include(readLog(), 'ballin:backup open');
        else for (const forbidden of ['auth status --active', 'install.sh:', 'ballin:']) assert.notInclude(readLog(), forbidden);
        assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
      });
    }
  }
  for (const signature of ['valid', 'invalid', 'wrong publisher']) {
    it(`verifies Node package signatures (${signature}) with system pkgutil absent from PATH`, () => {
      const systemTools = path.join(root, 'system tools');
      fs.mkdirSync(systemTools);
      linkFake('pkgutil', systemTools);
      fs.unlinkSync(path.join(tools, 'pkgutil'));
      const result = run('y\ny\ny\n', {
        FAKE_MISSING_NODE: '1', FAKE_SYSTEM_PKGUTIL: path.join(systemTools, 'pkgutil'),
        FAKE_SIGNATURE_FAIL: signature === 'invalid' ? '1' : '0',
        FAKE_BAD_PUBLISHER: signature === 'wrong publisher' ? '1' : '0',
      });
      assert.equal(result.status, signature === 'valid' ? 0 : 1, result.stdout + result.stderr);
      const signatureCheck = readLog().indexOf('pkgutil:--check-signature');
      assert.isAtLeast(signatureCheck, 0);
      if (signature === 'valid') {
        assert.isAbove(readLog().indexOf('sudo:/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/bash -c'), signatureCheck);
        assert.include(readLog(), 'ballin:backup open');
      } else {
        assert.include(result.stderr, signature === 'invalid'
          ? 'The Node.js package signature could not be verified.'
          : 'The Node.js package has an unexpected publisher; it was not installed.');
        assert.notInclude(readLog(), 'sudo:');
        assert.notInclude(readLog(), 'install.sh:');
      }
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    });
  }
  it('reuses compatible system Node when Node is missing from PATH', () => {
    linkFake('node', systemNode);
    const result = run('y\ny\n', { FAKE_MISSING_NODE: '1' });
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
  for (const inherited of [undefined, '', 'caller-choice']) {
    it(`suppresses only login update notices and preserves the caller environment: ${JSON.stringify(inherited)}`, () => {
      const result = run('y\ndevice-code\ny\n', {
        FAKE_AUTH: 'missing', FAKE_GH_UPDATE_NOTICE: '1', FAKE_RECORD_GH_NOTIFIER: '1',
        ...(inherited === undefined ? {} : { GH_NO_UPDATE_NOTIFIER: inherited }),
      }, home, 'exec 2>&1', 'y\n', 'gh --version');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, '✓ Logged in as fixture-user\n\n==> Installing Ballin\n');
      const events = readLog().split('\n').filter(line => line.startsWith('gh-notifier:'));
      assert.deepEqual(events.filter(line => line.startsWith('gh-notifier:auth login ')), [
        'gh-notifier:auth login --hostname github.com --git-protocol https --web:1',
      ]);
      const otherCalls = events.filter(line => !line.startsWith('gh-notifier:auth login '));
      assert.include(otherCalls, `gh-notifier:auth status --active --hostname github.com:${inherited ?? 'unset'}`);
      assert.isAtLeast(otherCalls.filter(line => line.startsWith('gh-notifier:--version:')).length, 2);
      assert.isTrue(otherCalls.every(line => line.endsWith(`:${inherited ?? 'unset'}`)), events.join('\n'));
      assert.equal(result.stdout.includes('A new release of gh is available:'), !inherited,
        'The later gh call keeps its caller-selected notifier behavior');
      assert.equal(result.stderr, '');
    });
  }
  it('leaves notifier settings untouched when existing authentication skips login', () => {
    const result = run('y\ny\n', { FAKE_RECORD_GH_NOTIFIER: '1' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const events = readLog().split('\n').filter(line => line.startsWith('gh-notifier:'));
    assert.isNotEmpty(events);
    assert.isTrue(events.every(line => line.endsWith(':unset')));
    assert.notInclude(readLog(), 'gh:auth login');
  });
  for (const failure of ['7', '130', '143', 'INT', 'TERM']) {
    it(`preserves native login output and failure ${failure} without installation`, () => {
      const result = run('y\n', {
        FAKE_AUTH: 'missing', FAKE_GH_LOGIN_FAILURE: failure, FAKE_RECORD_GH_NOTIFIER: '1',
      });
      const expected = failure === 'INT' ? 130 : failure === 'TERM' ? 143 : Number(failure);
      assert.equal(result.status, expected, result.stdout + result.stderr);
      assert.include(result.stdout, 'Native login failure output\n');
      assert.include(result.stderr, 'Native login failure diagnostic\n');
      assert.include(readLog(), 'gh-notifier:auth login --hostname github.com --git-protocol https --web:1');
      assert.notInclude(readLog(), '/main/install.sh');
      assert.notInclude(readLog(), 'install.sh:');
      assert.notInclude(readLog(), 'ballin:');
      assert.isFalse(fs.existsSync(path.join(root, 'login-complete')));
    });
  }
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
      const result = run('y\n', { FAKE_MISSING_NODE: '1', [flag]: '1' });
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
      const result = run('y\n', { FAKE_MISSING_NODE: kind === 'NODE' ? '1' : '0', [`FAKE_CORRUPT_${kind}`]: '1' });
      assert.equal(result.status, 1);
      assert.include(result.stderr, 'Checksum verification failed');
      for (const forbidden of ['sudo:', 'ditto:', 'install.sh:']) assert.notInclude(readLog(), forbidden);
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
    });
  }
  it('rejects an incompatible Node package version before requesting admin access', () => {
    fs.writeFileSync(path.join(root, 'node-checksums.txt'), 'a'.repeat(64) + '  node-v24.11.0.pkg\n');
    const result = run('y\n', { FAKE_MISSING_NODE: '1' });
    assert.equal(result.status, 1);
    assert.include(result.stderr, 'older than the required 24.12');
    assert.notInclude(readLog(), 'sudo:');
    assert.notInclude(readLog(), '/node-v24.11.0.pkg -o');
  });
  for (const pathComplete of [true, false]) {
    for (const answer of ['\n', 'y\n', 'Y\n']) {
      it(`captures and opens after first-backup acceptance ${JSON.stringify(answer)} with PATH complete ${pathComplete}`, () => {
        const result = run(pathComplete ? 'y\ny\n' : 'n\ny\n', {}, home, '', answer);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.include(result.stdout, 'Run a backup now and open its GitHub destination? [Y/n]');
        assert.equal(result.stdout.slice(result.stdout.indexOf(firstBackupPrompt)), firstBackupPrompt + '\n\n' + (pathComplete ? terminalGuidance : incompletePathGuidance));
        assert.include(readLog(), 'ballin:backup\nballin:backup open\n');
      });
    }
  }
  for (const pathComplete of [true, false]) {
    for (const configured of [true, false]) {
      for (const answer of ['n\n', 'N\n']) {
        it(`finishes installation without backup or open after ${answer.trim()} with configured backup ${configured} and PATH complete ${pathComplete}`, () => {
          const result = run(pathComplete ? 'y\ny\n' : 'n\ny\n', { FAKE_SKIP_BACKUP: configured ? '0' : '1' }, home, '', answer);
          assert.equal(result.status, 0, result.stdout + result.stderr);
          assert.isTrue(fs.existsSync(path.join(home, '.ballin-scripts/bin/ballin')));
          assert.isTrue(fs.existsSync(path.join(home, '.ballin-scripts/ballin.config.json')));
          assert.notInclude(readLog(), 'ballin:');
          assert.notInclude(result.stderr, 'not configured');
          // Piped answers have no echo; the final message supplies the newline.
          if (configured) assert.equal(result.stdout.slice(result.stdout.indexOf(firstBackupPrompt)), firstBackupPrompt + '\n' + (pathComplete ? terminalGuidance : incompletePathGuidance));
          else assert.notInclude(result.stdout, firstBackupPrompt);
          if (!pathComplete) {
            assert.notInclude(result.stdout, terminalGuidance);
            assert.include(result.stdout, 'PATH setup skipped.');
            assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
          }
        });
      }
    }
  }
  for (const input of ['', 'y', 'maybe\n']) {
    it(`does not accept first-backup input ending at EOF ${JSON.stringify(input)}`, () => {
      const result = run('y\ny\n', {}, home, '', input);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stderr, '');
      assert.include(result.stdout, terminalGuidance);
      assert.notInclude(readLog(), 'ballin:');
    });
  }
  for (const pathComplete of [true, false]) {
    it(`repeats the first-backup prompt for an invalid answer without accepting it with PATH complete ${pathComplete}`, () => {
      const result = run(pathComplete ? 'y\ny\n' : 'n\ny\n', {}, home, '', 'maybe\nn\n');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, 'Please enter yes or no.');
      assert.equal(result.stdout.split('Run a backup now and open its GitHub destination?').length - 1, 2);
      assert.equal(result.stdout.slice(result.stdout.indexOf(firstBackupPrompt)),
        firstBackupPrompt + '\nPlease enter yes or no.\n' + firstBackupPrompt.slice(1) + '\n' + (pathComplete ? terminalGuidance : incompletePathGuidance));
      assert.notInclude(readLog(), 'ballin:');
    });
  }
  it('stops after SIGINT at the first-backup prompt without capture or open', async () => {
    const child = spawn('/bin/bash', ['-c', 'source "$FAKE_SOURCE"; system_node_bin="$FAKE_SYSTEM_NODE"; system_git="$FAKE_ROOT/tools/git"; system_xcode_select="$FAKE_ROOT/tools/xcode-select"; trap cleanup EXIT; trap "exit 130" INT; main'], {
      cwd: home,
      env: testChildEnvironment({ HOME: home, PATH: tools, TMPDIR: path.join(root, 'tmp'), SHELL: '/bin/zsh',
        FAKE_ROOT: root, FAKE_COMMAND_LOG: log, FAKE_SOURCE: source,
        FAKE_SYSTEM_NODE: systemNode, TEST_NODE_RUNTIME: process.execPath }),
    });
    let output = '';
    let interrupted = false;
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
      if (!interrupted && output.includes('Run a backup now and open its GitHub destination? [Y/n]')) {
        interrupted = true;
        child.kill('SIGINT');
      }
    });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.stdin.write('y\n\nhome\ny\ny\n');
    try {
      const status = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code: number | null) => resolve(code));
      });
      assert.isTrue(interrupted, output);
      assert.equal(status, 130, output);
      assert.notInclude(readLog(), 'ballin:');
    } finally { clearTimeout(timeout); }
  });
  for (const existing of [false, true]) {
    it(`does not reopen an unconfigured backup after ${existing ? 'existing' : 'fresh'} installation`, () => {
      if (existing) assert.equal(run('y\ny\n', { FAKE_SKIP_BACKUP: '1' }, home, '', '').status, 0);
      fs.writeFileSync(log, '');
      const result = run(existing ? '' : 'y\ny\n', { FAKE_SKIP_BACKUP: '1', FAKE_SETUP_FAIL: '1' }, home, '', '\ny\n');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.notInclude(readLog(), 'ballin:'); assert.notInclude(result.stdout, firstBackupPrompt);
    });
  }
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
  it('uses the executable Homebrew prefix for combined consent without invoking an exported function', () => {
    const prefix = nativeBrew();
    const result = run('y\ny\ny\n', {
      FAKE_MISSING_NODE: '1', PATH: path.join(prefix, 'bin') + ':' + tools, FAKE_NATIVE_PREFIX: prefix,
    }, home, 'brew() { touch "$FAKE_ROOT/exported-brew-ran"; printf "/wrong-prefix\\n"; }; export -f brew');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, 'link the command at ' + prefix + '/bin/ballin');
    assert.isFalse(fs.existsSync(path.join(root, 'exported-brew-ran')));
  });
  it('combines missing tools and fresh Ballin consent before PATH setup', () => {
    const result = run('y\nhome\ny\nn\n', { FAKE_GIT: 'missing', FAKE_CLT_MODE: 'terminal', FAKE_RAW_INPUT: '1' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, `${cltInstallQuestion} [y/N]`);
    assert.notInclude(result.stdout, 'Native installation prompt:');
    assert.notInclude(result.stdout, "let's ball");
    const choice = result.stdout.indexOf('Set up backups to GitHub? [Y/n]');
    const detection = result.stdout.indexOf('Checking required tools');
    const preview = result.stdout.indexOf('Ballin will create ');
    const approval = result.stdout.indexOf(cltInstallQuestion);
    assert.isBelow(choice, detection);
    assert.isBelow(detection, preview);
    assert.isBelow(preview, approval);
    assert.isBelow(approval, result.stdout.indexOf('$ sudo softwareupdate --install'));
    assert.include(readLog(), 'sudo:' + path.join(tools, 'softwareupdate') + ' --install Command Line Tools for Xcode-16.4');
    assert.notInclude(readLog(), 'xcode-select:--install');
    assert.isBelow(result.stdout.indexOf('Setting up PATH'), result.stdout.indexOf('==> Installing Ballin'));
  });
  for (const answer of ['', 'yes', 'no\n', '\n']) {
    it(`makes no installation changes after combined-consent ${JSON.stringify(answer)}`, () => {
      const result = run(answer, { FAKE_MISSING_NODE: '1', FAKE_RAW_INPUT: '1' });
      assert.equal(result.status, ['no\n', '\n'].includes(answer) ? 0 : 1, result.stdout + result.stderr);
      assert.include(result.stdout, nodeInstallPrompt);
      for (const command of ['sudo:', 'curl:', 'install.sh:', 'auth login']) assert.notInclude(readLog(), command);
      assert.isFalse(fs.existsSync(path.join(home, '.ballin-scripts')));
      assert.isFalse(fs.existsSync(path.join(home, '.local/share/ballin-quickstart')));
    });
  }
  for (const mode of ['failed', 'unusable', 'interrupt', 'ambiguous']) {
    it(`preserves Xcode Command Line Tools recovery boundaries for ${mode}`, () => {
      const input = mode === 'ambiguous' ? 'y\nn\n' : 'y\n';
      const result = run(input, { FAKE_GIT: 'missing', FAKE_CLT_MODE: mode, FAKE_RAW_INPUT: '1' });
      assert.equal(result.status, mode === 'interrupt' ? 130 : 1, result.stdout + result.stderr);
      assert.notInclude(readLog(), 'install.sh:');
      assert.notInclude(readLog(), 'xcode-select:--install');
      if (mode === 'failed') assert.include(result.stderr, 'Xcode Command Line Tools installation failed.');
      if (mode === 'unusable') assert.include(result.stderr, 'Git is still unavailable.');
      if (mode === 'ambiguous') {
        assert.include(result.stdout, 'Open the graphical Xcode Command Line Tools installer? [y/N]');
        assert.notInclude(readLog(), 'sudo:');
      }
    });
  }
  it('keeps the bootstrap Node.js release line aligned with .nvmrc', () => {
    const selectedMajor = fs.readFileSync(path.resolve(__dirname, '../.nvmrc'), 'utf8').trim();
    assert.match(selectedMajor, /^[1-9][0-9]*$/, 'Select a deliberate Node.js major');
    const bootstrapMajor = fs.readFileSync(source, 'utf8').match(/https:\/\/nodejs\.org\/dist\/latest-v([0-9]+)\.x\/SHASUMS256\.txt/)?.[1];
    assert.equal(bootstrapMajor, selectedMajor);
    const minimum = require('../package.json').engines.node.replace(/^>=/u, '');
    for (const script of [source, path.resolve(__dirname, '../install.sh')]) {
      assert.equal(fs.readFileSync(script, 'utf8').match(/required_node_version='([^']+)'/u)?.[1], minimum);
    }
    assert.equal(minimum.split('.')[0], selectedMajor);
  });
  for (const shell of ['bash', 'zsh']) {
    for (const failure of ['empty', 'partial', 'helper', 'eof', 'none']) {
      it('preserves the copied command status, stdin and cleanup in ' + shell + ' after ' + failure, () => {
        const result = runCopiedCommand(shell, failure === 'eof' ? '' : 'device-code\n', {
          FAKE_QUICK_DOWNLOAD: ['empty', 'partial'].includes(failure) ? failure : 'success',
          FAKE_QUICKSTART_EXIT: failure === 'helper' ? '7' : '0',
        });
        const expected = ['empty', 'partial'].includes(failure) ? 22 : failure === 'helper' ? 7 : failure === 'eof' ? 1 : 0;
        assert.equal(result.status, expected, result.stdout + result.stderr);
        const executed = ['helper', 'eof', 'none'].includes(failure);
        assert.equal(fs.existsSync(path.join(root, 'entrypoint-ran')), executed);
        if (executed) {
          assert.include(result.stdout, 'Native fixture prompt:');
          if (failure !== 'eof') assert.include(readLog(), 'downloaded-quickstart:stdin-preserved');
        } else assert.notInclude(readLog(), 'downloaded-quickstart:started');
        if (['empty', 'partial'].includes(failure)) assert.include(result.stderr, 'Fixture curl failure');
        assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
        assert.isEmpty(fs.readdirSync(home));
        for (const prohibited of ['auth status --active', 'install.sh:', 'ballin:']) assert.notInclude(readLog(), prohibited);
      });
    }
    it(`preserves the actual quickstart entry guard in the copied ${shell} command`, () => {
      const result = runCopiedCommand(shell, '', { FAKE_QUICK_SOURCE: source, FAKE_OS: 'fixture-unsupported' });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.include(result.stderr, 'This quickstart is for macOS.');
      assert.include(readLog(), 'uname:-s');
      for (const forbidden of ['auth status', 'install.sh:', 'ballin:', 'sudo:']) assert.notInclude(readLog(), forbidden);
      assert.isEmpty(fs.readdirSync(home));
    });
    it(`does not execute a partial copied-command download with inherited options in ${shell}`, () => {
      const result = runCopiedCommand(shell, 'device-code\n', {
        FAKE_QUICK_DOWNLOAD: 'partial', s: 'inherited value',
        SHELLOPTS: 'allexport:errexit:noclobber:nounset:pipefail',
      });
      assert.equal(result.status, 22, result.stdout + result.stderr);
      assert.notInclude(readLog(), 'downloaded-quickstart:started');
      assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
      assert.isEmpty(fs.readdirSync(home));
    });
    for (const inherited of ['none', 'exported buffer', 'shell options']) {
      it(`buffers a large copied-command download in ${shell} with ${inherited}`, () => {
        const payload = path.join(root, 'quickstart-entrypoint');
        fs.appendFileSync(payload, '# Large valid script content.\n'.repeat(120000));
        const overrides = inherited === 'exported buffer' ? { s: 'inherited value' }
          : inherited === 'shell options' ? { SHELLOPTS: 'allexport:errexit:noclobber:nounset:pipefail' } : {};
        const result = runCopiedCommand(shell, 'device-code\n', overrides);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.include(readLog(), 'downloaded-quickstart:stdin-preserved');
        assert.isEmpty(fs.readdirSync(path.join(root, 'tmp')));
        assert.isEmpty(fs.readdirSync(home));
      });
    }
  }
  for (const scenario of ['capture', 'backup-declined', 'setup-skipped', 'sign-in-skipped', 'install-declined', 'install-failed', 'backup-failed', 'open-failed', 'cancelled', 'path-incomplete', 'path-incomplete-cancelled']) {
    it(`prints final terminal guidance only after successful Quickstart: ${scenario}`, () => {
      const overrides: NodeJS.ProcessEnv = {
        FAKE_SKIP_BACKUP: scenario === 'setup-skipped' ? '1' : '0',
        FAKE_AUTH: scenario === 'sign-in-skipped' ? 'missing' : 'ready',
        FAKE_INSTALL_FAIL: scenario === 'install-failed' ? '1' : '0',
        FAKE_BACKUP_FAIL: scenario === 'backup-failed' ? '1' : '0',
        FAKE_OPEN_FAIL: scenario === 'open-failed' ? '1' : '0',
        FAKE_EARLY_ANSWER: scenario === 'sign-in-skipped' ? 'no\n' : 'yes\n',
      };
      const input = scenario === 'sign-in-skipped' ? 'y\ny\n'
        : scenario === 'install-declined' ? 'y\nn\n'
        : scenario.startsWith('path-incomplete') ? 'n\ny\n' : 'y\ny\n';
      const backupInput = scenario === 'backup-declined' ? 'n\n' : scenario === 'setup-skipped' ? '\nn\n' : ['cancelled', 'path-incomplete-cancelled'].includes(scenario) ? '' : '\n';
      const result = run(input, overrides, home, '', backupInput);
      const succeeds = !['install-failed', 'backup-failed', 'open-failed'].includes(scenario);
      assert.equal(result.status, succeeds ? 0 : 1, result.stdout + result.stderr);
      const expected = succeeds && scenario !== 'install-declined' && !scenario.startsWith('path-incomplete');
      assert.equal(result.stdout.split(terminalGuidanceMessage).length - 1, expected ? 1 : 0, result.stdout);
      assert.equal(result.stdout.split(incompletePathGuidance).length - 1, scenario.startsWith('path-incomplete') ? 1 : 0, result.stdout);
      if (scenario === 'backup-declined') {
        assert.equal(result.stdout.slice(result.stdout.indexOf(firstBackupPrompt)), firstBackupPrompt + '\n' + terminalGuidance);
      } else if (expected) assert.isTrue(result.stdout.endsWith(`\n${terminalGuidance}`), result.stdout);
      assert.notInclude(result.stdout, 'Tools are ready');
      assert.notInclude(result.stdout, 'Continue setup here');
      if (scenario === 'capture') assert.include(readLog(), 'ballin:backup\nballin:backup open\n');
      if (scenario.startsWith('path-incomplete')) {
        assert.equal(result.stdout.slice(result.stdout.indexOf(firstBackupPrompt)), firstBackupPrompt + (scenario.endsWith('cancelled') ? '\n' : '\n\n') + incompletePathGuidance);
        assert.include(result.stdout, 'PATH setup skipped.');
        assert.equal(result.stderr, '');
      }
    });
  }
  for (const preceding of ['early choice', 'prerequisites', 'PATH consent', 'PATH warning', 'authentication', 'backups skipped']) {
    it(`separates installer output only after Quickstart output: ${preceding}`, () => {
      const installed = run();
      assert.equal(installed.status, 0, installed.stdout + installed.stderr);
      const overrides: NodeJS.ProcessEnv = { PATH: `${tools}:${path.join(home, '.local/bin')}` };
      let input = '';
      if (preceding === 'prerequisites') { overrides.FAKE_GIT = 'missing'; input = 'y\n\n'; }
      if (preceding === 'PATH consent') { overrides.PATH = tools; fs.unlinkSync(path.join(home, '.zshrc')); input = 'y\n'; }
      if (preceding === 'PATH warning') { overrides.PATH = tools; overrides.SHELL = '/bin/sh'; }
      if (preceding === 'authentication' || preceding === 'backups skipped') {
        overrides.FAKE_AUTH = 'missing';
        input = preceding === 'authentication' ? 'device-code\n' : '';
        if (preceding === 'backups skipped') overrides.FAKE_EARLY_ANSWER = 'no\n';
      }
      // Merge streams so warnings participate in the visible output order.
      const result = run(input, overrides, home, 'exec 2>&1', 'n\n');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const banner = "==> Installing Ballin\n";
      {
        const previous = {
          'early choice': 'Set up backups to GitHub? [Y/n]',
          prerequisites: 'Install Xcode Command Line Tools?', 'PATH consent': 'so it works in new Terminal windows? [y/N]',
          'PATH warning': 'Persistent PATH setup incomplete:', authentication: 'Native login prompt:',
          'backups skipped': 'Backup setup skipped.',
        }[preceding];
        assert.include(result.stdout, previous);
        assert.isBelow(result.stdout.indexOf(previous), result.stdout.indexOf(banner));
        const separator = ['early choice', 'prerequisites', 'authentication', 'backups skipped'].includes(preceding) ? '\n' : '\n\n';
        assert.include(result.stdout, separator + banner);
      }
      assert.equal(result.stdout.split('Setup complete!').length - 1, preceding === 'PATH warning' ? 0 : 1);
    });
  }
  const pathLine = () => `export PATH=$PATH:'${path.join(home, '.local/bin')}'`;
  const runPathSetup = (input: string, overrides: NodeJS.ProcessEnv = {}) => spawnSync('/bin/bash', ['-c', `
    source "$FAKE_SOURCE"
    node_tool="$TEST_NODE_RUNTIME"
    quick_bin="$HOME/.local/share/ballin-quickstart/bin"
    command_path="$HOME/.local/bin"
    git_tool="$HOME/selected/git"; gh_tool=''; npm_tool=''
    original_normalized_path=$PATH
    scratch=$(mktemp -d "$TMPDIR/path-only.XXXXXX")
    trap cleanup EXIT
    tools_need_helper() { return 1; }
    configure_path
  `], { encoding: 'utf8', input, cwd: home, env: testChildEnvironment({
    HOME: home, PATH: tools, TMPDIR: path.join(root, 'tmp'), SHELL: '/bin/zsh',
    FAKE_SOURCE: source, TEST_NODE_RUNTIME: process.execPath, ...overrides,
  }) });
  for (const input of ['\n', '']) {
    it(`silently skips Bash startup selection on ${input ? 'Enter' : 'EOF'} without editing files`, () => {
      const profile = path.join(home, '.bash_profile');
      const contents = `touch "${root}/startup-ran"\n# Existing settings\n`;
      fs.writeFileSync(profile, contents, { mode: 0o640 });
      const result = runPathSetup(input, { SHELL: '/bin/bash' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, 'PATH setup skipped.');
      assert.notInclude(result.stdout, 'Add Ballin setup');
      assert.equal(result.stderr, '');
      assert.equal(fs.readFileSync(profile, 'utf8'), contents);
      assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
      assert.isFalse(fs.existsSync(path.join(home, '.bashrc')));
      assert.isFalse(fs.existsSync(path.join(root, 'startup-ran')));
    });
  }
  it('retains the manual warning for an invalid Bash startup selection', () => {
    const result = runPathSetup('other\n', { SHELL: '/bin/bash' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stderr, 'No Bash startup file selected.');
    assert.include(result.stderr, 'The startup file was left unchanged.');
    assert.include(result.stderr, 'Review your shell startup and PATH setup');
    assert.notInclude(result.stdout, 'PATH setup skipped.');
    for (const profile of ['.bash_profile', '.bashrc']) assert.isFalse(fs.existsSync(path.join(home, profile)));
  });
  for (const initial of ['', '# Existing settings\n', '# No final newline']) {
    it(`accepts Enter for home and preserves correct PATH separation: ${JSON.stringify(initial)}`, () => {
      const profile = path.join(home, '.zshrc'); fs.writeFileSync(profile, initial);
      const result = runPathSetup('home\ny\n'); assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stdout, `Add Ballin setup to ${profile} so it works in new Terminal windows?`);
      assert.equal(fs.readFileSync(profile, 'utf8'), initial + (initial ? '\n' : '') + pathLine() + '\n');
      const retry = runPathSetup('home\n'); assert.equal(retry.status, 0, retry.stdout + retry.stderr);
      assert.notInclude(retry.stdout, 'PATH entry already present');
      assert.notInclude(retry.stdout, 'Directory containing'); assert.notInclude(retry.stdout, 'Add this PATH line');
    });
  }
  for (const value of [
    'export PATH="$HOME/.local/share/ballin-quickstart/bin:$PATH:$HOME/.local/bin"',
    '# Existing path: ~/.local/bin',
    'export PATH="${HOME}/.local/bin:$PATH"',
    'export PATH="$HOME"/.local/bin:$PATH',
    'export PATH="$HOME/.local/share/ballin-quickstart/bin:$PATH"\r',
  ]) {
    it(`requests manual PATH review for directory references without executing startup code: ${value}`, () => {
      const profile = path.join(home, '.zshrc');
      const contents = `touch "${root}/startup-ran"\n${value}\n`;
      fs.writeFileSync(profile, contents);
      const result = runPathSetup('home\ny\n'); assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stderr, 'already mentions a setup directory');
      assert.include(result.stderr, 'Review its PATH entries before changing PATH.');
      assert.include(result.stderr, 'Manual setup: https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md#manual-path-setup');
      assert.notInclude(result.stderr, 'command below');
      assert.notInclude(result.stdout, 'PATH entry already present; activation not verified.'); assert.notInclude(result.stdout, 'Add this PATH line');
      assert.notInclude(result.stderr, pathLine());
      assert.equal(fs.readFileSync(profile, 'utf8'), contents); assert.isFalse(fs.existsSync(path.join(root, 'startup-ran')));
    });
  }
  for (const suffix of ['/', '/.']) {
    it(`requests manual review of home-relative references with HOME ending in ${suffix}`, () => {
      const profile = path.join(home, '.zshrc');
      const contents = 'export PATH="$HOME/.local/bin:$PATH"\n'; fs.writeFileSync(profile, contents);
      const result = runPathSetup('\ny\n', { HOME: home + suffix });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stderr, 'already mentions a setup directory');
      assert.notInclude(result.stdout, 'Add this PATH line');
      assert.equal(fs.readFileSync(profile, 'utf8'), contents);
    });
  }
  it('requires review of a referenced Bash rc directory while preserving startup selection', () => {
    const profile = path.join(home, '.bashrc');
    const contents = 'export PATH="$HOME/.local/share/ballin-quickstart/bin:$PATH:$HOME/.local/bin"\n';
    fs.writeFileSync(profile, contents);
    const result = runPathSetup('bashrc\ny\n', { SHELL: '/bin/bash' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, 'Which Bash startup file'); assert.include(result.stderr, 'already mentions a setup directory');
    assert.notInclude(result.stdout, 'PATH entry already present; activation not verified.'); assert.notInclude(result.stdout, 'Add this PATH line');
    assert.equal(fs.readFileSync(profile, 'utf8'), contents);
  });
  it('permits an explicit custom target when the default directory needs manual review', () => {
    fs.writeFileSync(path.join(home, '.zshrc'), '# ~/.local/bin requires review\n');
    const directory = path.join(home, 'custom-startup'); fs.mkdirSync(directory);
    const result = runPathSetup(directory + '\ny\n');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(path.join(directory, '.zshrc'), 'utf8'), pathLine() + '\n');
    assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), '# ~/.local/bin requires review\n');
  });
  it('accepts a custom exported ZDOTDIR default, explicit home override, and skip', () => {
    const directory = path.join(home, 'zsh'); fs.mkdirSync(directory);
    const selected = runPathSetup(directory + '\ny\n', { ZDOTDIR: directory }); assert.equal(selected.status, 0, selected.stderr);
    assert.include(selected.stdout, `Add Ballin setup to ${directory}/.zshrc so it works in new Terminal windows?`);
    assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
    const skipped = runPathSetup('skip\n'); assert.equal(skipped.status, 0, skipped.stderr);
    assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
    const homeSelected = runPathSetup('home\ny\n', { ZDOTDIR: path.join(home, 'missing') });
    assert.equal(homeSelected.status, 0, homeSelected.stderr); assert.isTrue(fs.existsSync(path.join(home, '.zshrc')));
  });
  for (const answer of ['no\n', '']) {
    it(`skips backup-only sign-in after early answer ${JSON.stringify(answer)}`, () => {
      const result = run(answer ? 'y\ny\n' : '', { FAKE_AUTH: 'missing', FAKE_EARLY_ANSWER: answer }, home, '', answer ? 'y\n' : '');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.notInclude(readLog(), 'gh:'); assert.notInclude(readLog(), 'ballin:');
      if (answer) assert.include(result.stdout, 'Backup setup skipped.');
      else { assert.include(result.stdout, 'Quickstart stopped.'); assert.notInclude(readLog(), 'install.sh:'); }
    });
  }
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
      assert.include(result.stderr, 'Persistent PATH setup incomplete:');
      assert.notInclude(result.stdout, 'so it works in new Terminal windows? [y/N]');
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
    // Each literal profile form has its own initial-run/retry workflow and fixture.
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
      it(`appends to normal custom ${shell} profiles without executing or interpreting commands: ${JSON.stringify(form)}`, () => {
        const profile = path.join(home, profileName);
        const sentinel = path.join(root, 'profile-executed');
        const contents = `touch '${sentinel}'\n${form}\n`;
        fs.writeFileSync(profile, contents, { mode: 0o640 });
        const result = run('y\ny\n', { SHELL: '/bin/' + shell });
        assert.equal(result.status, 0, form + result.stdout + result.stderr);
        assert.equal(fs.readFileSync(profile, 'utf8'), contents + '\n' + pathLine() + '\n');
        assert.equal(fs.statSync(profile).mode & 0o777, 0o640);
        assert.notInclude(result.stdout, 'PATH line added');
        assert.notInclude(result.stdout, 'In your original Terminal');
        assert.notInclude(result.stdout, 'Tools are ready');
        assert.isFalse(fs.existsSync(sentinel));
        const retry = run('', { SHELL: '/bin/' + shell });
        assert.equal(retry.status, 0, retry.stdout + retry.stderr);
        assert.notInclude(retry.stdout, 'PATH entry already present');
        assert.notInclude(retry.stdout, 'which startup file your terminal reads');
        assert.notInclude(retry.stdout, 'so it works in new Terminal windows? [y/N]');
        assert.equal(fs.readFileSync(profile, 'utf8'), contents + '\n' + pathLine() + '\n');
        assert.include(readLog(), 'ballin:backup\nballin:backup open\n');
      });
    }
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
        assert.notInclude(result.stdout, 'PATH entry already present');
        assert.notInclude(result.stdout, 'which startup file your terminal reads');
        assert.notInclude(result.stdout, 'so it works in new Terminal windows? [y/N]');
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
        assert.notInclude(result.stdout, 'so it works in new Terminal windows? [y/N]');
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
    assert.include(first.stdout, 'PATH setup skipped.');
    assert.equal(fs.readFileSync(profile, 'utf8'), '# Existing settings\n');
    assert.include(readLog(), 'ballin:backup open');
    const retry = run('y\n');
    assert.equal(retry.status, 0, retry.stdout + retry.stderr);
    assert.notInclude(retry.stdout, 'PATH line added');
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
    assert.equal(fresh.stdout, `${tools}:${home}/.local/bin`);
  });
  it('uses the selected Bash rc or existing login target without hiding the login chain', () => {
    fs.writeFileSync(path.join(home, '.profile'), '# Login\n');
    const result = run('y\ny\n', { SHELL: '/bin/bash', FAKE_PROFILE_TARGET: 'bashrc' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.isTrue(fs.existsSync(path.join(home, '.bashrc')));
    assert.isFalse(fs.existsSync(path.join(home, '.bash_profile')));
    assert.equal(fs.readFileSync(path.join(home, '.profile'), 'utf8'), '# Login\n');
  });
  it('offers the conventional directory for empty ZDOTDIR and permits an explicit custom target', () => {
    const profile = path.join(home, '.zshrc');
    const declined = runPathSetup('\nn\n', { ZDOTDIR: '' });
    assert.equal(declined.status, 0, declined.stdout + declined.stderr);
    assert.include(declined.stdout, `Zsh settings directory [Enter for ${home}, another absolute directory, or skip]:`);
    assert.include(declined.stdout, `Add Ballin setup to ${profile}`);
    assert.isFalse(fs.existsSync(profile));
    const directory = path.join(home, 'actual-zsh'); fs.mkdirSync(directory);
    const selected = runPathSetup(directory + '\ny\n', { ZDOTDIR: '' });
    assert.equal(selected.status, 0, selected.stdout + selected.stderr);
    assert.include(selected.stdout, `Add Ballin setup to ${directory}/.zshrc`);
    assert.isTrue(fs.existsSync(path.join(directory, '.zshrc')));
    assert.isFalse(fs.existsSync(profile));
  });
  for (const choice of ['skip\n', '']) {
    it(`leaves PATH files unchanged after Zsh location ${choice ? 'skip' : 'EOF'}`, () => {
      const result = runPathSetup(choice);
      assert.equal(result.status, 0, result.stderr);
      assert.notInclude(result.stdout, 'Add Ballin setup');
      assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
    });
  }
  it('accepts the suggested directory without treating selection as permission and reuses only that choice', () => {
    const result = runPathSetup('\nn\n', { ZDOTDIR: 'relative' });
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, `Zsh settings directory [Enter for ${home}, another absolute directory, or skip]: `);
    assert.include(result.stdout, `Add Ballin setup to ${home}/.zshrc`);
    assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
  });
  for (const selectedShell of ['', 'bash', '/missing/bash', '/bin/sh']) {
    it(`continues first backup when persistent setup has unavailable shell ${JSON.stringify(selectedShell)}`, () => {
      const result = run('y\n', { SHELL: selectedShell });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.include(result.stderr, 'Persistent PATH setup incomplete:');
      assert.notInclude(result.stderr, pathLine());
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
      assert.include(result.stderr, 'Persistent PATH setup incomplete:');
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
  if [[ "$1" == "Add Ballin setup to $HOME/.zshrc so it works in new Terminal windows?" ]]; then ln "$HOME/.zshrc" "$HOME/dotfiles-startup"; fi
}
`);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, 'so it works in new Terminal windows? [y/N]');
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
      assert.include(result.stderr, mutation === 'bytes' ? 'The startup file changed or could not be copied.' : 'The startup file changed during setup.');
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
      assert.include(result.stdout, 'PATH setup skipped.');
      assert.notInclude(readLog(), 'ballin:backup open');
      assert.isFalse(fs.existsSync(path.join(home, '.zshrc')));
      assert.notInclude(result.stdout, terminalGuidance);
      assert.notInclude(result.stdout, incompletePathGuidance);
    });
  }
  for (const [answer, expected] of [['', 'github.com'], ['GIT.EXAMPLE.COM', 'git.example.com'], ['fixture.ghe.com', 'fixture.ghe.com']]) {
    it(`selects ${expected} once before authentication and installer handoff`, () => {
      const result = run('y\ny\n', { FAKE_HOST_ANSWER: answer });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.lengthOf(result.stdout.match(/GitHub hostname \[github.com\]:/gu) ?? [], 1);
      assert.include(readLog(), `gh:auth status --active --hostname ${expected}`);
      assert.include(readLog(), `installer-host:${expected}`);
      assert.isBelow(readLog().indexOf('gh:auth status --active'), readLog().indexOf('install.sh:'));
    });
  }
  for (const hostname of ['https://git.example.com', 'git.example.com:443', 'bad_host', 'K.example.com']) {
    it(`refuses invalid Quickstart hostname ${hostname} before authentication`, () => {
      const result = run('y\ny\n', { FAKE_HOST_ANSWER: hostname });
      assert.equal(result.status, 1);
      assert.notInclude(readLog(), 'gh:auth status --active');
      assert.notInclude(readLog(), 'install.sh:');
    });
  }
  for (const status of ['1', '130', '143']) {
    it(`preserves custom-host login failure ${status} without installation`, () => {
      const result = run('y\ny\n', { FAKE_HOST_ANSWER: 'git.example.com', FAKE_AUTH: 'missing', FAKE_GH_LOGIN_FAILURE: status });
      assert.equal(result.status, Number(status), result.stdout + result.stderr);
      assert.include(readLog(), 'gh:auth login --hostname git.example.com --git-protocol https --web');
      assert.notInclude(readLog(), 'install.sh:');
    });
  }
  it('ignores an inherited hostname when backups are declined', () => {
    const result = run('y\ny\n', { FAKE_EARLY_ANSWER: 'no\n', BALLIN_BACKUP_HOSTNAME: 'wrong.example.com' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.notInclude(result.stdout, 'GitHub hostname [');
    assert.notInclude(readLog(), 'gh:auth status --active');
    assert.include(readLog(), 'installer-host:\n');
  });
  it('stops on hostname EOF without sign-in or installation', () => {
    const result = run('', { FAKE_RAW_INPUT: '1' }, home, '', '');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.include(result.stdout, 'GitHub hostname [github.com]:');
    assert.notInclude(readLog(), 'gh:auth status --active');
    assert.notInclude(readLog(), 'install.sh:');
  });
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
  for (const choice of ['maintenance', 'final-no', 'final-eof', 'analytics-eof', 'capture']) {
    it(`keeps the guarded piped ${choice} journey within its approved choices`, () => {
      const sandbox = createSandbox({ quickstart: true });
      try {
        const prefix = choice === 'maintenance' ? 'no\n' : 'yes\n';
        const core = (choice === 'maintenance' ? '' : '\n') + 'login\nyes\nyes\n';
        const answers = choice === 'analytics-eof' ? '' : 'no\nlogin\nno\n';
        const setup = choice === 'maintenance' || choice === 'analytics-eof' ? ''
          : 'create\n\nno\n' + (choice === 'final-no' ? 'no\n' : choice === 'final-eof' ? '' : 'yes\nno\nyes\n');
        const result = runSandbox(sandbox, ['quickstart'], prefix + core + answers + setup);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(result.stdout.split(terminalGuidanceMessage).length - 1, 1);
        assert.notInclude(result.stdout, 'Set up private backups to GitHub?');
        assert.notInclude(result.stdout, 'Usage analytics:'); assert.notInclude(result.stdout, 'Backup setup complete.');
        assert.isTrue(fs.lstatSync(path.join(sandbox.bin, 'ballin')).isSymbolicLink());
        const config = JSON.parse(fs.readFileSync(path.join(sandbox.repo, 'ballin.config.json'), 'utf8'));
        const state = JSON.parse(fs.readFileSync(path.join(sandbox.remote, 'repository.json'), 'utf8'));
        const publishes = state.requests.filter((request: { payload?: { query?: string } }) => request.payload?.query?.includes('BallinPublish'));
        const opens = state.requests.filter((request: { endpoint?: string }) => request.endpoint === 'open');
        if (choice === 'capture') {
          assert.include(result.stdout, 'Private backup created:');
          assert.include(result.stdout, 'Create this private GitHub backup without sensitive sources? [y/N]');
          assert.equal(config.backup.includeSensitive, 'false');
          assert.lengthOf(publishes, 2); assert.lengthOf(opens, 1);
          assert.isAbove(state.requests.indexOf(opens[0]), state.requests.indexOf(publishes[1]));
        } else {
          assert.isUndefined(config.backup.repository); assert.isEmpty(publishes); assert.isEmpty(opens);
          assert.notInclude(result.stdout, 'Run a backup now and open');
          if (choice.startsWith('final-')) assert.include(result.stdout, 'Backup setup cancelled.');
          if (choice === 'analytics-eof') assert.notInclude(result.stdout.slice(result.stdout.indexOf('Analytics details:')), 'Which Bash startup file');
        }
      } finally { cleanupSandbox(sandbox.root); }
    });
  }
  for (const configure of [true, false]) {
    it(`honors early Yes when rerunning guarded Quickstart after maintenance-only setup (configure: ${configure})`, () => {
      const sandbox = createSandbox({ quickstart: true });
      try {
        const maintenance = runSandbox(sandbox, ['quickstart'], 'no\nlogin\nyes\nyes\nno\nlogin\nno\n');
        assert.equal(maintenance.status, 0, maintenance.stdout + maintenance.stderr);
        const configPath = path.join(sandbox.repo, 'ballin.config.json');
        const previousConfig = fs.readFileSync(configPath, 'utf8');
        assert.isUndefined(JSON.parse(previousConfig).backup.repository);
        const result = runSandbox(sandbox, ['quickstart'], `yes\n\ncreate\n\nno\n${configure ? 'yes\nno\nno\n' : 'no\n'}`);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.lengthOf(result.stdout.match(/Create a new backup or reconnect to an existing one\?/gu) ?? [], 1);
        assert.notInclude(result.stdout, 'Set up private backups to GitHub?');
        assert.include(result.stdout, 'Create this private GitHub backup without sensitive sources? [y/N]', result.stdout + result.stderr);
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const remote = JSON.parse(fs.readFileSync(path.join(sandbox.remote, 'repository.json'), 'utf8'));
        assert.equal(remote.requests.filter((r: { endpoint: string }) => r.endpoint === 'open').length, 0);
        if (configure) {
          assert.isObject(config.backup.repository); assert.isTrue(remote.exists);
          assert.include(result.stdout, 'Run a backup now and open');
          assert.equal(remote.requests.filter((r: { endpoint: string }) => r.endpoint === 'user/repos').length, 1);
        } else {
          assert.equal(fs.readFileSync(configPath, 'utf8'), previousConfig);
          assert.isFalse(remote.exists);
          assert.notInclude(result.stdout, 'Run a backup now and open');
          assert.equal(remote.requests.filter((r: { endpoint: string }) => r.endpoint === 'user/repos').length, 0);
        }
      } finally { cleanupSandbox(sandbox.root); }
    });
  }
  for (const host of ['github.com', 'git.example.com', 'fixture.ghe.com']) {
    it(`hands ${host} from the single Quickstart prompt through real setup and capture`, () => {
      const sandbox = createSandbox({ quickstart: true });
      try {
        const file = path.join(sandbox.remote, 'repository.json');
        const state = JSON.parse(fs.readFileSync(file, 'utf8')); state.host = host; fs.writeFileSync(file, JSON.stringify(state));
        const result = runSandbox(sandbox, ['quickstart'], `yes\n${host}\nlogin\nyes\nyes\nno\nlogin\nno\ncreate\n\nno\nyes\nno\nyes\n`);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.lengthOf(result.stdout.match(/GitHub hostname \[github.com\]:/gu) ?? [], 1);
        const config = JSON.parse(fs.readFileSync(path.join(sandbox.repo, 'ballin.config.json'), 'utf8'));
        assert.equal(config.backup.repository.host, host);
        const remote = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.isTrue(remote.requests.filter((r: { endpoint: string }) => r.endpoint !== 'open').every((r: { host: string; environmentHost: string }) => r.host === host && r.environmentHost === host));
        assert.lengthOf(remote.requests.filter((r: { endpoint: string }) => r.endpoint === 'open'), 1);
        if (host === 'github.com') {
          delete config.backup.repository.host; config.backup.host = 'stale.example.com';
          fs.writeFileSync(path.join(sandbox.repo, 'ballin.config.json'), JSON.stringify(config));
        }
        const rerun = runSandbox(sandbox, ['quickstart'], 'yes\nno\n');
        assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
        assert.notInclude(rerun.stdout, 'GitHub hostname [');
        assert.equal(require('../commands/backup_config.ts').configuredBackupDestination(JSON.parse(fs.readFileSync(path.join(sandbox.repo, 'ballin.config.json'), 'utf8'))).repository.host, host);
      } finally { cleanupSandbox(sandbox.root); }
    });
  }
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
      const result = runSandbox(sandbox, ['quickstart'], 'yes\n\nlogin\nyes\nyes\nno\nlogin\nyes\ncreate\n\nyes\nyes\nno\nyes\n');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.notInclude(result.stdout, 'PATH line added');
      assert.notInclude(result.stdout, 'Tab completion enabled.');
      assert.equal(result.stdout.split(terminalGuidanceMessage).length - 1, 1);
      assert.isTrue(result.stdout.endsWith(terminalGuidance), result.stdout);
      assert.match(result.stdout.slice(0, -terminalGuidance.length), /Opened [^\n]+\n$/u);
      assert.include(result.stdout, 'Backup source details:');
      assert.include(result.stdout, 'create');
      assert.isTrue(fs.lstatSync(path.join(sandbox.bin, 'ballin')).isSymbolicLink());
      const contents = fs.readFileSync(profile, 'utf8');
      assert.include(contents, "export PATH=$PATH:'");
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
      assert.include(fresh.stdout, sandbox.tools + '/git');
      assert.include(fresh.stdout, sandbox.tools + '/gh');
      assert.include(fresh.stdout, 'complete -F _ballin_completion ballin');
      const retry = runSandbox(sandbox, ['quickstart'], 'yes\nno\n');
      assert.equal(retry.status, 0, retry.stdout + retry.stderr);
      assert.notInclude(retry.stdout, 'PATH entry already present');
      assert.include(retry.stdout, '\nValidated private backup:');
      assert.equal(fs.readFileSync(profile, 'utf8'), contents);
      const managedGit = path.join(sandbox.home, '.local/share/ballin-quickstart/bin/git');
      fs.unlinkSync(managedGit);
      fs.symlinkSync(path.join(sandbox.tools, 'node'), managedGit);
      assert.throws(() => sandboxEnvironment(sandbox), /Quickstart tool was changed/u);
    } finally { cleanupSandbox(sandbox.root); }
  });
});
