import type { TopLevelCommandName } from './top_level_commands.ts';
import type { BackupCommandName } from './backup_commands.ts';
import type { ConfigOperationName } from '../config/commands.ts';
const fs = require('fs');
const path = require('path');
const { topLevelCommandNames } = require('./top_level_commands.ts');
const { backupCommandNames, backupReadOptionNames } = require('./backup_commands.ts') as {
  backupCommandNames: readonly BackupCommandName[];
  backupReadOptionNames: readonly string[];
};
const { configOperationNames } = require('../config/commands.ts') as {
  configOperationNames: readonly ConfigOperationName[];
};
const { configCompletionNames } = require('../config/completion.ts');
const { snapshotDefinitions } = require('./backup_snapshots.ts');
import type { SnapshotDefinition } from './backup_snapshots.ts';

const nestedCommandNames = {
  backup: backupCommandNames,
  config: configOperationNames,
} satisfies Partial<Record<TopLevelCommandName, readonly string[]>>;
const configNames: { readable: string[]; leaves: string[]; booleans: string[] } = configCompletionNames();
const snapshotNames = (snapshotDefinitions as SnapshotDefinition[]).map(({ name }) => name);
const quote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;
const arrayWords = (names: readonly string[]): string => names.map(quote).join(' ');

// Shell indexing differs; candidate selection and supported positions are shared.
const selection = (shell: 'bash' | 'zsh'): string[] => {
  const offset = shell === 'zsh' ? 1 : 0;
  const word = (index: number): string => `\${words[${index + offset}]}`;
  return [
    `  case "$${shell === 'zsh' ? 'CURRENT' : 'COMP_CWORD'}" in`,
    `    ${1 + offset}) candidates=(${arrayWords(topLevelCommandNames)}) ;;`,
    `    ${2 + offset})`,
    `      case "${word(1)}" in`,
    ...Object.entries(nestedCommandNames).map(([command, names]) => (
      `        ${command}) candidates=(${arrayWords(names)}) ;;`
    )),
    '      esac',
    '      ;;',
    `    ${3 + offset})`,
    `      case "${word(1)} ${word(2)}" in`,
    `        'config get') candidates=(${arrayWords(configNames.readable)}) ;;`,
    `        'config set') candidates=(${arrayWords(configNames.leaves)}) ;;`,
    `        'backup read') candidates=(${arrayWords(snapshotNames)}) ;;`,
    '      esac',
    '      ;;',
    `    ${4 + offset})`,
    `      case "${word(1)} ${word(2)}" in`,
    "        'config set')",
    `          case "${word(3)}" in`,
    `            ${configNames.booleans.map(quote).join('|')}) candidates=(true false) ;;`,
    '          esac',
    '          ;;',
    `        'backup read') candidates=(${arrayWords(backupReadOptionNames)}) ;;`,
    '      esac',
    '      ;;',
    `    ${5 + offset})`,
    `      if [[ "${word(1)}" == backup && "${word(2)}" == read && "${word(4)}" == --file ]]; then`,
    ...(shell === 'bash' ? [
      `        while IFS= read -r candidate; do candidates+=("$candidate"); done < <(command node "$_ballin_completion_helper" "${word(3)}" 2>/dev/null)`,
    ] : [
      `        candidates=("\${(@f)$(command node "$_ballin_completion_helper" "${word(3)}" 2>/dev/null)}")`,
    ]),
    '      fi',
    '      ;;',
    '  esac',
  ];
};

const renderZshCompletion = (): string => [
  '#compdef ballin',
  '',
  '_ballin_completion_helper="${${(%):-%x}:A:h:h}/commands/completion_members.ts"',
  '',
  'if (( ! $+functions[compdef] )); then',
  '  autoload -Uz compinit',
  '  compinit',
  'fi',
  '',
  '_ballin() {',
  '  local -a candidates',
  ...selection('zsh'),
  '  (( ${#candidates} )) && compadd -- "${candidates[@]}"',
  '  return 0',
  '}',
  '',
  'compdef _ballin ballin',
  '',
].join('\n');

const renderBashCompletion = (): string => [
  '_ballin_completion_helper="$(builtin cd -- "${BASH_SOURCE[0]%/*}/.." && builtin pwd -P)/commands/completion_members.ts"',
  '',
  // Readline words retain quotes and escapes. Decode literals without eval or expansion.
  '_ballin_completion_unquote() {',
  '  local text="$1" char quote="" escaped=0 index',
  '  _ballin_word=""',
  '  for (( index=0; index<${#text}; index++ )); do',
  '    char="${text:index:1}"',
  "    if (( escaped )); then",
  "      if [[ \"$quote\" == '\"' ]]; then",
  "        case \"$char\" in '$'|'`'|'\"'|\\\\) ;; *) _ballin_word+=\\\\ ;; esac",
  "      fi",
  "      _ballin_word+=\"$char\"; escaped=0",
  '    elif [[ "$char" == \\\\ && "$quote" != "\'" ]]; then escaped=1',
  '    elif [[ "$char" == "$quote" ]]; then quote=""',
  '    elif [[ -z "$quote" && ( "$char" == "\'" || "$char" == \'"\' ) ]]; then quote="$char"',
  '    else _ballin_word+="$char"; fi',
  '  done',
  '  (( escaped )) && _ballin_word+=\\\\',
  '  return 0',
  '}',
  '',
  '_ballin_completion() {',
  '  COMPREPLY=()',
  '  local -a candidates=() words=()',
  '  local candidate current _ballin_word',
  '  for candidate in "${COMP_WORDS[@]}"; do',
  '    _ballin_completion_unquote "$candidate"; words+=("$_ballin_word")',
  '  done',
  ...selection('bash'),
  '  current="${words[$COMP_CWORD]}"',
  '  for candidate in "${candidates[@]}"; do',
  '    [[ "$candidate" == "$current"* ]] && COMPREPLY+=("$candidate")',
  '  done',
  '  return 0',
  '}',
  '',
  'complete -o filenames -F _ballin_completion ballin',
  '',
].join('\n');

const writeCompletionAssets = (outputDir: string): void => {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, '_ballin'), renderZshCompletion(), 'utf8');
  fs.writeFileSync(path.join(outputDir, 'ballin.bash'), renderBashCompletion(), 'utf8');
};

module.exports = { renderBashCompletion, renderZshCompletion, writeCompletionAssets };
