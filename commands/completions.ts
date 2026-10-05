import type { TopLevelCommandName } from './top_level_commands.ts';
import type { BackupCommandName } from './backup_commands.ts';
import type { ConfigOperationName } from '../config/commands.ts';
const fs = require('fs');
const path = require('path');
const {
  topLevelCommandNames,
} = require('./top_level_commands.ts');

const { backupCommandNames, backupReadOptionNames } = require('./backup_commands.ts') as {
  backupCommandNames: readonly BackupCommandName[];
  backupReadOptionNames: readonly string[];
};
const { configOperationNames } = require('../config/commands.ts') as {
  configOperationNames: readonly ConfigOperationName[];
};

const nestedCommandNames = {
  backup: backupCommandNames,
  config: configOperationNames,
} satisfies Partial<Record<TopLevelCommandName, readonly string[]>>;

const completionWords = topLevelCommandNames.join(' ');

const renderZshCompletion = (): string => [
  '#compdef ballin',
  '',
  'if (( ! $+functions[compdef] )); then',
  '  autoload -Uz compinit',
  '  compinit',
  'fi',
  '',
  '_ballin() {',
  '  case "$CURRENT" in',
  `    2) compadd -- ${completionWords} ;;`,
  '    3)',
  '      case "${words[2]}" in',
  ...Object.entries(nestedCommandNames).map(([command, names]) => (
    `        ${command}) compadd -- ${names.join(' ')} ;;`
  )),
  '      esac',
  '      ;;',
  '    5)',
  `      if [[ "\${words[2]}" == backup && "\${words[3]}" == read ]]; then compadd -- ${backupReadOptionNames.join(' ')}; fi`,
  '      ;;',
  '  esac',
  '}',
  '',
  'compdef _ballin ballin',
  '',
].join('\n');

const renderBashCompletion = (): string => [
  '_ballin_completion() {',
  '  COMPREPLY=()',
  '  local candidates',
  '  case "$COMP_CWORD" in',
  `    1) candidates='${completionWords}' ;;`,
  '    2)',
  '      case "${COMP_WORDS[1]}" in',
  ...Object.entries(nestedCommandNames).map(([command, names]) => (
    `        ${command}) candidates='${names.join(' ')}' ;;`
  )),
  '        *) return 0 ;;',
  '      esac',
  '      ;;',
  '    4)',
  '      [[ "${COMP_WORDS[1]}" == backup && "${COMP_WORDS[2]}" == read ]] || return 0',
  `      candidates='${backupReadOptionNames.join(' ')}'`,
  '      ;;',
  '    *) return 0 ;;',
  '  esac',
  '',
  '  local current="${COMP_WORDS[$COMP_CWORD]}"',
  '  local candidate',
  '  while IFS= read -r candidate; do',
  '    COMPREPLY+=("$candidate")',
  '  done < <(compgen -W "$candidates" -- "$current")',
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

module.exports = {
  renderBashCompletion,
  renderZshCompletion,
  writeCompletionAssets,
};
