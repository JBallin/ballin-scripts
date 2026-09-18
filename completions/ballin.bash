_ballin_completion() {
  COMPREPLY=()
  if [[ "$COMP_CWORD" -ne 1 ]]; then
    return 0
  fi

  local current="${COMP_WORDS[$COMP_CWORD]}"
  local candidate
  while IFS= read -r candidate; do
    COMPREPLY+=("$candidate")
  done < <(compgen -W 'backup config doctor self-update uninstall update' -- "$current")
}

complete -F _ballin_completion ballin
