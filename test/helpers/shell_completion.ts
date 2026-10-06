const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { testChildEnvironment } = require('./environment.ts');

const findShell = (name: 'zsh' | 'bash'): string => {
  const candidates = (process.env.PATH ?? '').split(path.delimiter)
    .filter((directory: string) => path.isAbsolute(directory))
    .map((directory: string) => path.join(directory, name));
  for (const candidate of candidates) {
    try {
      const executable = fs.realpathSync(candidate);
      if (!path.isAbsolute(executable) || !fs.statSync(executable).isFile()) continue;
      fs.accessSync(executable, fs.constants.X_OK);
      return executable;
    } catch { /* Try the next absolute PATH entry. */ }
  }
  throw new Error(`${name} must resolve to an absolute executable shell`);
};

const fixtureEnvironment = (fixture: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => (
  testChildEnvironment({
    HOME: fixture, ZDOTDIR: fixture, PATH: fixture, TMPDIR: fixture, TMP: fixture, TEMP: fixture,
    BALLIN_TEST_CONFIG_PATH: path.join(fixture, 'missing-config.json'),
    BALLIN_TEST_REPO_DIR: fixture, TERM: 'dumb',
    BASH_SILENCE_DEPRECATION_WARNING: '1',
    ...overrides,
  })
);

// The supervisor registers its PID before exec. The driver owns that one PTY group,
// waits for verified fixture readiness, and cleans it up on success, failure, or signal.
const nativeDriver = [
  'zmodload zsh/zpty || exit 70',
  'zmodload zsh/zselect || exit 70',
  'zmodload zsh/datetime || exit 70',
  'child_pid=""; created=0; transcript=""',
  'cleanup() {',
  '  local failed=0',
  '  if (( created )); then',
  '    if [[ -n "$child_pid" ]] && zpty -t native; then',
  '      kill -KILL -- "-$child_pid" 2>/dev/null || failed=1',
  '    fi',
  '    zpty -d native || failed=1',
  '    created=0',
  '  fi',
  '  if (( failed == 0 )); then',
  '    print -r -- "CLEANED:$FIXTURE_MARKER"',
  '  else',
  '    print -u2 -r -- "PTY cleanup failed: child_pid=$child_pid"',
  '  fi',
  '  return "$failed"',
  '}',
  'trap \'cleanup\' EXIT',
  'trap \'exit 124\' HUP INT TERM',
  'await_stopped() {',
  '  local deadline=$(( EPOCHREALTIME + 3 )) select_status read_status chunk',
  '  while (( EPOCHREALTIME < deadline )); do',
  '    chunk=""',
  '    zpty -r -t native chunk; read_status=$?',
  '    transcript+="$chunk"',
  '    if (( read_status == 2 )); then return 0; fi',
  '    if (( read_status != 0 && read_status != 1 )); then',
  '      print -u2 -r -- "PTY exit read failed: status=$read_status"',
  '      print -u2 -r -- "TRANSCRIPT_BEGIN${transcript}TRANSCRIPT_END"',
  '      return 71',
  '    fi',
  '    zselect -t 1; select_status=$?',
  '    (( select_status <= 1 )) || return 72',
  '  done',
  '  print -u2 -r -- "Timeout waiting for PTY exit; read_status=$read_status"',
  '  print -u2 -r -- "TRANSCRIPT_BEGIN${transcript}TRANSCRIPT_END"',
  '  return 124',
  '}',
  'await_output() {',
  '  local needle="$1" chunk read_status select_status',
  '  local deadline=$(( EPOCHREALTIME + 3 ))',
  '  while (( EPOCHREALTIME < deadline )); do',
  '    if [[ "$transcript" == *"$needle"*$\'\\n\'* ]]; then return 0; fi',
  '    chunk=""',
  '    zpty -r -t native chunk; read_status=$?',
  '    transcript+="$chunk"',
  '    if (( read_status == 0 )); then',
  '    if [[ "$transcript" == *"$needle"*$\'\\n\'* ]]; then return 0; fi',
  '    elif (( read_status != 1 )); then',
  '      print -u2 -r -- "PTY read failed: status=$read_status waiting=$needle"',
  '      print -u2 -r -- "TRANSCRIPT_BEGIN${transcript}TRANSCRIPT_END"',
  '      return 71',
  '    fi',
  '    zselect -t 1; select_status=$?',
  '    (( select_status <= 1 )) || return 72',
  '  done',
  '  print -u2 -r -- "Timeout waiting for fixture output: $needle; read_status=$read_status"',
  '  print -u2 -r -- "TRANSCRIPT_BEGIN${transcript}TRANSCRIPT_END"',
  '  return 124',
  '}',
  // zpty evals joined arguments: quote every path and the supervisor command explicitly.
  'supervisor=\'printf "START:%s:%s\\n" "$FIXTURE_MARKER" "$$"; exec "$@"\'',
  'if [[ "$3" == zsh ]]; then',
  '  zpty -b native exec "${(q)1}" -d -f -c "${(q)supervisor}" supervisor "${(q)2}" -d -i || exit 73',
  'else',
  '  zpty -b native exec "${(q)1}" -d -f -c "${(q)supervisor}" supervisor "${(q)2}" --noprofile --rcfile "${(q)4}" -i || exit 73',
  'fi',
  'created=1',
  'await_output "START:$FIXTURE_MARKER:" || exit $?',
  'child_pid="${transcript#*START:$FIXTURE_MARKER:}"',
  'child_pid="${child_pid%%[^0-9]*}"',
  '[[ "$child_pid" == <-> && "$child_pid" -gt 1 ]] || exit 74',
  'print -r -- "CHILD_PID:$child_pid"',
  'await_output "READY:$FIXTURE_MARKER" || exit $?',
  'print -r -- "READY:$FIXTURE_MARKER"',
  'if [[ "$5" == completion ]]; then',
  '  zpty -t native || exit 75',
  // Tab is sent alone, without Enter. Execution is a separate, explicit test action.
  '  zpty -w -n native "$6" || exit 76',
  '  zpty -w -n native $\'\\n\' || exit 76',
  '  await_output "INSERTED:$FIXTURE_MARKER:" || exit $?',
  '  print -r -- "$transcript"',
  'fi',
  'zpty -t native || exit 75',
  'zpty -w native "exit 0" || exit 76',
  'await_output "CHILD_EXIT:$FIXTURE_MARKER:0" || exit $?',
  'await_stopped || exit $?',
  'print -r -- "CHILD_EXIT:$FIXTURE_MARKER:0"',
  'cleanup || exit 77',
  'trap - EXIT',
].join('\n');

// Without input this runs only the readiness/exit/cleanup protocol, for isolation review.
const runNativeCompletion = (shell: 'zsh' | 'bash', asset: string, input?: string, prepareFixture?: (fixture: string) => void) => {
  if (input !== undefined && !/^ballin [a-zA-Z0-9_.:= /'"\\-]+\t$/.test(input)) {
    throw new Error('Native completion input must be one fixture command ending in Tab');
  }
  const zshPath = findShell('zsh');
  const shellPath = findShell(shell);
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ballin-native-completion-')));
  prepareFixture?.(fixture);
  const marker = randomUUID();
  const rcPath = path.join(fixture, shell === 'zsh' ? '.zshrc' : 'bashrc');
  const logPath = path.join(fixture, 'fixture-calls');
  const argumentLog = path.join(fixture, 'fixture-arguments');
  const readyChecks = [
    '[[ "$PATH" == "$FIXTURE_ROOT" && "$HOME" == "$FIXTURE_ROOT" && "$PWD" == "$FIXTURE_ROOT" ]] || exit 80',
    '[[ "$ZDOTDIR" == "$FIXTURE_ROOT" && "$TMPDIR" == "$FIXTURE_ROOT" ]] || exit 80',
    '[[ "$BALLIN_TEST_REPO_DIR" == "$FIXTURE_ROOT" && "$BALLIN_TEST_CONFIG_PATH" == "$FIXTURE_ROOT/missing-config.json" ]] || exit 80',
    '[[ -z "$expected_ballin" || "$(typeset -f ballin)" == "$expected_ballin" ]] || exit 81',
    shell === 'zsh'
      ? '[[ "$(whence -w ballin)" == "ballin: function" ]] || exit 81'
      : '[[ "$(type -t ballin)" == function ]] || exit 81',
  ];
  fs.writeFileSync(rcPath, [
    // The fixture function exists before any completion code is sourced.
    'ballin() { printf "%s\\n" "$*" >> "$FIXTURE_LOG"; printf "%s\\0" "$@" >> "$FIXTURE_ARGUMENTS"; printf "\\nINSERTED:%s:ballin %s\\n" "$FIXTURE_MARKER" "$*"; }',
    ...(shell === 'zsh' ? ['unsetopt GLOBAL_RCS'] : []),
    'trap \'printf "\\nCHILD_EXIT:%s:%s\\n" "$FIXTURE_MARKER" "$?"\' EXIT',
    ...readyChecks,
    'expected_ballin="$(typeset -f ballin)"',
    // Initialize real completion without prompting: ignore insecure host paths
    // and keep completion dump files out of the closed fixture.
    ...(shell === 'zsh' ? ['autoload -Uz compinit', 'compinit -i -D || exit 82'] : []),
    'source "$COMPLETION_ASSET" || exit 82',
    ...readyChecks,
    "PS1='fixture> '",
    'printf "\\nREADY:%s\\n" "$FIXTURE_MARKER"',
  ].join('\n'));
  let result;
  try {
    result = spawnSync(zshPath, [
      '-d', '-f', '-c', nativeDriver, 'native-completion-test', zshPath, shellPath,
      shell, rcPath, input === undefined ? 'probe' : 'completion', input ?? '',
    ], {
      cwd: fixture, encoding: 'utf8', timeout: 15000, killSignal: 'SIGTERM',
      env: fixtureEnvironment(fixture, {
        COMPLETION_ASSET: asset, FIXTURE_ROOT: fixture, FIXTURE_MARKER: marker, FIXTURE_LOG: logPath,
        FIXTURE_ARGUMENTS: argumentLog,
        NODE_OPTIONS: fs.existsSync(path.join(fixture, 'completion-guard.cjs'))
          ? `--require=${path.join(fixture, 'completion-guard.cjs')}` : undefined,
      }),
    });
    return {
      ...result, marker,
      forbidden: fs.existsSync(path.join(fixture, 'forbidden')),
      arguments: fs.existsSync(argumentLog) ? fs.readFileSync(argumentLog, 'utf8').split('\0').slice(0, -1) : [],
      calls: fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trimEnd().split('\n') : [],
    };
  } finally {
    // The driver handles its own deadlines/signals; this also covers a failed outer watchdog.
    if (result && !result.stdout.includes(`CLEANED:${marker}`)
      && !result.stdout.includes(`CHILD_EXIT:${marker}:0`)) {
      const childPid = result.stdout.match(/^CHILD_PID:(\d+)$/m)?.[1];
      if (childPid) {
        try { process.kill(-Number(childPid), 'SIGKILL'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
};

module.exports = { findShell, fixtureEnvironment, runNativeCompletion };
