#!/bin/bash
# Scoped transport for the exact four bootstrap URLs; everything else uses curl.
set -euo pipefail
: "${BALLIN_FROZEN_ROOT:?}" "${BALLIN_FROZEN_SHA:?}" "${BALLIN_FROZEN_CURL:?}"
url='' output='' format='' previous=''
for arg in "$@"; do
  case "$previous" in -o|--output) output=$arg ;; -w|--write-out) format=$arg ;; esac
  case "$arg" in https://*) [[ -z "$url" ]] || { echo 'Multiple URLs are unsupported by the frozen transport.' >&2; exit 2; }; url=$arg ;; esac
  previous=$arg
done
case "$url" in
  "https://raw.githubusercontent.com/JBallin/ballin-scripts/$BALLIN_FROZEN_SHA/"*)
    file=${url#"https://raw.githubusercontent.com/JBallin/ballin-scripts/$BALLIN_FROZEN_SHA/"}
    case "$file" in package.json|quickstart.sh|install.sh|commands/repo_update.ts) ;; *) echo 'Unsupported frozen bootstrap member.' >&2; exit 2 ;; esac
    [[ -n "$output" && ( -z "$format" || "$format" == '%{http_code}' ) ]] || { echo 'Unsupported frozen download invocation.' >&2; exit 2; }
    cp "$BALLIN_FROZEN_ROOT/bootstrap/$file" "$output"
    [[ -z "$format" ]] || printf 200
    ;;
  https://raw.githubusercontent.com/JBallin/ballin-scripts/*|https://api.github.com/repos/JBallin/ballin-scripts/*)
    echo 'Frozen experiment transport accepts only its exact source SHA, never releases or branches.' >&2; exit 2 ;;
  *) exec "$BALLIN_FROZEN_CURL" "$@" ;;
esac
