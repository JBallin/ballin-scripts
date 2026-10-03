_ballin_completion() {
  COMPREPLY=()
  local candidates
  case "$COMP_CWORD" in
    1) candidates='backup config doctor self-update setup uninstall update' ;;
    2)
      case "${COMP_WORDS[1]}" in
        backup) candidates='open read setup disconnect verify' ;;
        config) candidates='get set reset' ;;
        *) return 0 ;;
      esac
      ;;
    *) return 0 ;;
  esac

  local current="${COMP_WORDS[$COMP_CWORD]}"
  local candidate
  while IFS= read -r candidate; do
    COMPREPLY+=("$candidate")
  done < <(compgen -W "$candidates" -- "$current")
}

complete -F _ballin_completion ballin
