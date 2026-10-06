_ballin_completion_helper="$(builtin cd -- "${BASH_SOURCE[0]%/*}/.." && builtin pwd -P)/commands/completion_members.ts"

_ballin_completion_unquote() {
  local text="$1" char quote="" escaped=0 index
  _ballin_word=""
  for (( index=0; index<${#text}; index++ )); do
    char="${text:index:1}"
    if (( escaped )); then
      if [[ "$quote" == '"' ]]; then
        case "$char" in '$'|'`'|'"'|\\) ;; *) _ballin_word+=\\ ;; esac
      fi
      _ballin_word+="$char"; escaped=0
    elif [[ "$char" == \\ && "$quote" != "'" ]]; then escaped=1
    elif [[ "$char" == "$quote" ]]; then quote=""
    elif [[ -z "$quote" && ( "$char" == "'" || "$char" == '"' ) ]]; then quote="$char"
    else _ballin_word+="$char"; fi
  done
  (( escaped )) && _ballin_word+=\\
  return 0
}

_ballin_completion() {
  COMPREPLY=()
  local -a candidates=() words=()
  local candidate current _ballin_word
  for candidate in "${COMP_WORDS[@]}"; do
    _ballin_completion_unquote "$candidate"; words+=("$_ballin_word")
  done
  case "$COMP_CWORD" in
    1) candidates=('backup' 'config' 'doctor' 'self-update' 'setup' 'uninstall' 'update' '--help') ;;
    2)
      case "${words[1]}" in
        backup) candidates=('open' 'read' 'list' 'setup' 'disconnect' '--help') ;;
        config) candidates=('get' 'set' 'reset' '--help') ;;
        doctor) candidates=('--verbose' '--help') ;;
        self-update) candidates=('--help') ;;
        setup) candidates=('--help') ;;
        uninstall) candidates=('--help') ;;
        update) candidates=('--help') ;;
      esac
      ;;
    3)
      case "${words[1]} ${words[2]}" in
        'config get') candidates=('update' 'update.cleanup' 'update.selfUpdate' 'update.backup' 'update.softwareupdate' 'update.npm' 'update.nvm' 'backup' 'backup.repository' 'backup.includeSensitive' 'analytics' 'analytics.enabled') ;;
        'config set') candidates=('update.cleanup' 'update.selfUpdate' 'update.backup' 'update.softwareupdate' 'update.npm' 'update.nvm' 'backup.repository' 'backup.includeSensitive' 'analytics.enabled') ;;
        'backup read') candidates=('bash_profile.sh' 'bashrc.sh' 'profile.sh' 'zprofile.sh' 'zshrc.sh' 'bash_completions' 'brew_list' 'brew_leaves' 'brew_cask' 'brew_services' 'Brewfile' 'gitignore_global' 'gitconfig' 'npm_global' 'pipx' 'uv_tools' 'pyenv_versions' 'nvmrc' 'vs_settings' 'vs_keybindings' 'vs_extensions' 'vsI_settings' 'vsI_keybindings' 'vsI_extensions' 'vimrc' 'nanorc' 'codex_AGENTS.md' 'codex_AGENTS.override.md' 'codex_config.toml' 'codex_profiles.bundle.json' 'codex_hooks.json' 'codex_skills.bundle.json' 'codex_user_skills.bundle.json' 'codex_rules.bundle.json' 'codex_agents.bundle.json' 'codex_marketplace.json' 'claude_instructions' 'claude_rules.bundle.json' 'claude_agents.bundle.json' 'claude_commands.bundle.json' 'claude_skills.bundle.json' 'ballin_config' 'mas') ;;
      esac
      ;;
    4)
      case "${words[1]} ${words[2]}" in
        'config set')
          case "${words[3]}" in
            'update.cleanup'|'update.selfUpdate'|'update.backup'|'update.softwareupdate'|'update.npm'|'update.nvm'|'backup.includeSensitive'|'analytics.enabled') candidates=(true false) ;;
          esac
          ;;
        'backup read') candidates=('--list' '--file') ;;
      esac
      ;;
    5)
      if [[ "${words[1]}" == backup && "${words[2]}" == read && "${words[4]}" == --file ]]; then
        while IFS= read -r candidate; do candidates+=("$candidate"); done < <(command node "$_ballin_completion_helper" "${words[3]}" 2>/dev/null)
      fi
      ;;
  esac
  current="${words[$COMP_CWORD]}"
  for candidate in "${candidates[@]}"; do
    [[ "$candidate" == "$current"* ]] && COMPREPLY+=("$candidate")
  done
  return 0
}

complete -o filenames -F _ballin_completion ballin
