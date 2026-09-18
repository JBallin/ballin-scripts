const fs = require('fs');
const path = require('path');
const {
  topLevelCommandNames,
} = require('./top_level_commands.ts');

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
  '  (( CURRENT == 2 )) || return 0',
  `  compadd -- ${completionWords}`,
  '}',
  '',
  'compdef _ballin ballin',
  '',
].join('\n');

const renderBashCompletion = (): string => [
  '_ballin_completion() {',
  '  COMPREPLY=()',
  '  if [[ "$COMP_CWORD" -ne 1 ]]; then',
  '    return 0',
  '  fi',
  '',
  '  local current="${COMP_WORDS[$COMP_CWORD]}"',
  '  local candidate',
  '  while IFS= read -r candidate; do',
  '    COMPREPLY+=("$candidate")',
  `  done < <(compgen -W '${completionWords}' -- "$current")`,
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
