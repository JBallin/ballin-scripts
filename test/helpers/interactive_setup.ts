const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawnSync } = require('child_process');
const { findShell } = require('./shell_completion.ts');
const { sandboxEnvironment, recordSession, processIsAlive } = require('./onboarding.ts');
import type { Sandbox } from './onboarding.ts';

type PromptAnswer = { prompt: string; answer: string; raw?: boolean };

// Answer only after each real terminal prompt is visible. A short delay leaves
// fd 0 empty long enough to expose a synchronous read accidentally made nonblocking.
const driver = [
  'zmodload zsh/zpty || exit 70',
  'zmodload zsh/zselect || exit 70',
  'zmodload zsh/datetime || exit 70',
  'shell_path="$1"; marker="$2"; command_count="$3"; shift 3',
  'fixture_command=("${@[1,$command_count]}"); shift "$command_count"',
  'child_pid=""; created=0; transcript=""; pending=""',
  'cleanup() {',
  '  if (( created )); then',
  '    if [[ -n "$child_pid" ]] && kill -0 -- "-$child_pid" 2>/dev/null; then',
  '      kill -KILL -- "-$child_pid" 2>/dev/null || return 77',
  '    fi',
  '    zpty -d setup || return 77',
  '    created=0',
  '  fi',
  '  print -r -- "CLEANED:$marker"',
  '}',
  'trap \'cleanup\' EXIT',
  'trap \'exit 124\' HUP INT TERM',
  'read_available() {',
  '  local chunk="" read_status',
  '  zpty -r -t setup chunk; read_status=$?',
  '  transcript+="$chunk"; pending+="$chunk"',
  '  (( read_status <= 2 )) || return 71',
  '  return "$read_status"',
  '}',
  'await_output() {',
  '  local needle="$1" complete_line="${2:-0}" deadline=$(( EPOCHREALTIME + 15 )) read_status select_status',
  '  while (( EPOCHREALTIME < deadline )); do',
  '    if [[ "$pending" == *"$needle"* ]] && { (( complete_line == 0 )) || [[ "$pending" == *"$needle"*$\'\\n\'* ]]; }; then',
  '      pending="${pending#*"$needle"}"; return 0',
  '    fi',
  '    read_available; read_status=$?',
  '    if (( read_status == 2 )); then break; fi',
  '    (( read_status <= 1 )) || return "$read_status"',
  '    zselect -t 1; select_status=$?',
  '    (( select_status <= 1 )) || return 72',
  '  done',
  '  print -u2 -r -- "PTY stopped or timed out waiting for: $needle"',
  '  print -u2 -r -- "TRANSCRIPT_BEGIN${transcript}TRANSCRIPT_END"',
  '  return 124',
  '}',
  'supervisor=\'trap : INT; [[ -t 0 && -t 1 && -t 2 ]] || exit 78; "$INTERACTIVE_STTY" cols "$INTERACTIVE_COLUMNS" rows 24 "$INTERACTIVE_ECHO" || exit 79; printf "\\nSTART:%s:%s\\n" "$INTERACTIVE_MARKER" "$$"; "$@"; result=$?; printf "\\nEXIT:%s:%s\\n" "$INTERACTIVE_MARKER" "$result"; exit "$result"\'',
  'zpty -b -e setup exec "${(q)shell_path}" -d -f -c "${(q)supervisor}" supervisor "${(q)fixture_command[@]}" || exit 73',
  'created=1',
  'await_output "START:$marker:" 1 || exit $?',
  'child_pid="${pending%%[^0-9]*}"',
  '[[ "$child_pid" == <-> && "$child_pid" -gt 1 ]] || exit 74',
  'print -r -- "CHILD_PID:$child_pid"',
  'while (( $# )); do',
  '  needle="$1"; answer="$2"; raw="$3"; shift 3',
  '  await_output "$needle" || exit $?',
  '  zselect -t 10; select_status=$?',
  '  (( select_status <= 1 )) || exit 72',
  '  zpty -t setup || { print -u2 -r -- "Exited before answering: $needle"; exit 75; }',
  '  suffix=$\'\\n\'; [[ "$raw" == 1 ]] && suffix=""',
  '  zpty -w -n setup "$answer$suffix" || {',
  '    print -u2 -r -- "Unable to answer prompt: $needle"',
  '    print -u2 -r -- "TRANSCRIPT_BEGIN${transcript}TRANSCRIPT_END"',
  '    exit 76',
  '  }',
  'done',
  'await_output "EXIT:$marker:" 1 || exit $?',
  'exit_status="${pending%%[^0-9]*}"',
  '[[ "$exit_status" == <-> ]] || exit 74',
  'print -r -- "$transcript"',
  'cleanup || exit $?',
  'trap - EXIT',
  'exit "$exit_status"',
].join('\n');

const runInteractiveSetup = (sandbox: Sandbox, command: string[], answers: PromptAnswer[], profileShell?: 'bash' | 'zsh', options: { columns?: number; echo?: boolean; term?: string } = {}) => {
  const shell = findShell('zsh');
  const marker = randomUUID();
  const stty = ['/bin/stty', '/usr/bin/stty'].find((file) => fs.existsSync(file));
  if (!stty) throw new Error('PTY regression requires stty');
  const env = { ...sandboxEnvironment(sandbox), INTERACTIVE_MARKER: marker,
    INTERACTIVE_STTY: stty, INTERACTIVE_COLUMNS: String(options.columns ?? 120),
    INTERACTIVE_ECHO: options.echo === false ? '-echo' : 'echo', TERM: options.term ?? 'xterm' };
  if (profileShell) env.SHELL = findShell(profileShell);
  recordSession(sandbox, [], true);
  const result = spawnSync(shell, [
    '-d', '-f', '-c', driver, 'interactive-setup-test', shell, marker,
    String(command.length), ...command, ...answers.flatMap(({ prompt, answer, raw }) => [prompt, answer, raw ? '1' : '0']),
  ], { cwd: sandbox.home, env, encoding: 'utf8', timeout: 90000, killSignal: 'SIGTERM', detached: true });
  const childPid = Number(result.stdout?.match(/^CHILD_PID:(\d+)$/mu)?.[1]);
  const groups = [result.pid, childPid].filter((pid) => Number.isInteger(pid) && pid > 1);
  recordSession(sandbox, groups, Boolean(result.pid) && !childPid);
  for (const group of groups) {
    if (processIsAlive(-group)) {
      try { process.kill(-group, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw new Error(`Unable to stop interactive setup group ${group}: ${(error as Error).message}\nDriver status: ${result.status}\n${result.stdout}\n${result.stderr}`);
        }
      }
    }
  }
  const deadline = Date.now() + 5000;
  while (groups.some((group) => processIsAlive(-group)) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (groups.some((group) => processIsAlive(-group))) throw new Error('Interactive setup child shutdown is unconfirmed; preserving sandbox');
  if (!childPid && result.pid) throw new Error(`Interactive setup did not register its child; preserving ambiguous launch state: ${result.stdout}\n${result.stderr}`);
  fs.rmSync(path.join(sandbox.root, '.active'));
  return result;
};

module.exports = { runInteractiveSetup };
