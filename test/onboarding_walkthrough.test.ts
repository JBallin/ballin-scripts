const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const installPath = path.join(repoRoot, 'install.sh');

describe('first-run onboarding walkthroughs', () => {
  let testDir: string;
  let homeDir: string;
  let toolDir: string;
  let userBinDir: string;
  let installedRepoDir: string;
  let commandLogPath: string;
  let remoteGistDir: string;
  let scratchDir: string;

  const createdGistId = 'walkthrough-created-gist-id';

  const commandPath = (name: string): string => {
    const resolved = (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((directory) => path.join(directory, name))
      .find((candidate) => fs.existsSync(candidate));
    assert.exists(resolved, `${name} is required for the walkthrough harness`);
    return resolved as string;
  };

  const linkCommand = (name: string): void => {
    fs.symlinkSync(commandPath(name), path.join(toolDir, name));
  };

  const writeExecutable = (name: string, contents: string): void => {
    fs.writeFileSync(path.join(toolDir, name), contents, { mode: 0o755 });
  };

  const installGitStub = (): void => {
    writeExecutable('git', `#!/usr/bin/env bash
printf 'git:%s\\n' "$*" >> "$BALLIN_WALKTHROUGH_LOG"
case "$1" in
  --version)
    printf '%s\\n' 'git version walkthrough'
    ;;
  clone)
    if [ "$2:$3" != 'https://github.com/JBallin/ballin-scripts.git:.ballin-scripts' ]; then exit 2; fi
    mkdir -p "$HOME/.ballin-scripts"
    cp -R "$BALLIN_WALKTHROUGH_SOURCE/commands" "$HOME/.ballin-scripts/commands"
    cp -R "$BALLIN_WALKTHROUGH_SOURCE/config" "$HOME/.ballin-scripts/config"
    cp -R "$BALLIN_WALKTHROUGH_SOURCE/bin" "$HOME/.ballin-scripts/bin"
    cp "$BALLIN_WALKTHROUGH_SOURCE/package.json" "$HOME/.ballin-scripts/package.json"
    ;;
  rev-parse)
    exit 1
    ;;
  fetch|checkout|merge|stash)
    exit 0
    ;;
  *)
    printf 'unexpected git command: %s\\n' "$*" >&2
    exit 2
    ;;
esac
`);
  };

  const installGhStub = (): void => {
    writeExecutable('gh', `#!/usr/bin/env bash
printf 'gh:%s\\n' "$*" >> "$BALLIN_WALKTHROUGH_LOG"
if [ "$1:$2" = 'auth:status' ]; then
  if [ "$*" != 'auth status --hostname github.com' ]; then exit 2; fi
  exit 0
fi
if [ "$1:$2" = 'gist:create' ]; then
  if [ "$3:$4" != '.MyConfig.md:--desc' ]; then exit 2; fi
  cp "$PWD/.MyConfig.md" "$BALLIN_WALKTHROUGH_GIST/.MyConfig.md"
  printf 'https://gist.github.com/%s\\n' "$BALLIN_WALKTHROUGH_GIST_ID"
  exit 0
fi
if [ "$1:$2" = 'gist:view' ]; then
  if [ "$3" != "$BALLIN_WALKTHROUGH_GIST_ID" ]; then exit 2; fi
  if [ "$4" = '--web' ] && [ "$#" -eq 4 ]; then exit 0; fi
  if [ "$4" = '--files' ] && [ "$#" -eq 4 ]; then
    for remote_file in "$BALLIN_WALKTHROUGH_GIST"/*; do
      if [ -f "$remote_file" ]; then printf '%s\\n' "\${remote_file##*/}"; fi
    done
    exit 0
  fi
  if [ "$4:$5" = '--raw:--filename' ] && [ "$#" -eq 6 ]; then
    if [ -f "$BALLIN_WALKTHROUGH_GIST/$6" ]; then
      cat "$BALLIN_WALKTHROUGH_GIST/$6"
      exit 0
    fi
    exit 1
  fi
  exit 2
fi
if [ "$1" = 'api' ]; then
  if [ "$2:$3:$4:$6" != "--hostname:github.com:--method:gists/$BALLIN_WALKTHROUGH_GIST_ID" ]; then exit 2; fi
  if [ "$5" = 'GET' ] && [ "$#" -eq 6 ]; then
    node -e 'const fs = require("fs"); const path = require("path"); const dir = process.argv[1]; const files = {}; for (const name of fs.readdirSync(dir)) { const file = path.join(dir, name); if (!fs.statSync(file).isFile()) continue; const content = fs.readFileSync(file, "utf8"); files[name] = { filename: name, size: Buffer.byteLength(content), truncated: false, content }; } process.stdout.write(JSON.stringify({ files, truncated: false }) + "\\n");' "$BALLIN_WALKTHROUGH_GIST"
    exit $?
  fi
  if [ "$5" = 'PATCH' ] && [ "$7" = '--input' ] && [ "$9" = '--silent' ] && [ "$#" -eq 9 ]; then
    node -e 'const fs = require("fs"); const path = require("path"); const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const dir = process.argv[2]; for (const [name, value] of Object.entries(payload.files)) fs.writeFileSync(path.join(dir, name), value.content);' "$8" "$BALLIN_WALKTHROUGH_GIST"
    exit $?
  fi
fi
exit 2
`);
  };

  const childEnv = (): NodeJS.ProcessEnv => ({
    HOME: homeDir,
    PATH: [toolDir, userBinDir].join(path.delimiter),
    TMPDIR: scratchDir,
    BALLIN_NO_ANALYTICS: '1',
    BALLIN_UNINSTALL_TEST_SYSTEM_ROOT: path.join(testDir, 'system'),
    BALLIN_WALKTHROUGH_GIST: remoteGistDir,
    BALLIN_WALKTHROUGH_GIST_ID: createdGistId,
    BALLIN_WALKTHROUGH_LOG: commandLogPath,
    BALLIN_WALKTHROUGH_SOURCE: repoRoot,
  });

  const runInstaller = (input: string) => spawnSync(installPath, [], {
    encoding: 'utf8',
    env: childEnv(),
    input,
  });

  const runInstalled = (args: string[]) => spawnSync(path.join(userBinDir, 'ballin'), args, {
    encoding: 'utf8',
    env: childEnv(),
  });

  const commandLog = (): string => (
    fs.existsSync(commandLogPath) ? fs.readFileSync(commandLogPath, 'utf8') : ''
  );

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-onboarding-walkthrough-'));
    homeDir = path.join(testDir, 'home');
    toolDir = path.join(testDir, 'tools');
    userBinDir = path.join(homeDir, '.local', 'bin');
    installedRepoDir = path.join(homeDir, '.ballin-scripts');
    commandLogPath = path.join(testDir, 'commands.log');
    remoteGistDir = path.join(testDir, 'remote-gist');
    scratchDir = path.join(testDir, 'tmp');

    [homeDir, toolDir, userBinDir, remoteGistDir, scratchDir].forEach((directory) => {
      fs.mkdirSync(directory, { recursive: true });
    });
    ['bash', 'cat', 'cmp', 'cp', 'ls', 'mkdir', 'mktemp', 'rm', 'tail'].forEach(linkCommand);
    fs.symlinkSync(process.execPath, path.join(toolDir, 'node'));
    installGitStub();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('preserves one maintenance-only install through doctor, update, self-update, and backup guidance', () => {
    const installResult = runInstaller('y\nn\n');

    assert.equal(installResult.status, 0, installResult.stderr);
    assert.include(installResult.stdout, 'Installation plan');
    assert.include(installResult.stdout, 'Backup setup skipped. Run ballin backup setup');
    assert.isTrue(fs.lstatSync(path.join(userBinDir, 'ballin')).isSymbolicLink());
    assert.isNull(JSON.parse(fs.readFileSync(path.join(installedRepoDir, 'ballin.config.json'), 'utf8')).backup.id);

    const doctorResult = runInstalled(['doctor']);
    const verboseDoctorResult = runInstalled(['doctor', '--verbose']);
    assert.equal(doctorResult.status, 0, doctorResult.stderr);
    assert.equal(doctorResult.stdout, '😎 You\'re ballin.\n');
    assert.equal(verboseDoctorResult.status, 0, verboseDoctorResult.stderr);
    assert.include(verboseDoctorResult.stdout, 'INFO  Optional Gist backup');
    assert.include(verboseDoctorResult.stdout, 'ballin backup setup');

    [
      ['update.cleanup', 'false'],
      ['update.selfUpdate', 'false'],
      ['update.softwareupdate', 'false'],
    ].forEach(([key, value]) => {
      const configResult = runInstalled(['config', 'set', key, value]);
      assert.equal(configResult.status, 0, configResult.stderr);
    });

    const updateResult = runInstalled(['update']);
    const selfUpdateResult = runInstalled(['self-update']);
    const backupResult = runInstalled(['backup']);
    assert.equal(updateResult.status, 0, updateResult.stderr);
    assert.equal(selfUpdateResult.status, 0, selfUpdateResult.stderr);
    assert.include(selfUpdateResult.stdout, '😎 ballin!');
    assert.equal(backupResult.status, 1);
    assert.include(backupResult.stderr, "run 'ballin backup setup' to enable it");
    assert.notInclude(commandLog(), 'gh:');
    assert.include(commandLog(), 'git:fetch origin +main:refs/remotes/origin/main');
  });

  it('preserves one created destination through first backup, open, read, and uninstall', () => {
    installGhStub();
    const installResult = runInstaller('y\ny\n\nn\n');

    assert.equal(installResult.status, 0, installResult.stderr);
    const config = JSON.parse(fs.readFileSync(path.join(installedRepoDir, 'ballin.config.json'), 'utf8'));
    assert.equal(config.backup.host, 'github.com');
    assert.equal(config.backup.id, createdGistId);
    assert.isTrue(fs.existsSync(path.join(remoteGistDir, '.MyConfig.md')));

    const zshrc = 'export BALLIN_WALKTHROUGH=1\n';
    fs.writeFileSync(path.join(homeDir, '.zshrc'), zshrc);
    const backupResult = runInstalled(['backup']);
    assert.equal(backupResult.status, 0, backupResult.stderr);
    assert.include(backupResult.stdout, '✚ zshrc');
    assert.equal(fs.readFileSync(path.join(remoteGistDir, 'zshrc.sh'), 'utf8'), zshrc);
    assert.equal(
      fs.readFileSync(path.join(installedRepoDir, '.backup-cache', 'zshrc.sh'), 'utf8'),
      zshrc,
    );

    const openResult = runInstalled(['backup', 'open']);
    const readResult = runInstalled(['backup', 'read', 'zshrc.sh']);
    assert.equal(openResult.status, 0, openResult.stderr);
    assert.equal(readResult.status, 0, readResult.stderr);
    assert.equal(readResult.stdout, zshrc);

    const uninstallResult = runInstalled(['uninstall']);
    assert.equal(uninstallResult.status, 0, uninstallResult.stderr);
    assert.isFalse(fs.existsSync(installedRepoDir));
    assert.isFalse(fs.existsSync(path.join(userBinDir, 'ballin')));
    assert.equal(fs.readFileSync(path.join(remoteGistDir, 'zshrc.sh'), 'utf8'), zshrc);

    const log = commandLog();
    assert.include(log, `gh:api --hostname github.com --method GET gists/${createdGistId}`);
    assert.include(log, `gh:api --hostname github.com --method PATCH gists/${createdGistId}`);
    assert.include(log, `gh:gist view ${createdGistId} --web`);
    assert.notMatch(log, /gists\/(?!walkthrough-created-gist-id)/u);
  });
});
