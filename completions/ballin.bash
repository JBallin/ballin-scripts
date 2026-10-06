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

_ballin_completion_words() {
  local text="${COMP_LINE:0:COMP_POINT}" raw="" char quote="" escaped=0 index
  words=()
  for (( index=0; index<${#text}; index++ )); do
    char="${text:index:1}"
    if (( escaped )); then raw+="$char"; escaped=0
    elif [[ "$char" == \\ && "$quote" != "'" ]]; then raw+="$char"; escaped=1
    elif [[ "$char" == "$quote" ]]; then raw+="$char"; quote=""
    elif [[ -z "$quote" && ( "$char" == "'" || "$char" == '"' ) ]]; then raw+="$char"; quote="$char"
    elif [[ -z "$quote" && ( "$char" == ' ' || "$char" == $'\t' ) ]]; then
      if [[ -n "$raw" ]]; then _ballin_completion_unquote "$raw"; words+=("$_ballin_word"); raw=""; fi
    else raw+="$char"; fi
  done
  _ballin_completion_unquote "$raw"; words+=("$_ballin_word")
  _ballin_quote="$quote"
}

_ballin_completion_quote() {
  local text="$1" char index escaped=""
  if [[ -z "$_ballin_quote" ]]; then printf -v _ballin_word '%q' "$text"; return; fi
  for (( index=0; index<${#text}; index++ )); do
    char="${text:index:1}"
    if [[ "$_ballin_quote" == "'" && "$char" == "'" ]]; then escaped+="'\\''"
    elif [[ "$_ballin_quote" == '"' && ( "$char" == '"' || "$char" == \\ || "$char" == '$' || "$char" == $'\x60' ) ]]; then escaped+="\\$char"
    else escaped+="$char"; fi
  done
  _ballin_word="$escaped"
}

_ballin_completion() {
  COMPREPLY=()
  local -a candidates=() words=()
  local candidate current _ballin_word _ballin_quote="" replacement_prefix="" member=0
  local replacement_word="${2-${COMP_WORDS[$COMP_CWORD]}}"
  local COMP_CWORD="$COMP_CWORD"
  if [[ -n "${COMP_LINE+x}" ]]; then
    _ballin_completion_words
    COMP_CWORD=$((${#words[@]} - 1))
  else
    for candidate in "${COMP_WORDS[@]}"; do
      _ballin_completion_unquote "$candidate"; words+=("$_ballin_word")
    done
  fi
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
        member=1
        while IFS= read -r candidate; do candidates+=("$candidate"); done < <(command node "$_ballin_completion_helper" "${words[3]}" 2>/dev/null)
      fi
      ;;
  esac
  current="${words[$COMP_CWORD]}"
  if [[ -n "${COMP_LINE+x}" ]]; then
    _ballin_completion_unquote "$replacement_word"; replacement_word="$_ballin_word"
    [[ "$current" == *"$replacement_word" ]] || return 0
    replacement_prefix="${current:0:${#current}-${#replacement_word}}"
  fi
  for candidate in "${candidates[@]}"; do
    [[ "$candidate" == "$current"* ]] || continue
    candidate="${candidate#"$replacement_prefix"}"
    if (( member )) && [[ -n "${COMP_LINE+x}" ]]; then
      _ballin_completion_quote "$candidate"; candidate="$_ballin_word"
    fi
    COMPREPLY+=("$candidate")
  done
  return 0
}

complete -F _ballin_completion ballin
