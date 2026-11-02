#!/usr/bin/env bash
# Embedded in both public entrypoints by prepare-release. No setup mutations here.
: "${ballin_entry:?Generated entrypoint name is required}" "${ballin_embedded_version:?Generated version is required}" "${ballin_default_track:?Generated default is required}"
ballin_error() { printf 'Ballin: %s\n' "$*" >&2; return 1; }
ballin_download() {
  local status code
  code=$(curl -q -sS -L --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 15 --max-time 60 -w '%{http_code}' "$1" -o "$2") || {
    status=$?; ballin_error "Download failed (curl $status): $1"; return "$status";
  }
  case "$code" in
    200) return 0 ;;
    404) ballin_error "No published release or supported revision was found: $1" ;;
    401|403|429) ballin_error "GitHub authentication or rate limit rejected the request (HTTP $code). Retry later: $1" ;;
    *) ballin_error "GitHub request failed (HTTP $code): $1" ;;
  esac
}
# Extract only scalar data, never source/eval a response. macOS Quickstart needs no Node.
ballin_json() {
  local expected=${3:-string} actual status
  if [[ "$ballin_entry" == quickstart.sh ]]; then
    actual=$(/usr/bin/plutil -type "$2" "$1" 2>/dev/null) || { status=$?; [[ "$status" != 130 && "$status" != 143 ]] || return "$status"; ballin_error "Invalid revision metadata: missing or malformed $2."; return 1; }
    [[ "$actual" == "$expected" || ( "$expected" == number && ( "$actual" == integer || "$actual" == float ) ) ]] || { ballin_error "Invalid revision metadata type for $2."; return 1; }
    /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null
  else
    command -v node >/dev/null || { ballin_error 'Node.js is required for the direct installer. Install supported Node or use Quickstart.'; return 1; }
    node -e 'let v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); for(const k of process.argv[2].split(".")) v=v[k]; const expected=process.argv[3]==="bool"?"boolean":process.argv[3]; if(typeof v!==expected)process.exit(1); process.stdout.write(String(v));' "$1" "$2" "$expected" 2>/dev/null
  fi
  status=$?
  [[ "$status" == 0 || "$status" == 130 || "$status" == 143 ]] || ballin_error "Invalid revision metadata: missing or malformed $2."
  return "$status"
}
ballin_runtime() {
  # JavaScript template interpolation must reach Node literally.
  # shellcheck disable=SC2016
  node -e 'const minimum=process.argv[1], actual=process.versions.node; const valid=v=>/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v); const a=actual.split(".").map(Number),b=minimum.split(".").map(Number); let ok=false; for(let i=0;i<3;i++){if(a[i]!==b[i]){ok=a[i]>b[i];break;}if(i===2)ok=true;} if(!valid(minimum)||!valid(actual)||!ok){process.stderr.write(`Selected revision requires Node.js ${minimum} or newer; active Node.js is ${actual}. Upgrade or activate Node and retry.\n`);process.exit(1);}' "${1:-$ballin_minimum}"
}
ballin_preflight() {
  local root="$HOME/.ballin-scripts" item state top origin status
  [[ ! -L "$root" ]] || { ballin_error 'Installation directory is a symlink. Inspect it before retrying.'; return 1; }
  [[ -e "$root" ]] || return 0
  [[ -d "$root" ]] || { ballin_error 'Installation destination is not a directory.'; return 1; }
  if [[ "$(uname -s)" == Darwin && "$(type -P git)" -ef /usr/bin/git ]]; then
    /usr/bin/xcode-select -p >/dev/null 2>&1 || { status=$?; [[ "$status" != 130 && "$status" != 143 ]] || return "$status"; ballin_error 'Install Apple developer tools before inspecting this existing checkout.'; return 1; }
  fi
  top=$(git -C "$root" rev-parse --show-toplevel) || return $?
  [[ "$(cd "$root" && pwd -P)" == "$(cd "$top" && pwd -P)" ]] || { ballin_error 'Installation is not the repository root.'; return 1; }
  origin=$(git -C "$root" remote get-url origin) || return $?
  case "$origin" in https://github.com/JBallin/ballin-scripts.git|https://github.com/JBallin/ballin-scripts|git@github.com:JBallin/ballin-scripts.git) ;; *) ballin_error 'Installation origin is not the Ballin repository.'; return 1 ;; esac
  state=$(git -C "$root" for-each-ref '--format=%(refname)' refs/replace/) || return $?
  [[ -z "$state" ]] || { ballin_error 'Checkout has Git replacement refs. Inspect them before retrying.'; return 1; }
  state=$(git -C "$root" ls-files -v) || return $?
  if printf '%s\n' "$state" | grep -q '^[a-zS]'; then ballin_error 'Hidden index state is unsupported. Inspect the checkout before retrying.'; return 1; fi
  state=$(git -C "$root" config --get core.sparseCheckout) || { status=$?; [[ "$status" == 1 ]] || return "$status"; }
  [[ "$state" != true ]] || { ballin_error 'Sparse checkout is unsupported.'; return 1; }
  state=$(GIT_OPTIONAL_LOCKS=0 git -C "$root" status --porcelain --untracked-files=all) || return $?
  [[ -z "$state" ]] || { ballin_error 'Checkout has local changes. Preserve them before retrying; no automatic stash or reset will run.'; return 1; }
  for item in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG rebase-merge rebase-apply index.lock; do
    state=$(git -C "$root" rev-parse --git-path "$item") || return $?
    [[ "$state" == /* ]] || state="$root/$state"
    [[ ! -e "$state" ]] || { ballin_error "Checkout has $item. Inspect it before retrying."; return 1; }
  done
}
ballin_select() {
  [[ "${BALLIN_BOOTSTRAP_HOPS:-0}" =~ ^[0-3]$ ]] || { ballin_error 'Installation handoff limit exceeded. The selected entrypoint is incompatible.'; return 1; }
  ballin_mode=install
  if [[ "${1:-}" == --ballin-resolved-v1 ]]; then
    [[ $# == 7 ]] || { ballin_error 'Invalid installation continuation.'; return 1; }
    ballin_kind=$2 ballin_value=$3 ballin_sha=$4 ballin_minimum=$5 ballin_release_id=$6 ballin_mode=$7
    [[ "$ballin_sha" =~ ^[a-f0-9]{40}$ && "$ballin_minimum" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
    case "$ballin_kind" in
      release) [[ "$ballin_value" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$ballin_release_id" =~ ^[1-9][0-9]*$ ]] || return 1 ;;
      sha) [[ "$ballin_value" == "$ballin_sha" && "$ballin_release_id" == - ]] || return 1 ;;
      branch) [[ -n "$ballin_value" && "$ballin_value" != -* && "$ballin_value" != *[[:space:]]* && "$ballin_release_id" == - ]] || return 1 ;;
      *) return 1 ;;
    esac
    [[ "$ballin_mode" == install || "$ballin_mode" == self-update ]] || return 1
    ballin_preflight || return $?
    [[ "$ballin_entry" == quickstart.sh ]] || ballin_runtime || return $?
    return 0
  fi
  local selector='' value='' scratch status api='https://api.github.com/repos/JBallin/ballin-scripts' object_type tag published requested draft prerelease protocol depth=0
  if [[ "${1:-}" == --self-update && "$ballin_entry" == install.sh ]]; then ballin_mode=self-update; shift; fi
  if [[ $# != 0 ]]; then
    [[ $# == 2 ]] || { ballin_error 'Use one of --version vX.Y.Z, --sha FULL_SHA, or --branch NAME.'; return 1; }
    selector=$1 value=$2
    [[ "$ballin_mode" != self-update ]] || { ballin_error 'Self-update follows the configured default; revision selectors belong to installation.'; return 1; }
  fi
  if [[ -z "$selector" ]]; then
    case "${BALLIN_UPDATE_TRACK:-}" in ''|main) ;; *) ballin_error 'BALLIN_UPDATE_TRACK supports only main; unset it for the default.'; return 1 ;; esac
    if [[ "${BALLIN_UPDATE_TRACK:-$ballin_default_track}" == main ]]; then selector=--branch; value=main
    else selector=--version; value="v$ballin_embedded_version"; [[ "$ballin_mode" != self-update ]] || value=latest; fi
  fi
  case "$selector" in
    --sha) [[ "$value" =~ ^[a-f0-9]{40}$ ]] || { ballin_error 'Use a full lowercase commit SHA.'; return 1; }; ballin_kind=sha ;;
    --version) [[ "$value" =~ ^v(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$ || "$value" == latest ]] || { ballin_error 'Use a stable release tag such as v1.0.0.'; return 1; }; ballin_kind=release ;;
    --branch) [[ "$value" =~ ^[a-zA-Z0-9][a-zA-Z0-9._/-]*$ && "$value" != *..* && "$value" != */ && "$value" != *//* ]] || { ballin_error 'Invalid branch name.'; return 1; }; ballin_kind=branch ;;
    *) ballin_error "Unknown selector: $selector"; return 1 ;;
  esac
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/ballin-revision.XXXXXX") || return $?
  (
    # Only the selected child continues setup; these are not returned to the caller.
    local resolved_release_id resolved_sha resolved_value resolved_minimum
    trap 'rm -rf -- "$scratch"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    resolved_release_id=-
    if [[ "$ballin_kind" == release ]]; then
      if [[ "$value" == latest ]]; then tag=latest; else tag="tags/$value"; fi
      ballin_download "$api/releases/$tag" "$scratch/release.json" || exit $?
      draft=$(ballin_json "$scratch/release.json" draft bool) || exit $?
      prerelease=$(ballin_json "$scratch/release.json" prerelease bool) || exit $?
      [[ "$draft" == false && "$prerelease" == false ]] || { ballin_error 'Selected release is not published stable.'; exit 1; }
      requested=$value
      value=$(ballin_json "$scratch/release.json" tag_name) || exit $?
      [[ "$requested" == latest || "$requested" == "$value" ]] || { ballin_error 'Release response does not match the requested version.'; exit 1; }
      published=$(ballin_json "$scratch/release.json" published_at) || exit $?
      [[ "$published" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || { ballin_error 'Release publication date is invalid.'; exit 1; }
      [[ "$value" =~ ^v(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$ ]] || { ballin_error 'Unsupported stable release tag.'; exit 1; }
      resolved_release_id=$(ballin_json "$scratch/release.json" id number) || exit $?
      [[ "$resolved_release_id" =~ ^[1-9][0-9]*$ ]] || { ballin_error 'Invalid GitHub release identifier.'; exit 1; }
      ballin_download "$api/git/ref/tags/$value" "$scratch/ref.json" || exit $?
      resolved_sha=$(ballin_json "$scratch/ref.json" object.sha) || exit $?
      object_type=$(ballin_json "$scratch/ref.json" object.type) || exit $?
      while [[ "$object_type" == tag && "$depth" -lt 8 ]]; do
        [[ "$resolved_sha" =~ ^[a-f0-9]{40}$ ]] || exit 1
        ballin_download "$api/git/tags/$resolved_sha" "$scratch/ref.json" || exit $?
        resolved_sha=$(ballin_json "$scratch/ref.json" object.sha) || exit $?
        object_type=$(ballin_json "$scratch/ref.json" object.type) || exit $?
        depth=$((depth + 1))
      done
      [[ "$object_type" == commit ]] || { ballin_error 'Release tag does not resolve to a commit.'; exit 1; }
    elif [[ "$ballin_kind" == branch ]]; then
      ballin_download "$api/git/ref/heads/$value" "$scratch/ref.json" || exit $?
      object_type=$(ballin_json "$scratch/ref.json" object.type) || exit $?
      [[ "$object_type" == commit ]] || { ballin_error 'Selected branch does not resolve to a commit.'; exit 1; }
      resolved_sha=$(ballin_json "$scratch/ref.json" object.sha) || exit $?
    else resolved_sha=$value; fi
    [[ "$resolved_sha" =~ ^[a-f0-9]{40}$ ]] || { ballin_error 'GitHub returned an invalid commit.'; exit 1; }
    resolved_value=$value
    ballin_download "https://raw.githubusercontent.com/JBallin/ballin-scripts/$resolved_sha/installer-contract.json" "$scratch/contract.json" || exit $?
    protocol=$(ballin_json "$scratch/contract.json" protocol number) || exit $?
    [[ "$protocol" == 1 ]] || { ballin_error 'Selected revision has an unsupported installer contract.'; exit 1; }
    resolved_minimum=$(ballin_json "$scratch/contract.json" minimumNode) || exit $?
    [[ "$resolved_minimum" =~ ^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$ ]] || { ballin_error 'Selected installer contract has an invalid Node requirement.'; exit 1; }
    ballin_preflight || exit $?
    [[ "$ballin_entry" == quickstart.sh ]] || ballin_runtime "$resolved_minimum" || exit $?
    ballin_download "https://raw.githubusercontent.com/JBallin/ballin-scripts/$resolved_sha/$ballin_entry" "$scratch/$ballin_entry" || exit $?
    /bin/bash -n "$scratch/$ballin_entry" || exit $?
    BALLIN_BOOTSTRAP_HOPS=$((${BALLIN_BOOTSTRAP_HOPS:-0} + 1)) BASH_ENV='' /bin/bash "$scratch/$ballin_entry" --ballin-resolved-v1 "$ballin_kind" "$resolved_value" "$resolved_sha" "$resolved_minimum" "$resolved_release_id" "$ballin_mode"
  ); status=$?
  exit "$status"
}
