const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { inspect, apply } = require('./profile.cjs');
const root = __dirname;
const quote = s => `'${s.replace(/'/g, `'\\''`)}'`;
function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-choice-test-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'home'), { mode: 0o700 });
  fs.mkdirSync(path.join(directory, 'bin'));
  return directory;
}
function write(file, text) { fs.writeFileSync(file, text, { mode: 0o755 }); }
function shell(t, body, input = '', tty = true) {
  const dir = fixture(t);
  const driver = path.join(dir, 'driver');
  write(driver, `#!/bin/bash\nsource ${quote(path.join(root, 'run-choice.sh'))}\ntrap 'printf "\\nSTATUS:%s\\n" "$?"' EXIT\n${body}\n`);
  const args = tty ? [path.join(root, 'test-pty.py'), driver, input] : [driver];
  const result = cp.spawnSync(tty ? '/usr/bin/python3' : '/bin/bash', args, {
    input, encoding: 'utf8', timeout: 15000,
    env: { HOME: path.join(dir, 'home'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/bash', TERM: 'dumb', TMPDIR: dir },
  });
  assert.ifError(result.error);
  return result.stdout + result.stderr;
}
test('no TTY fails before artifact verification or effects', t => {
  assert.match(shell(t, `choice_main /missing ${'a'.repeat(40)}`, '', false), /Interactive terminal required/);
});
test('cancel and invalid owner do not invoke either installer', t => {
  const setup = `choice_root="$HOME"; printf '#!/bin/bash\\nexit 0\\n' > "$HOME/verify-frozen.sh"; chmod +x "$HOME/verify-frozen.sh"\nchoice_main "$HOME" ${'a'.repeat(40)}`;
  assert.match(shell(t, setup, 'c\n'), /Cancelled/);
  assert.match(shell(t, setup, 'oops\n'), /Invalid choice/);
});
test('explicit direct dispatch never probes Brew, even present', t => {
  const body = `choice_root="$HOME"; printf '#!/bin/bash\\nexit 0\\n' > "$HOME/verify-frozen.sh"; chmod +x "$HOME/verify-frozen.sh"
printf '#!/bin/bash\\n[ "$BALLIN_EXPERIMENT_INSTALL_OWNER" = direct ] || exit 9\\necho DIRECT\\n' > "$HOME/run-frozen-direct.sh"; chmod +x "$HOME/run-frozen-direct.sh"
printf '#!/bin/bash\\necho BREW_WAS_CALLED; exit 99\\n' > "$HOME/brew"; chmod +x "$HOME/brew"; export PATH="$HOME:$PATH"
choice_main "$HOME" ${'a'.repeat(40)}`;
  const output = shell(t, body, 'd\n');
  assert.match(output, /DIRECT/); assert.doesNotMatch(output, /BREW_WAS_CALLED/); assert.match(output, /STATUS:0/);
});
const installerSetup = `choice_arch=arm64; choice_prefix="$HOME/prefix"; choice_scratch="$HOME/scratch"; mkdir "$choice_scratch"; choice_cancelled=false
curl() { local dest; while [[ $# -gt 0 ]]; do if [[ "$1" == -o ]]; then dest=$2; break; fi; shift; done; printf '%s\\n' "$UPSTREAM" > "$dest"; printf '%s' "$HTTP"; return "$CURL_STATUS"; }
UPSTREAM='#!/bin/bash
[[ -t 0 && -t 1 ]] || exit 91
printf "UPSTREAM consent: "
read -r answer
[[ "$answer" == yes ]] || exit 4
printf "UPSTREAM complete\\n"'
HTTP=200; CURL_STATUS=0`;
test('official installer receives unchanged terminal and its own confirmation', t => {
  const output = shell(t, `${installerSetup}\nchoice_install_brew`, 'y\nyes\n');
  assert.match(output, /UPSTREAM complete/); assert.match(output, /STATUS:0/); assert.match(output, /SHA256:/);
});
test('decline, upstream refusal, failed and empty download do not silently continue', t => {
  assert.match(shell(t, `${installerSetup}\nchoice_install_brew`, 'n\n'), /Cancelled before/);
  assert.match(shell(t, `${installerSetup}\nchoice_install_brew`, 'y\nno\n'), /setup stopped \(4\)/);
  assert.match(shell(t, `${installerSetup}\nCURL_STATUS=28; choice_install_brew`, 'y\n'), /download failed/);
  assert.match(shell(t, `${installerSetup}\nHTTP=404; choice_install_brew`, 'y\n'), /download failed/);
  assert.match(shell(t, `${installerSetup}\nUPSTREAM='exit 2'; choice_install_brew`, 'y\n'), /setup stopped \(2\)/);
});
test('new Intel and partial prefixes fail closed', t => {
  assert.match(shell(t, `${installerSetup}\nchoice_arch=x86_64; choice_install_brew`, ''), /does not support Intel/);
  assert.match(shell(t, `${installerSetup}\nmkdir "$choice_prefix"; choice_install_brew`, ''), /partial or unusable/);
});
test('CI cannot turn official installer unattended', t => {
  assert.match(shell(t, `${installerSetup}\nCI=1; choice_install_brew`, ''), /Unset CI and NONINTERACTIVE/);
});
for (const login of ['bash', 'zsh']) {
  test(`${login} profile append preserves bytes, syntax, idempotence and state`, t => {
    const dir = fixture(t), home = path.join(dir, 'home'), file = path.join(home, login === 'bash' ? '.bash_profile' : '.zprofile');
    const env = { HOME: home, SHELL: `/bin/${login}` };
    fs.writeFileSync(file, '# user café\nexport KEEP=yes', { mode: 0o600 });
    fs.writeFileSync(path.join(home, 'state.json'), 'unchanged');
    const snapshot = inspect('/opt/homebrew/bin/brew', env);
    apply('/opt/homebrew/bin/brew', snapshot, env);
    assert.match(fs.readFileSync(file, 'utf8'), /^# user café\nexport KEEP=yes\n/);
    assert.throws(() => inspect('/opt/homebrew/bin/brew', env), /Existing Homebrew/);
    assert.equal(fs.readFileSync(path.join(home, 'state.json'), 'utf8'), 'unchanged');
  });
}
test('profile guards refuse symlink, hard link, concurrent edit and alternate Bash startup', t => {
  const dir = fixture(t), home = path.join(dir, 'home'), file = path.join(home, '.bash_profile');
  const env = { HOME: home, SHELL: '/bin/bash' }, brew = '/opt/homebrew/bin/brew';
  fs.writeFileSync(file, '# original\n', { mode: 0o600 });
  const snapshot = inspect(brew, env);
  fs.appendFileSync(file, '# changed\n');
  assert.throws(() => apply(brew, snapshot, env), /changed after review/);
  fs.linkSync(file, path.join(home, 'hardlink'));
  assert.throws(() => inspect(brew, env), /Unsafe startup file/);
  fs.unlinkSync(path.join(home, 'hardlink'));
  fs.renameSync(file, path.join(home, 'target'));
  fs.symlinkSync(path.join(home, 'target'), file);
  assert.throws(() => inspect(brew, env), /Unsafe startup file/);
  fs.unlinkSync(file);
  fs.writeFileSync(path.join(home, '.profile'), '# preserve');
  assert.throws(() => inspect(brew, env), /alternate Bash/);
});
test('absent profile creation and ZDOTDIR are supported; changed destination is refused', t => {
  const dir = fixture(t), home = path.join(dir, 'home'), zdot = path.join(home, 'zsh');
  fs.mkdirSync(zdot, { mode: 0o700 });
  const env = { HOME: home, ZDOTDIR: zdot, SHELL: '/bin/zsh' }, brew = '/opt/homebrew/bin/brew';
  const snapshot = inspect(brew, env);
  apply(brew, snapshot, env);
  assert.equal(fs.statSync(path.join(zdot, '.zprofile')).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(home, '.zprofile')), false);
});
function preparedBody(fail = false, stale = false) {
  return `choice_root="$HOME/tools"; mkdir -p "$choice_root" "$HOME/artifact" "$HOME/brew/bin" "$HOME/brew/opt/node@26/bin" "$HOME/brew/opt/ballin-experiment/bin" "$HOME/brew/opt/ballin-experiment/libexec"
printf '#!/bin/bash\\nexit 0\\n' > "$choice_root/verify-frozen.sh"; chmod +x "$choice_root/verify-frozen.sh"
printf '' > "$HOME/artifact/source.tar.gz"
ln -s ${quote(process.execPath)} "$HOME/brew/opt/node@26/bin/node"
printf 'process.exit(1);' > "$choice_root/profile.cjs"
printf '#!/bin/bash\\necho ONBOARD >> "$HOME/events"\\n' > "$HOME/brew/opt/ballin-experiment/bin/ballin"; chmod +x "$HOME/brew/opt/ballin-experiment/bin/ballin"
printf '%s' '{"manager":"homebrew","schema":2,"formula":"ballin-local/choice/ballin-experiment","sourceRevision":"${(stale ? 'b' : 'a').repeat(40)}","archiveSha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","selection":{"kind":"development"}}' > "$HOME/brew/opt/ballin-experiment/libexec/.ballin-package.json"
cat > "$HOME/brew/bin/brew" <<'BREW'
#!/bin/bash
printf '%s\\n' "$*" >> "$HOME/events"
case "$1" in
 --prefix) echo "$HOME/brew" ;;
 --version) echo Homebrew ;;
 --repository) echo "$HOME/brew" ;;
 tap-new) mkdir -p "$HOME/brew/Library/Taps/ballin-local/homebrew-choice/Formula" ;;
 shellenv) printf 'export PATH="%s/bin:$PATH"\\n' "$HOME/brew" ;;
 install) if [[ "$3" == ballin-local/choice/ballin-experiment ]]; then ${fail ? 'exit 7' : 'ln -sf "$HOME/brew/opt/ballin-experiment/bin/ballin" "$HOME/brew/bin/ballin"'}; fi ;;
esac
BREW
chmod +x "$HOME/brew/bin/brew"
choice_platform() { choice_arch=arm64; }
choice_brew_path() { choice_prefix="$HOME/brew"; choice_brew="$choice_prefix/bin/brew"; }
choice_install_brew() { echo UNEXPECTED_UPSTREAM; exit 97; }
tar() { mkdir -p "$choice_scratch/ballin-scripts/experiments/homebrew"; echo 26 > "$choice_scratch/ballin-scripts/.nvmrc"; printf 'process.stdout.write("fixture formula");' > "$choice_scratch/ballin-scripts/experiments/homebrew/generate-formula.cjs"; }
trap 'status=$?; cat "$HOME/events"; printf "STATUS:%s\\n" "$status"; [[ -z "\${choice_scratch:-}" ]] || rm -rf "$choice_scratch"' EXIT
# choice_main replaces EXIT trap: capture status explicitly instead.
set +e
( choice_main "$HOME/artifact" ${'a'.repeat(40)} ); result=$?
cat "$HOME/events"; printf 'RESULT:%s\\n' "$result"
`;
}
test('prepared Brew uses explicit package owner, verifies marker then onboards', t => {
  const output = shell(t, preparedBody(), 'h\ny\n');
  assert.doesNotMatch(output, /UNEXPECTED_UPSTREAM/);
  assert.match(output, /shellenv bash/); assert.match(output, /install --formula node@26/);
  assert.match(output, /ONBOARD/); assert.match(output, /RESULT:0/);
});
test('package failure leaves Brew for retry; stale installed candidate cannot onboard', t => {
  const failed = shell(t, preparedBody(true), 'h\ny\n');
  assert.match(failed, /Ballin installation failed/); assert.doesNotMatch(failed, /ONBOARD|UNEXPECTED_UPSTREAM/);
  assert.match(failed, /RESULT:1/);
  const retry = shell(t, preparedBody(), 'h\ny\n');
  assert.match(retry, /ONBOARD/); assert.doesNotMatch(retry, /UNEXPECTED_UPSTREAM/);
  const stale = shell(t, preparedBody(false, true), 'h\ny\n');
  assert.match(stale, /not this frozen candidate/); assert.doesNotMatch(stale, /ONBOARD/);
});
test('profile guards preserve invalid bytes and refuse replaced startup parent', t => {
  const dir = fixture(t), home = path.join(dir, 'home'), env = { HOME: home, SHELL: '/bin/zsh' }, brew = '/opt/homebrew/bin/brew';
  const snapshot = inspect(brew, env);
  fs.renameSync(home, `${home}-old`); fs.mkdirSync(home, { mode: 0o700 });
  assert.throws(() => apply(brew, snapshot, env), /changed after review/);
  const file = path.join(home, '.zprofile');
  fs.writeFileSync(file, Buffer.from([35, 255, 10]), { mode: 0o600 });
  assert.throws(() => inspect(brew, env), /not valid UTF-8/);
  assert.deepEqual(fs.readFileSync(file), Buffer.from([35, 255, 10]));
});
test('direct choice refuses a competing command without changing it', t => {
  const output = shell(t, `choice_root="$HOME"; printf '#!/bin/bash\\nexit 0\\n' > "$HOME/verify-frozen.sh"; chmod +x "$HOME/verify-frozen.sh"
mkdir -p "$HOME/.local/bin"; printf 'preserve other owner' > "$HOME/.local/bin/ballin"
choice_main "$HOME" ${'a'.repeat(40)}`, 'd\n');
  assert.match(output, /Conflicting command/); assert.match(output, /STATUS:1/);
});
test('declining optional profile setup leaves existing profile and state untouched', t => {
  const output = shell(t, `choice_brew=/opt/homebrew/bin/brew; choice_node=${quote(process.execPath)}; choice_scratch="$HOME/scratch"; mkdir "$choice_scratch"
printf '# preserved\\n' > "$HOME/.bash_profile"; printf retained > "$HOME/state"
choice_shell_setup
printf 'PROFILE:'; cat "$HOME/.bash_profile"; printf 'STATE:'; cat "$HOME/state"`, 'n\n');
  assert.match(output, /Future-shell activation remains manual/);
  assert.match(output, /PROFILE:# preserved/); assert.match(output, /STATE:retained/);
});
