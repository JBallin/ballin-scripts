import type { TopLevelCommandName } from './top_level_commands.ts';
import type { BackupCommandName } from './backup_commands.ts';
import type { ConfigOperationName } from '../config/commands.ts';
const fs = require('fs');
const path = require('path');
const { topLevelCommandNames, commandHelpOptionName, doctorVerboseOptionName } = require('./top_level_commands.ts');
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

const nestedCommandNames: Partial<Record<TopLevelCommandName, readonly string[]>> = {
  backup: backupCommandNames,
  config: configOperationNames,
};
const topLevelCompletionNames = [...topLevelCommandNames, commandHelpOptionName];
const commandCompletionNames = (topLevelCommandNames as readonly TopLevelCommandName[]).map((command) => [command, [
  ...(nestedCommandNames[command] ?? []),
  ...(command === 'doctor' ? [doctorVerboseOptionName] : []),
  commandHelpOptionName,
]] as const);
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
    `    ${1 + offset}) candidates=(${arrayWords(topLevelCompletionNames)}) ;;`,
    `    ${2 + offset})`,
    `      case "${word(1)}" in`,
    ...commandCompletionNames.map(([command, names]) => (
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
      '        member=1',
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
  // Readline splits ':' and '=' independently of shell arguments. Recover literal
  // words up to the cursor without eval, substitutions, or changing WORDBREAKS.
  "_ballin_completion_words() {",
  "  local text=\"${COMP_LINE:0:COMP_POINT}\" raw=\"\" char quote=\"\" escaped=0 index",
  "  words=()",
  "  for (( index=0; index<${#text}; index++ )); do",
  "    char=\"${text:index:1}\"",
  "    if (( escaped )); then raw+=\"$char\"; escaped=0",
  "    elif [[ \"$char\" == \\\\ && \"$quote\" != \"'\" ]]; then raw+=\"$char\"; escaped=1",
  "    elif [[ \"$char\" == \"$quote\" ]]; then raw+=\"$char\"; quote=\"\"",
  "    elif [[ -z \"$quote\" && ( \"$char\" == \"'\" || \"$char\" == '\"' ) ]]; then raw+=\"$char\"; quote=\"$char\"",
  "    elif [[ -z \"$quote\" && ( \"$char\" == ' ' || \"$char\" == $'\\t' ) ]]; then",
  "      if [[ -n \"$raw\" ]]; then _ballin_completion_unquote \"$raw\"; words+=(\"$_ballin_word\"); raw=\"\"; fi",
  "    else raw+=\"$char\"; fi",
  "  done",
  "  _ballin_completion_unquote \"$raw\"; words+=(\"$_ballin_word\")",
  "  _ballin_quote=\"$quote\"",
  "}",
  "",
  // Bash 3.2 has no compopt: escape member replacements in the active quote
  // context, leaving static candidates free of filename/directory semantics.
  "_ballin_completion_quote() {",
  "  local text=\"$1\" char index escaped=\"\"",
  "  if [[ -z \"$_ballin_quote\" ]]; then printf -v _ballin_word '%q' \"$text\"; return; fi",
  "  for (( index=0; index<${#text}; index++ )); do",
  "    char=\"${text:index:1}\"",
  "    if [[ \"$_ballin_quote\" == \"'\" && \"$char\" == \"'\" ]]; then escaped+=\"'\\\\''\"",
  "    elif [[ \"$_ballin_quote\" == '\"' && ( \"$char\" == '\"' || \"$char\" == \\\\ || \"$char\" == '$' || \"$char\" == $'\\x60' ) ]]; then escaped+=\"\\\\$char\"",
  "    else escaped+=\"$char\"; fi",
  "  done",
  "  _ballin_word=\"$escaped\"",
  "}",
  "",
  '_ballin_completion() {',
  '  COMPREPLY=()',
  '  local -a candidates=() words=()',
  "  local candidate current _ballin_word _ballin_quote=\"\" replacement_prefix=\"\" prefix char member=0",
  "  local COMP_CWORD=\"$COMP_CWORD\"",
  "  if [[ -n \"${COMP_LINE+x}\" ]]; then",
  "    _ballin_completion_words",
  "    COMP_CWORD=$((${#words[@]} - 1))",
  "  else",
  "    for candidate in \"${COMP_WORDS[@]}\"; do",
  "      _ballin_completion_unquote \"$candidate\"; words+=(\"$_ballin_word\")",
  "    done",
  "  fi",
  ...selection('bash'),
  "  current=\"${words[$COMP_CWORD]}\"",
  "  if [[ -n \"${COMP_LINE+x}\" && -z \"$_ballin_quote\" ]]; then",
  "    for char in ':' '='; do",
  "      if [[ \"$COMP_WORDBREAKS\" == *\"$char\"* && \"$current\" == *\"$char\"* ]]; then",
  "        prefix=\"${current%${current##*\"$char\"}}\"",
  "        (( ${#prefix} > ${#replacement_prefix} )) && replacement_prefix=\"$prefix\"",
  "      fi",
  "    done",
  "  fi",
  "  for candidate in \"${candidates[@]}\"; do",
  "    [[ \"$candidate\" == \"$current\"* ]] || continue",
  "    candidate=\"${candidate#\"$replacement_prefix\"}\"",
  "    if (( member )) && [[ -n \"${COMP_LINE+x}\" ]]; then",
  "      _ballin_completion_quote \"$candidate\"; candidate=\"$_ballin_word\"",
  "    fi",
  "    COMPREPLY+=(\"$candidate\")",
  "  done",
  '  return 0',
  '}',
  '',
  'complete -F _ballin_completion ballin',
  '',
].join('\n');

const writeCompletionAssets = (outputDir: string): void => {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, '_ballin'), renderZshCompletion(), 'utf8');
  fs.writeFileSync(path.join(outputDir, 'ballin.bash'), renderBashCompletion(), 'utf8');
};

module.exports = { renderBashCompletion, renderZshCompletion, writeCompletionAssets };
