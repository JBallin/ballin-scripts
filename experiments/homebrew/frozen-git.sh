#!/bin/bash
# Rewrite only clone/fetch transport, never origin inspection or stored URLs.
set -euo pipefail
: "${BALLIN_FROZEN_ROOT:?}" "${BALLIN_FROZEN_SHA:?}" "${BALLIN_FROZEN_GIT:?}"
repo='https://github.com/JBallin/ballin-scripts.git'
case "${1:-}" in
  clone|fetch)
    selected=false
    for arg in "$@"; do [[ "$arg" != "$repo" ]] || selected=true; done
    if "$selected"; then
      mirror="$BALLIN_FROZEN_ROOT/mirror.git"
      if [[ ! -d "$mirror" ]]; then
        "$BALLIN_FROZEN_GIT" clone --mirror "$BALLIN_FROZEN_ROOT/source.bundle" "$mirror"
      fi
      actual=$("$BALLIN_FROZEN_GIT" -C "$mirror" rev-parse --verify 'HEAD^{commit}')
      [[ "$actual" == "$BALLIN_FROZEN_SHA" ]] || { echo 'Git bundle does not match the frozen commit.' >&2; exit 1; }
      # Verify the earlier bootstrap bytes against the actual Git objects before
      # installation proceeds. The preparer creates both from the same HEAD.
      for file in package.json quickstart.sh install.sh commands/repo_update.ts; do
        "$BALLIN_FROZEN_GIT" -C "$mirror" show "$BALLIN_FROZEN_SHA:$file" | cmp - "$BALLIN_FROZEN_ROOT/bootstrap/$file"
      done
      exec "$BALLIN_FROZEN_GIT" -c "url.file://$mirror.insteadOf=$repo" "$@"
    fi
    ;;
esac
exec "$BALLIN_FROZEN_GIT" "$@"
