# shellcheck shell=bash
# Controlled NVM model for the guarded onboarding sandbox, never host NVM.
nvm() {
  local action=$1
  shift
  case "$action" in
    version)
      [[ "$*" == default && -f "$NVM_DIR/alias/default" && -x "$NVM_DIR/versions/node/v26.13.0/bin/node" ]] || return 3
      printf 'v26.13.0\n'
      ;;
    install)
      [[ "$*" == --lts && "$NVM_DIR" == "$BALLIN_QA_ROOT/home/.config/nvm" ]] || return 97
      mkdir -p "$NVM_DIR/alias/lts" "$NVM_DIR/versions/node/v26.13.0/bin"
      ln -sf "$BALLIN_QA_NODE" "$NVM_DIR/versions/node/v26.13.0/bin/node"
      # Literal arguments belong to the generated npm stub.
      # shellcheck disable=SC2016
      printf '#!/bin/sh\n[ "$1" = --version ] || exit 97\nprintf "11.0.0\\n"\n' > "$NVM_DIR/versions/node/v26.13.0/bin/npm"
      chmod 700 "$NVM_DIR/versions/node/v26.13.0/bin/npm"
      printf 'v26.13.0\n' > "$NVM_DIR/alias/lts/*"
      [[ -e "$NVM_DIR/alias/default" ]] || printf 'lts/*\n' > "$NVM_DIR/alias/default"
      export PATH="$NVM_DIR/versions/node/v26.13.0/bin:$PATH"
      printf 'Simulated NVM LTS installation; no host installation.\n'
      ;;
    alias)
      [[ "$*" == 'default lts/*' ]] || return 97
      printf 'lts/*\n' > "$NVM_DIR/alias/default"
      ;;
    use)
      [[ "$*" == '--silent default' ]] || return 97
      export PATH="$NVM_DIR/versions/node/v26.13.0/bin:$PATH"
      ;;
    *) return 97 ;;
  esac
}
