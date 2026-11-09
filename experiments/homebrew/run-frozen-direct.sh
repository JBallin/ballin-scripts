#!/bin/bash
# Disposable-guest development transport, not a public installation entrypoint.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
verify=false
if [[ "${1:-}" == --verify ]]; then verify=true; shift; fi
[[ $# == 2 ]] || { echo 'Use: run-frozen-direct.sh [--verify] ARTIFACT_DIR FULL_SHA' >&2; exit 2; }
/bin/bash "$here/verify-frozen.sh" "$1" "$2"
"$verify" && exit 0
[[ -t 0 && -t 1 ]] || { echo 'Run the experimental chooser in an interactive disposable guest terminal.' >&2; exit 2; }
artifact=$(cd "$1" && pwd -P)
# These are absolute selections made before installing transport shims. This
# local-only transport requires working Git; see FROZEN-TRANSPORT.md.
real_curl=$(type -P curl)
real_git=$(type -P git) || { echo 'Frozen transport requires working Git in the disposable guest.' >&2; exit 2; }
if [[ "$real_git" -ef /usr/bin/git ]] && ! /usr/bin/xcode-select -p >/dev/null 2>&1; then
  echo 'Prepare Apple developer tools in this guest first. Frozen transport requires working Git.' >&2
  exit 2
fi
"$real_git" --version >/dev/null || { echo 'Frozen transport requires working Git in the disposable guest.' >&2; exit 2; }
scratch=$(mktemp -d "${TMPDIR:-/tmp}/ballin-frozen.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$scratch/bin"
cp -R "$artifact/bootstrap" "$scratch/bootstrap"
cp "$artifact/source.bundle" "$scratch/source.bundle"
cp "$artifact/source.tar.gz" "$artifact/source-sha" "$artifact/SHA256SUMS" "$scratch/"
/bin/bash "$here/verify-frozen.sh" "$scratch" "$2"
cp "$here/frozen-curl.sh" "$scratch/bin/curl"
cp "$here/frozen-git.sh" "$scratch/bin/git"
chmod 700 "$scratch/bin/curl" "$scratch/bin/git"
# Do not inherit unrelated Git redirection, authentication, hooks, or config.
for name in $(compgen -v GIT_); do unset "$name"; done
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
export GIT_NO_REPLACE_OBJECTS=1 GIT_NO_LAZY_FETCH=1
export BALLIN_FROZEN_ROOT="$scratch" BALLIN_FROZEN_SHA="$2"
export BALLIN_FROZEN_CURL="$real_curl" BALLIN_FROZEN_GIT="$real_git"
export BALLIN_EXPERIMENT_INSTALL_OWNER=direct
export PATH="$scratch/bin:$PATH"
printf 'Local development source: %s\nNo published-release claim. Transport overrides last only for this run.\n' "$2"
BASH_ENV='' ENV='' /bin/bash "$scratch/bootstrap/quickstart.sh" --sha "$2"
