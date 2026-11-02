#!/usr/bin/env bash
{ # Parse the complete body before starting installation.
# BEGIN RELEASE BOOTSTRAP
ballin_entry='quickstart.sh'
ballin_embedded_version='1.0.0'
ballin_default_track='main'
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
# END RELEASE BOOTSTRAP
# Optional beginner bootstrap; install.sh remains the core Ballin installer.
set -euo pipefail
umask 077

phase() {
  if [[ -t 1 && "${TERM:-}" != dumb && -z "${NO_COLOR:-}" ]]; then
    printf '\033[34m==>\033[1;39m %s\033[0m\n' "$1"
  else printf '==> %s\n' "$1"; fi
}
command_reference() {
  if [[ -t "${2:-1}" && "${TERM:-}" != dumb && -z "${NO_COLOR:-}" ]]; then
    printf '\033[1m%s\033[0m' "$1"
  else printf "\`%s\`" "$1"; fi
}

url_reference() {
  if [[ -t "${2:-1}" && "${TERM:-}" != dumb && -z "${NO_COLOR:-}" ]]; then
    printf '\033[34m%s\033[0m' "$1"
  else printf '%s' "$1"; fi
}
documentation_pointer() {
  printf '🔗 %s:\n' "$1"
  url_reference "$2"
  printf '\n'
}
error_icon() {
  if [[ -t "${1:-1}" && "${TERM:-}" != dumb && -z "${NO_COLOR:-}" ]]; then
    printf '\033[31m❌\033[0m'
  else printf '❌'; fi
}
setup_complete() {
  if [[ -t 1 && "${TERM:-}" != dumb && -z "${NO_COLOR:-}" ]]; then
    printf '\033[32m😎 Setup complete.\033[0m'
  else printf '😎 Setup complete.'; fi
}
prompt_options() {
  if [[ -t 1 && "${TERM:-}" != dumb && -z "${NO_COLOR:-}" ]]; then
    printf '\033[34m[%s]\033[0m' "$1"
  else printf '[%s]' "$1"; fi
}
prompt_choices() {
  local choices=$1 default=$2
  if [[ -t 1 && "${TERM:-}" != dumb && -z "${NO_COLOR:-}" ]]; then
    if [[ "$default" == y ]]; then printf '\033[34m[\033[1mY\033[22m/n]\033[0m '
    else printf '\033[34m[y/\033[1mN\033[22m]\033[0m '; fi
  else printf '%s ' "$choices"; fi
}

# Abbreviate only paths inside HOME for display; filesystem operations stay absolute.
display_path() {
  local home_path=${HOME%/}
  case "$1" in
    "$home_path") printf '~' ;;
    "$home_path"/*) printf '%s/%s' '~' "${1#"$home_path"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Compare the reviewed command entry again before using Quickstart consent.
command_entry_snapshot() {
  local target=$1 metadata
  if [[ ! -e "$target" && ! -L "$target" ]]; then printf missing; return; fi
  [[ -L "$target" || ( -f "$target" && ! -d "$target" ) ]] || return 1
  metadata=$(/usr/bin/stat -f '%d:%i:%p:%l:%z:%m:%c' "$target" 2>/dev/null) \
    || metadata=$(/usr/bin/stat -c '%d:%i:%f:%h:%s:%Y:%Z' "$target") || return 1
  printf '%s' "$metadata"
  if [[ -L "$target" ]]; then printf ':'; readlink "$target"; fi
}

system_node_bin='/usr/local/bin'
system_brew_arm='/opt/homebrew'
system_brew_intel='/usr/local'
system_git='/usr/bin/git'
system_xcode_select='/usr/bin/xcode-select'
system_sudo='/usr/bin/sudo'
system_sysctl='/usr/sbin/sysctl'
system_file='/usr/bin/file'
# Mirrored bootstrap requirement; tests keep this aligned with package.json.
required_node_version='24.12'
scratch=''
profile_temp=''
gh_temp=''
original_path=${PATH-}
original_pwd=$PWD

fail() {
  printf '\nQuickstart: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  [ -z "$prompt_error" ] || rm -f -- "$prompt_error"
  [ -z "$profile_temp" ] || rm -f -- "$profile_temp"
  [ -z "$gh_temp" ] || rm -f -- "$gh_temp"
  [ -z "$scratch" ] || rm -rf -- "$scratch"
}

# Keep complete answers, EOF and diagnosed read failures distinct. Never echo input.
input_ended=false
prompt_error=''
read_prompt_answer() {
  local status
  prompt_error=$(mktemp "${TMPDIR:-/tmp}/ballin-input.XXXXXX") || { printf '\nUnable to prepare prompt input.\n' >&2; exit 1; }
  if IFS= read -r prompt_answer 2>|"$prompt_error"; then
    rm -f -- "$prompt_error"; prompt_error=''
    [[ -t 0 ]] || printf '\n'
    return 0
  else status=$?; fi
  if (( status > 128 )); then exit "$status"; fi
  if [[ -s "$prompt_error" ]]; then
    rm -f -- "$prompt_error"; prompt_error=''
    printf '\nUnable to read prompt input.\n' >&2
    exit 1
  fi
  rm -f -- "$prompt_error"; prompt_error=''
  [[ -t 0 ]] || printf '\n'
  prompt_answer=''; input_ended=true; return 1
}
confirm() {
  local default=${2:-n} normalized
  while :; do
    printf '%s ' "$1"
    if [[ "$default" == y ]]; then prompt_choices '[Y/n]' y; else prompt_choices '[y/N]' n; fi
    read_prompt_answer || return 1
    normalized=$prompt_answer
    normalized="${normalized#"${normalized%%[![:space:]]*}"}"
    normalized="${normalized%"${normalized##*[![:space:]]}"}"
    case "$normalized" in
      y|Y|[yY][eE][sS]) return 0 ;;
      n|N|[nN][oO]) return 1 ;;
      '') [[ "$default" == y ]]; return ;;
      *) printf 'Please enter yes or no.\n' ;;
    esac
  done
}
confirm_first_backup() {
  printf '\n'
  confirm 'Run a backup now and open its GitHub destination?' y
}

backup_destination_kind() {
  "$node_tool" -e '
    const root = process.argv[1];
    const config = JSON.parse(require("fs").readFileSync(root + "/ballin.config.json", "utf8"));
    process.stdout.write(require(root + "/commands/backup_config.ts").configuredBackupDestination(config).kind);
  ' "$1"
}

# Bootstrap reads configuration as data; the installed checkout may be older.
# Mirror backup_config.ts host/destination validation before any authentication.
backup_setup_host() {
  "$node_tool" -e '
    const fs = require("fs");
    const [file, proposed] = process.argv.slice(1);
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const host = value => {
      if (typeof value !== "string" || value.length > 253 || !/^[A-Za-z0-9.-]+$/u.test(value)) return null;
      const normalized = value.toLowerCase();
      return normalized.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ? normalized : null;
    };
    const identifier = value => typeof value === "string" && value.length > 0 && !/[\s\x00-\x1f\x7f]/u.test(value);
    try {
      let config = {};
      try { if (!fs.statSync(file).isFile()) throw Error(); config = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        try { fs.lstatSync(file); throw Error(); } catch (missing) { if (missing.code !== "ENOENT") throw missing; }
      }
      if (!object(config) || ["backup", "update", "analytics"].some(key => Object.hasOwn(config, key) && !object(config[key]))) throw Error();
      const backup = config.backup ?? {};
      let configured;
      if (backup.repository !== undefined && backup.repository !== null) {
        const repo = backup.repository;
        if (!object(repo) || !identifier(repo.id) || !identifier(repo.ownerId) || !identifier(repo.branch)
          || typeof repo.name !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo.name) || [".", ".."].includes(repo.name)) throw Error();
        configured = Object.hasOwn(repo, "host") ? host(repo.host) : "github.com";
        if (!configured) throw Error();
      }
      const selected = proposed === undefined ? configured : host(proposed);
      if (proposed !== undefined && (!selected || (configured && configured !== selected))) throw Error();
      process.stdout.write(selected ?? "");
    } catch {
      process.stderr.write("Quickstart: Invalid backup hostname or destination. Check configuration; disconnect before choosing another host.\n");
      process.exitCode = 1;
    }
  ' "$HOME/.ballin-scripts/ballin.config.json" "$@"
}

download() {
  local options=(-fsSL)
  [[ "${3:-}" != progress ]] || options=(-fL --progress-bar)
  curl -q "${options[@]}" --proto '=https' --proto-redir '=https' --tlsv1.2 "$1" -o "$2"
}

checksum() {
  local expected actual
  expected=$(awk -v name="$2" '$2 == name { print $1 }' "$1")
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail 'The official download checksum is missing or ambiguous.'
  actual=$(shasum -a 256 "$scratch/$2")
  [[ "${actual%% *}" == "$expected" ]] || fail "Checksum verification failed for $2; nothing from that download was installed."
  printf '%s' "$expected"
}

normalize_process_path() {
  local remaining="$original_path" entry result='' separator=''
  # Keep the same search order across the core installer's directory changes.
  while :; do
    entry=${remaining%%:*}
    if [[ "$entry" != /* ]]; then
      [[ "$original_pwd" != *:* ]] || fail 'Relative PATH entries need a current directory without colons. Change directories or use absolute PATH entries, then try again.'
      entry="$original_pwd/${entry:-.}"
    fi
    result+="$separator$entry"
    separator=':'
    [[ "$remaining" == *:* ]] || break
    remaining=${remaining#*:}
  done
  original_normalized_path="$result"
  export PATH="$result"
}

stop_if_interrupted() {
  [[ "$1" != 130 && "$1" != 143 ]] || exit "$1"
}
probe_tool() {
  local status=0
  "$@" || status=$?
  stop_if_interrupted "$status"
  return "$status"
}
node_compatible() {
  local answer status=0
  [[ -x "$1" ]] || return 2
  answer=$(probe_tool "$1" -p "const actual = process.versions.node; const a = actual.split('.').map(Number), b = '$required_node_version'.split('.').map(Number); while(b.length < 3) b.push(0); /^[0-9]+[.][0-9]+[.][0-9]+$/.test(actual) && (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] >= b[2]))))" 2>/dev/null) || status=$?
  stop_if_interrupted "$status"
  [[ "$status" == 0 ]] || return 2
  case "$answer" in true) return 0 ;; false) return 1 ;; *) return 2 ;; esac
}

# Preserve the first executable on PATH; do not mask a broken command.
tool_on_path() {
  type -P "$1" || true
}

find_node() {
  local candidate
  for candidate in "$1" "$system_node_bin/node"; do
    if [[ "$candidate" == /* ]] && node_compatible "$candidate"; then
      printf '%s' "$candidate"
      return
    fi
  done
}

git_compatible() {
  local candidate="$1"
  if [[ "$candidate" -ef "$system_git" ]] && ! probe_tool "$system_xcode_select" -p >/dev/null 2>&1; then
    return 1
  fi
  [[ "$candidate" == /* && -x "$candidate" ]] && probe_tool "$candidate" --version >/dev/null 2>&1
}

find_git() {
  local candidate
  candidate=$(tool_on_path git)
  if [[ -n "$candidate" ]]; then
    if git_compatible "$candidate"; then printf '%s' "$candidate"; return; fi
    # Apple's placeholder is missing CLT, including aliases to the same file.
    if [[ "$candidate" -ef "$system_git" ]] && ! probe_tool "$system_xcode_select" -p >/dev/null 2>&1; then return; fi
    fail "Git at $(display_path "$candidate") cannot run. Repair your PATH or this command, then rerun Quickstart."
  fi
  if git_compatible "$system_git"; then printf '%s' "$system_git"; fi
}

npm_compatible() {
  [[ -x "$1" ]] && probe_tool "$1" --version >/dev/null 2>&1
}

gh_compatible() {
  [[ "$1" == /* && -x "$1" ]] || return 1
  probe_tool "$1" --version >/dev/null 2>&1 || return 1
  local statuses status
  if probe_tool "$1" auth status --help 2>/dev/null | grep -- '--active' >/dev/null; then return 0
  else statuses=("${PIPESTATUS[@]}"); fi
  for status in "${statuses[@]}"; do stop_if_interrupted "$status"; done
  return 1
}

find_gh() {
  local candidate
  candidate=$(tool_on_path gh)
  if [[ -n "$candidate" ]]; then
    gh_compatible "$candidate" || fail "GitHub CLI at $(display_path "$candidate") is broken or unsupported. Repair your PATH or this command, then rerun Quickstart."
    printf '%s' "$candidate"
    return
  fi
  candidate="$HOME/.local/bin/gh"
  if [[ -e "$candidate" || -L "$candidate" ]]; then
    gh_compatible "$candidate" || fail "GitHub CLI at $(display_path "$candidate") is occupied or unsupported. Inspect it and repair your PATH before retrying."
    printf '%s' "$candidate"
  fi
}

qualify_tool() {
  local name="$1" validate="$2" resolved
  resolved=$(type -P "$name") || fail "$name is not available on the final PATH. Repair your PATH, then rerun Quickstart."
  "$validate" "$resolved" || fail "$name cannot run through the final PATH: $(display_path "$resolved"). Repair your PATH or this command, then rerun Quickstart."
}

# Match Node's lexical path normalization without requiring Node before install.
normalize_absolute() {
  local rest=$1 part result=''
  local -a parts=()
  while [[ -n "$rest" ]]; do
    rest=${rest#/}; part=${rest%%/*}
    [[ "$rest" == */* ]] && rest=${rest#*/} || rest=''
    case "$part" in
      ''|.) ;;
      ..) (( ${#parts[@]} == 0 )) || unset 'parts[${#parts[@]}-1]' ;;
      *) parts+=("$part") ;;
    esac
  done
  for part in "${parts[@]}"; do result+="/$part"; done
  normalized=${result:-/}
}

select_command_bin() {
  local selected_brew selected_prefix brew_status=0
  command_bin="$local_bin"
  if selected_brew=$(type -P brew); then
    selected_prefix=$(probe_tool "$selected_brew" --prefix 2>/dev/null) || brew_status=$?
    stop_if_interrupted "$brew_status"
    if [[ "$brew_status" == 0 ]]; then
      selected_prefix="${selected_prefix%"${selected_prefix##*[![:space:]]}"}"
      [[ -n "$selected_prefix" ]] || fail "Homebrew returned an empty installation prefix. Inspect and fix $(command_reference 'brew --prefix' 2), then rerun this quickstart. PATH setup and Ballin installation have not run."
      [[ "$selected_prefix" == /* && "$selected_prefix" != *:* && "$selected_prefix" != *$'\n'* && "$selected_prefix" != *$'\r'* ]] || fail 'Homebrew returned an invalid installation prefix. Inspect brew --prefix, then rerun Quickstart.'
      normalize_absolute "$selected_prefix/bin"
      command_bin="$normalized"
    fi
  fi
}

add_path_directory() {
  local directory=$1
  if [[ ":$PATH:" != *":$directory:"* ]]; then
    export PATH="$PATH:$directory"
    if [[ -n "$command_path" ]]; then command_path+=":"; fi
    command_path+="$directory"
  fi
}

original_path_sufficient() {
  probe_tool "$node_tool" -e '
    const fs = require("fs");
    const [original, commands, ...tools] = process.argv.slice(1);
    const entries = original.split(":");
    const same = (a, b) => { try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return a === b; } };
    // Compare the preserved entry search, never the temporary Quickstart PATH.
    if (!entries.some(entry => same(entry, commands))) process.exit(1);
    for (const selected of tools.filter(Boolean)) {
      const name = selected.split("/").at(-1);
      const first = entries.map(entry => entry + "/" + name).find(file => {
        try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
      });
      if (!first || !same(first, selected)) process.exit(1);
    }
  ' "$original_normalized_path" "$command_bin" "$node_tool" "$git_tool" "$gh_tool" "$npm_tool"
}

find_suitable_brew() {
  local candidate prefix cellar repository location
  brew_tool=''; brew_prefix=''
  candidate=$(type -P brew) || return 0
  # Only normal native installations. Unknown/custom/Rosetta installations use direct routes.
  case "$machine:$candidate" in "arm64:$system_brew_arm/bin/brew"|"x86_64:$system_brew_intel/bin/brew") ;; *) return 0 ;; esac
  local candidate_prefix=${candidate%/bin/brew}
  [[ -f "$candidate_prefix/Library/Homebrew/brew.sh" || -f "$candidate_prefix/Homebrew/Library/Homebrew/brew.sh" ]] || return 0
  local translated='' translation_status=0
  translated=$("$system_sysctl" -in sysctl.proc_translated 2>/dev/null) || translation_status=$?
  [[ "$translation_status" != 130 && "$translation_status" != 143 ]] || exit "$translation_status"
  [[ "$translated" != 1 ]] || return 0
  local status=0
  prefix=$(HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 "$candidate" --prefix 2>/dev/null) || status=$?
  [[ "$status" != 130 && "$status" != 143 ]] || exit "$status"
  [[ "$status" == 0 ]] || return 0
  cellar=$(HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 "$candidate" --cellar 2>/dev/null) || status=$?
  [[ "$status" != 130 && "$status" != 143 ]] || exit "$status"
  [[ "$status" == 0 ]] || return 0
  [[ "$prefix" == "${candidate%/bin/brew}" && "$cellar" == "$prefix/Cellar" && -d "$cellar" ]] || return 0
  if [[ -f "$prefix/Library/Homebrew/brew.sh" ]]; then repository=$prefix
  elif [[ -f "$prefix/Homebrew/Library/Homebrew/brew.sh" ]]; then repository=$prefix/Homebrew
  else return 0; fi
  # Intel's /usr/local parent can be root-owned while Homebrew's own locations
  # are writable. Missing children need a writable existing ancestor to create them.
  for location in "$repository" "$repository/.git" "$cellar" \
    "$prefix"/{bin,etc,include,lib,opt,sbin,share,var/homebrew/linked,var/homebrew/locks}; do
    while [[ ! -e "$location" && ! -L "$location" ]]; do location=${location%/*}; done
    [[ -d "$location" && -w "$location" && -x "$location" ]] || return 0
  done
  # Homebrew itself requires Apple's developer tools; do not bootstrap them through brew.
  probe_tool "$system_xcode_select" -p >/dev/null 2>&1 || return 0
  brew_tool=$candidate; brew_prefix=$prefix
}

existing_hidden_node() {
  local candidate fnm_root
  # Manager installation alone proves nothing. Require an actual Node executable.
  for candidate in "$system_brew_arm"/bin/node "$system_node_bin"/node \
    "$system_brew_arm"/Cellar/node*/*/bin/node "$system_brew_intel"/Cellar/node*/*/bin/node \
    "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node \
    "${FNM_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/fnm}"/node-versions/*/installation/bin/node \
    "${MISE_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/mise}"/installs/node/*/bin/node \
    "${ASDF_DATA_DIR:-$HOME/.asdf}"/installs/nodejs/*/bin/node "${VOLTA_HOME:-$HOME/.volta}"/tools/image/node/*/bin/node; do
    if [[ -f "$candidate" || -L "$candidate" ]]; then printf '%s' "$candidate"; return; fi
  done
  # fnm retains these fallback roots when FNM_DIR is unset. An empty root is
  # not evidence of an installed runtime; require an actual Node file/link.
  if [[ -z "${FNM_DIR:-}" ]]; then
    for fnm_root in "$HOME/.fnm" "$HOME/Library/Application Support/fnm"; do
      for candidate in "$fnm_root"/node-versions/*/installation/bin/node; do
        if [[ -f "$candidate" || -L "$candidate" ]]; then printf '%s' "$candidate"; return; fi
      done
    done
  fi
}

manual_node_guidance() {
  fail "Existing Node.js at $(display_path "$1") could not be verified. Check it using its existing installation method and make a supported Node.js available on PATH, then rerun Quickstart."$'\n🔗 Node.js details:\n'"https://github.com/JBallin/ballin-scripts/blob/main/docs/optional-capabilities.md#nodejs"
}

brew_checked() {
  local status=0
  if [[ "$1" == ruby ]]; then HOMEBREW_DEV_CMD_RUN=1 "$brew_tool" "$@" || status=$?
  else "$brew_tool" "$@" || status=$?; fi
  [[ "$status" != 130 && "$status" != 143 ]] || exit "$status"
  return "$status"
}

install_brew_tools() {
  local formulas=() formula
  "$need_git" && formulas+=(git)
  "$need_gh" && formulas+=(gh)
  # Suppress automatic updates, installed-formula upgrades and cleanup;
  # preserve Homebrew's ordinary dependency and installed-dependent checks.
  export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_UPGRADE=1 HOMEBREW_NO_INSTALL_CLEANUP=1
  brew_checked info --json=v2 "${formulas[@]}" > "$scratch/brew-info.json" || fail 'Homebrew metadata could not be checked. No tools were installed; fix Homebrew and rerun Quickstart.'
  # Use Homebrew's own Ruby, including when Node is missing. Reject unavailable
  # bottles, pinned/unlinked installations and unbounded existing-Node changes.
  brew_checked ruby -rjson -e '
    data = JSON.parse(File.read(ARGV.shift)); names = ARGV
    formulas = data.fetch("formulae")
    abort "Unsupported Homebrew metadata" unless formulas.size == names.size
    formulas.each do |f|
      abort "Existing or pinned formula needs manual attention" unless names.include?(f.fetch("name")) && f.fetch("full_name") == f.fetch("name") && f.fetch("oldnames", []).empty? && f.fetch("installed").empty? && !f.fetch("pinned") && !f.fetch("keg_only")
      abort "Formula unavailable" if f["disabled"] || f["deprecated"]
      abort "No supported bottle" if f.dig("bottle", "stable", "files").to_h.empty?
    end
  ' "$scratch/brew-info.json" "${formulas[@]}" || fail 'Homebrew cannot safely install the selected tools. Review existing formulae, architecture and bottle support, then rerun Quickstart. No direct fallback was started.'
  brew_checked ruby -e '
    require "formula"; require "formula_installer"
    roots = ARGV.map { |name| Formula[name] }
    installers = roots.map { |formula| FormulaInstaller.new(formula) }
    abort "No compatible bottle" unless installers.all?(&:pour_bottle?)
    dependencies = installers.flat_map(&:compute_dependencies).map(&:to_formula).uniq
    plan = (roots + dependencies).uniq
    abort "Existing formula needs manual attention" if plan.any?(&:any_version_installed?)
    abort "No compatible dependency bottle" unless plan.all? { |formula| FormulaInstaller.new(formula).pour_bottle? }
    abort "Existing dependents need manual attention" unless plan.flat_map(&:runtime_installed_formula_dependents).empty?
  ' "${formulas[@]}" || fail "Homebrew’s installation plan needs manual attention. No selected tools were installed; inspect existing formulae and bottle support before retrying."
  phase "Installing ${formulas[*]} with Homebrew"
  printf '$ brew install --formula %s\n' "${formulas[*]}"
  brew_checked install --formula "${formulas[@]}" || fail 'Homebrew installation did not finish. Inspect its output and existing tools before retrying; no direct fallback was started.'
  for formula in "${formulas[@]}"; do
    case "$formula" in
      node) node_tool="$brew_prefix/bin/node"; node_compatible "$node_tool" || fail "Homebrew did not expose compatible Node.js ($required_node_version or newer). Inspect its links before retrying." ;;
      git) git_tool="$brew_prefix/bin/git"; git_compatible "$git_tool" || fail 'Homebrew did not expose working Git. Inspect its links before retrying.' ;;
      gh) gh_tool="$brew_prefix/bin/gh"; gh_compatible "$gh_tool" || fail 'Homebrew did not expose compatible GitHub CLI. Inspect its links before retrying.' ;;
    esac
  done
}

check_ballin_command() {
  local problem
  if ! problem=$("$node_tool" -e '
    const fs = require("fs"), path = require("path");
    const displayPath = value => value === process.env.HOME ? "~" : value.startsWith(process.env.HOME + "/") ? "~" + value.slice(process.env.HOME.length) : value;
    const directory = file => {
      try { return fs.realpathSync(file); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        return path.join(directory(path.dirname(file)), path.basename(file));
      }
    };
    // Compare pathnames, not inodes: a hard link survives checkout replacement.
    const entry = file => path.join(directory(path.dirname(file)), path.basename(file));
    try {
      const destination = entry(process.argv[1]), intended = entry(process.argv[2]);
      for (const folder of process.env.PATH.split(path.delimiter)) {
        const candidate = folder + "/ballin";
        try {
          if (entry(candidate) === destination) break; // The installer replaces this entry.
          if (!fs.statSync(candidate).isFile()) continue;
          fs.accessSync(candidate, fs.constants.X_OK);
        } catch (error) {
          if (["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes(error.code)) continue;
          throw error;
        }
        if (fs.realpathSync(candidate) === intended) break;
        process.stdout.write("Another ballin command would take precedence: " + displayPath(candidate) + ". Move or remove it, then rerun this quickstart.");
        process.exit(1);
      }
    } catch {
      process.stdout.write("Unable to inspect ballin commands on PATH. Review your PATH, then rerun this quickstart.");
      process.exit(1);
    }
  ' "$command_bin/ballin" "$HOME/.ballin-scripts/bin/ballin"); then
    fail "$problem PATH setup and authentication have not run."
  fi
}

# Keep the marker through discovery and installation in one clean privileged
# process. A private hard-link anchor identifies only the entry we created.
install_terminal_command_line_tools() {
  # shellcheck disable=SC2016 # Expand only in the clean privileged shell.
  "$system_sudo" /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/bash -c '
    set -euo pipefail
    umask 077
    marker=/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress
    stage=""
    cleanup_marker() {
      local status=$?
      trap "" HUP INT TERM
      if [[ -n "$stage" ]]; then
        if [[ "$marker" -ef "$stage/marker" ]]; then
          /bin/rm -f -- "$marker" || {
            printf "Quickstart: Could not remove the temporary CLT installation marker at %s.\n" "$marker" >&2
            [[ "$status" != 0 ]] || status=1
          }
        fi
        /bin/rm -rf -- "$stage" || { [[ "$status" != 0 ]] || status=1; }
      fi
      exit "$status"
    }
    trap cleanup_marker EXIT
    trap "exit 129" HUP
    trap "exit 130" INT
    trap "exit 143" TERM
    if [[ -e "$marker" || -L "$marker" ]]; then
      [[ -f "$marker" && ! -L "$marker" ]] || exit 1
    else
      stage=$(/usr/bin/mktemp -d /tmp/ballin-clt.XXXXXX)
      : > "$stage/marker"
      # link(1) creates exactly this entry, refusing any existing destination.
      # Unlike ln, it never treats an existing directory as a target directory.
      /bin/link "$stage/marker" "$marker"
    fi
    status=0
    updates=$(trap "exit 129" HUP; trap "exit 130" INT; trap "exit 143" TERM; /usr/sbin/softwareupdate --list) || status=$?
    case "$status" in 129|130|143) exit "$status" ;; esac
    if [[ "$status" != 0 ]]; then
      printf "The Terminal download list could not be checked (status %s).\n" "$status"
      exit "$status"
    fi
    # Select only one recognizable CLT label; never install a macOS update.
    labels=$(printf "%s\n" "$updates" | /usr/bin/awk '\''/^[[:space:]]*\* Label: Command Line Tools for Xcode[- ][0-9]/ { sub(/^[[:space:]]*\* Label: /, ""); print }'\'')
    candidates=0
    while IFS= read -r label; do
      [[ -z "$label" ]] || candidates=$(( candidates + 1 ))
    done <<< "$labels"
    if [[ "$candidates" == 0 ]]; then
      printf "No Xcode Command Line Tools download was listed in Terminal.\n"
      exit 1
    elif [[ "$candidates" != 1 ]]; then
      printf "Apple listed %s Xcode Command Line Tools downloads; choose a version manually.\n" "$candidates"
      exit 1
    fi
    printf '\''$ sudo softwareupdate --install "%s"\n'\'' "$labels"
    /usr/sbin/softwareupdate --install "$labels" || {
      status=$?
      case "$status" in 129|130|143) exit "$status" ;; esac
      printf "Xcode Command Line Tools installation failed (status %s).\n" "$status"
      exit "$status"
    }
  ' ballin-clt-install
}

install_command_line_tools() {
  phase 'Installing Xcode Command Line Tools'
  local status=0
  install_terminal_command_line_tools || status=$?
  case "$status" in 129|130|143) exit "$status" ;; esac
  git_tool=$(find_git)
  if [[ -n "$git_tool" ]]; then
    [[ "$status" == 0 ]] || fail 'Git is usable, but the Terminal attempt did not finish cleanly. Inspect the output before rerunning Quickstart.'
  else
    printf 'Git is still unavailable after the Terminal attempt (status %s).\n' "$status"
    printf "Use Apple's graphical installer, or install the tools manually and rerun Quickstart.\n"
    if ! confirm 'Open the graphical Xcode Command Line Tools installer?'; then
      "$input_ended" && fail 'No answer received. Git setup did not complete.'
      fail 'Install Xcode Command Line Tools manually, then rerun Quickstart.'
    fi
    printf '$ xcode-select --install\n'
    probe_tool "$system_xcode_select" --install || fail 'Apple could not start Xcode Command Line Tools installation. Finish any pending installation, then rerun Quickstart.'
    printf 'Finish installing Xcode Command Line Tools, then press Return here: '
    read_prompt_answer || fail 'Git setup did not complete.'
  fi
  git_tool=$(find_git)
  [[ -n "$git_tool" ]] || fail 'Git is still unavailable. Finish Xcode Command Line Tools installation, then rerun Quickstart.'
}

normalize_nvm_directory() {
  [[ "$nvm_directory" == /* && "$nvm_directory" != *:* && "$nvm_directory" != *$'\n'* && "$nvm_directory" != *$'\r'* ]] || fail 'NVM_DIR must be a safe absolute directory.'
  normalize_absolute "$nvm_directory"; nvm_directory=$normalized
}
# Resolve existing parents only before consented writes. Read-only discovery may
# inspect a linked NVM tree while the user keeps their working Node installation.
validate_nvm_directory() {
  normalize_nvm_directory
  local ancestor="$nvm_directory" physical suffix=''
  [[ ! -L "$nvm_directory" ]] || fail 'NVM_DIR is a directory symlink. Review it before configuring NVM.'
  while [[ ! -e "$ancestor" && ! -L "$ancestor" ]]; do
    suffix="/${ancestor##*/}$suffix"; ancestor=${ancestor%/*}; ancestor=${ancestor:-/}
  done
  [[ -d "$ancestor" && -O "$ancestor" && -w "$ancestor" && -x "$ancestor" ]] || fail 'NVM_DIR needs an accessible user-owned directory. Review it before configuring NVM.'
  physical=$(cd -P -- "$ancestor" && pwd -P) || fail 'Unable to resolve the NVM working directory.'
  case "$physical$suffix/" in */Cellar/*) fail 'NVM_DIR must be a user-owned directory outside Homebrew Cellar.' ;; esac
}
validate_nvm_alias_targets() {
  local entry links
  for entry in "$nvm_directory/alias" "$nvm_directory/alias/lts"; do
    [[ ! -L "$entry" && ( ! -e "$entry" || -d "$entry" ) ]] || fail 'NVM alias directories need manual repair before installation.'
  done
  for entry in "$nvm_directory/alias/default" "$nvm_directory"/alias/lts/*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    [[ -f "$entry" && ! -L "$entry" ]] || fail 'An NVM alias target is linked or unsafe. Repair it before changing the default.'
    links=$(/usr/bin/stat -f '%l' "$entry" 2>/dev/null) || links=$(/usr/bin/stat -c '%h' "$entry")
    [[ "$links" == 1 ]] || fail 'An NVM alias target has multiple hard links. Repair it before changing the default.'
  done
}

# NVM discovery is read-only. Never source Homebrew's outer nvm.sh wrapper:
# it creates the working directory and compatibility links even with --no-use.
discover_nvm() {
  local directory source candidate prefix='' status=0
  nvm_source=''; nvm_method='official'; nvm_loadable=false; nvm_follows_lts=false
  nvm_directory=${NVM_DIR:-${XDG_CONFIG_HOME:+$XDG_CONFIG_HOME/nvm}}
  nvm_directory=${nvm_directory:-$HOME/.nvm}
  normalize_nvm_directory
  for directory in "$nvm_directory" "$HOME/.nvm"; do
    source="$directory/nvm.sh"
    if [[ -f "$source" && -r "$source" ]]; then
      candidate=$source
      local hops=0 target
      while [[ -L "$candidate" && $hops -lt 40 ]]; do
        target=$(readlink "$candidate") || fail 'Unable to resolve existing NVM.'
        if [[ "$target" == /* ]]; then candidate=$target; else candidate="${candidate%/*}/$target"; fi
        (( hops += 1 ))
      done
      [[ ! -L "$candidate" ]] || fail 'Existing NVM source has a symlink cycle.'
      case "$candidate" in
        */Cellar/nvm/*/libexec/nvm.sh)
          local stable="${candidate%%/Cellar/nvm/*}/opt/nvm/libexec/nvm.sh"
          # Persist the stable source only when it identifies this installation.
          # Never load the mutating Homebrew wrapper during discovery.
          if [[ -r "$stable" && "$stable" -ef "$candidate" ]]; then candidate=$stable; fi
          ;;
      esac
      if grep -q 'libexec/nvm.sh' "$candidate" && ! grep -q 'nvm_process_parameters' "$candidate"; then continue; fi
      nvm_directory=$directory; nvm_source=$source
      case "$candidate" in */libexec/nvm.sh) nvm_source=$candidate; nvm_method=homebrew ;; esac
      break
    fi
  done
  if [[ -z "$nvm_source" ]]; then
    candidate=$(type -P brew) || candidate=''
    if [[ -n "$candidate" ]]; then
      prefix=$(HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 probe_tool "$candidate" --prefix 2>/dev/null) || status=$?
      stop_if_interrupted "$status"
      if [[ "$status" == 0 && "$prefix" == /* && "$prefix" != *$'\n'* && -r "$prefix/opt/nvm/libexec/nvm.sh" ]]; then
        nvm_source="$prefix/opt/nvm/libexec/nvm.sh"; nvm_method=homebrew
      fi
    fi
  fi
  normalize_nvm_directory
  nvm_default_exists=false
  [[ ! -e "$nvm_directory/alias/default" && ! -L "$nvm_directory/alias/default" ]] || nvm_default_exists=true
  [[ -n "$nvm_source" ]] || return 0
  local probe="$scratch/nvm-probe" version alias='default' seen=':' target
  mkdir -p "$probe/versions/node"
  mkdir -p "$probe/alias/lts"
  local entry count=0
  for entry in "$nvm_directory"/alias/* "$nvm_directory"/alias/.[!.]* "$nvm_directory"/alias/..?*; do
    [[ -f "$entry" && ! -L "$entry" ]] || continue
    (( count += 1 )); (( count <= 1000 )) || break
    local bytes
    bytes=$(/usr/bin/stat -f '%z' "$entry" 2>/dev/null) || bytes=$(/usr/bin/stat -c '%s' "$entry")
    (( bytes <= 4096 )) || continue
    cp "$entry" "$probe/alias/${entry##*/}"
  done
  if [[ ! -L "$nvm_directory/alias/lts" ]]; then
    for entry in "$nvm_directory"/alias/lts/*; do
      [[ -f "$entry" && ! -L "$entry" ]] || continue
      (( count += 1 )); (( count <= 1000 )) || break
      bytes=$(/usr/bin/stat -f '%z' "$entry" 2>/dev/null) || bytes=$(/usr/bin/stat -c '%s' "$entry")
      (( bytes <= 4096 )) || continue
      cp "$entry" "$probe/alias/lts/${entry##*/}"
    done
  fi
  for version in "$nvm_directory"/versions/node/v*; do
    [[ -f "$version/bin/node" ]] || continue
    mkdir -p "$probe/versions/node/${version##*/}/bin"
    printf '#!/bin/sh\nexit 97\n' > "$probe/versions/node/${version##*/}/bin/node"
    chmod 700 "$probe/versions/node/${version##*/}/bin/node"
  done
  local result=''
  result=$(HOME="$scratch" NVM_DIR="$probe" BASH_ENV='' ENV='' /bin/bash --noprofile --norc -c \
    '. "$1" --no-use >/dev/null && declare -F nvm >/dev/null || exit 1; printf "loadable\n"; nvm version default' ballin-nvm-probe "$nvm_source") || status=$?
  stop_if_interrupted "$status"
  [[ "$result" == loadable || "$result" == loadable$'\n'* ]] || fail 'Existing NVM could not be loaded. Repair its source before retrying Quickstart.'
  nvm_loadable=true
  for (( hops=0; hops<40; hops++ )); do
    if [[ "$alias" == 'lts/*' ]]; then
      [[ "$status" != 0 ]] || nvm_follows_lts=true
      break
    fi
    [[ "$alias" =~ ^[a-zA-Z0-9_.-]+$ && "$alias" != . && "$alias" != .. && "$seen" != *":$alias:"* ]] || break
    seen+="$alias:"
    [[ -f "$probe/alias/$alias" && ! -L "$probe/alias/$alias" ]] || break
    target=$(cat "$probe/alias/$alias") || break
    alias=$target
  done
}

plan_nvm() {
  local compatible=$1
  use_nvm=false; nvm_profile_needed=false
  discover_nvm
  if [[ "$compatible" == true && "$nvm_follows_lts" == true && "$node_tool" == "$nvm_directory"/versions/node/*/bin/node ]]; then return; fi
  printf '\nNVM can install and maintain latest LTS Node.\n'
  if [[ "$nvm_loadable" != true ]]; then
    if [[ -n "$brew_tool" ]]; then printf '$ brew install --formula nvm\n'
    else printf '$ PROFILE=/dev/null bash <downloaded official NVM v0.40.8 installer>\n'; fi
  fi
  printf '$ nvm install --lts\n'
  if "$nvm_default_exists"; then printf 'The existing NVM default will be changed to follow latest LTS.\n'; printf "$ nvm alias default 'lts/*'\n"; fi
  printf 'This activates LTS here and makes it the default for future terminals.\n'
  printf 'Older Node installations and versions remain installed. Global npm packages\nmay need to be reinstalled for the selected Node version.\n'
  printf 'Shell startup changes require separate permission.\n'
  if ! confirm 'Use NVM and latest LTS Node?'; then
    if [[ "$compatible" != true ]]; then
      "$input_ended" && fail 'No answer received. Node.js setup stopped.'
      fail 'A compatible Node.js is required. Activate or install one, then rerun Quickstart.'$'\n🔗 Node.js details:\nhttps://github.com/JBallin/ballin-scripts/blob/main/docs/optional-capabilities.md#nodejs'
    fi
    return
  fi
  validate_nvm_directory
  validate_nvm_alias_targets
  use_nvm=true; nvm_profile_needed=true
}

install_nvm_lts() {
  phase 'Setting up NVM and LTS Node'
  validate_nvm_directory
  validate_nvm_alias_targets
  if [[ -z "$nvm_source" ]]; then
    # Existing unrelated content is not consent to replace an installation.
    if [[ -e "$nvm_directory" ]] && [[ -n "$(ls -A "$nvm_directory")" ]]; then
      fail 'The NVM directory is occupied without a loadable NVM installation. Inspect it before retrying.'
    fi
    if [[ -n "$brew_tool" ]]; then
      printf '$ brew install --formula nvm\n'
      HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_UPGRADE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew_checked install --formula nvm
      nvm_source="$brew_prefix/opt/nvm/libexec/nvm.sh"; nvm_method=homebrew
      [[ -r "$nvm_source" ]] || fail 'Homebrew NVM source was not installed at its stable prefix.'
    else
      mkdir -p "$nvm_directory"
      download 'https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh' "$scratch/nvm-install.sh"
      if [[ ! -s "$scratch/nvm-install.sh" ]] || ! /bin/bash -n "$scratch/nvm-install.sh"; then
        fail 'The official NVM installer is empty or incomplete.'
      fi
      printf '$ PROFILE=/dev/null NVM_DIR=%q bash %q\n' "$nvm_directory" "$scratch/nvm-install.sh"
      # NVM installer overrides must not redirect the promised source or install
      # an inherited NODE_VERSION. Keep unrelated caller/auth environment intact.
      ( unset NVM_SOURCE NVM_INSTALL_VERSION NVM_INSTALL_GITHUB_REPO NODE_VERSION NVM_NODEJS_ORG_MIRROR NVM_IOJS_ORG_MIRROR NVM_AUTH_HEADER NVM_METHOD NVM_ENV NVM_CD_FLAGS
        PROFILE=/dev/null NVM_DIR="$nvm_directory" METHOD=git BASH_ENV='' ENV='' /bin/bash "$scratch/nvm-install.sh" )
      nvm_source="$nvm_directory/nvm.sh"
    fi
  fi
  if [[ "$nvm_method" == homebrew ]]; then
    # Initialize fresh and discovered Homebrew installations only after consent.
    # Preserve every existing entry, including dangling links and directories.
    mkdir -p "$nvm_directory"
    if [[ ! -e "$nvm_directory/nvm.sh" && ! -L "$nvm_directory/nvm.sh" ]]; then
      ln -s "$nvm_source" "$nvm_directory/nvm.sh"
    fi
    if [[ ! -e "$nvm_directory/nvm-exec" && ! -L "$nvm_directory/nvm-exec" ]]; then
      ln -s "${nvm_source%/nvm.sh}/nvm-exec" "$nvm_directory/nvm-exec"
    fi
  fi
  export NVM_DIR="$nvm_directory"
  # Activation must occur in this Bash process, never a subshell or user profile.
  unset -f nvm
  local nvm_status=0
  # The selected source is discovered and checked before consented activation.
  # shellcheck source=/dev/null
  . "$nvm_source" --no-use || nvm_status=$?
  stop_if_interrupted "$nvm_status"
  [[ "$nvm_status" == 0 ]] || fail 'Unable to load NVM. Repair its source before retrying Quickstart.'
  declare -F nvm >/dev/null || fail 'The installed NVM source did not define nvm.'
  printf '$ nvm install --lts\n'
  unset NVM_NODEJS_ORG_MIRROR NVM_IOJS_ORG_MIRROR NVM_AUTH_HEADER
  nvm install --lts || nvm_status=$?
  stop_if_interrupted "$nvm_status"
  if [[ "$nvm_status" != 0 ]]; then
    printf '\nQuickstart: NVM LTS installation did not finish. Inspect its output, then rerun Quickstart.\n' >&2
    return "$nvm_status"
  fi
  if "$nvm_default_exists"; then
    printf "$ nvm alias default 'lts/*'\n"
    nvm alias default 'lts/*'
  fi
  node_tool=$(type -P node) || fail 'NVM did not activate Node.'
  node_compatible "$node_tool" || fail "Latest NVM LTS does not satisfy Ballin's Node.js requirement."
  npm_tool=$(type -P npm) || fail 'NVM did not provide npm.'
  npm_compatible "$npm_tool" || fail 'NVM npm could not run.'
  local resolved_default current
  resolved_default=$(nvm version default)
  current=$(node --version)
  [[ "$resolved_default" == "$current" ]] || fail 'NVM default and active Node differ. Inspect them before retrying.'
  # Do not add this version-specific bin directory to persistent command_path.
}

install_gh() {
  phase 'Installing GitHub CLI'
  local version archive directory
  download 'https://api.github.com/repos/cli/cli/releases/latest' "$scratch/gh-release.json"
  version=$("$node_tool" -e '
    const release = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    if (release.draft || release.prerelease || !/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(release.tag_name)) process.exit(1);
    process.stdout.write(release.tag_name.slice(1));
  ' "$scratch/gh-release.json")
  archive="gh_${version}_macOS_${gh_arch}.zip"
  directory=${archive%.zip}
  [[ ! -e "$local_bin/gh" && ! -L "$local_bin/gh" ]] || fail "GitHub CLI destination $(display_path "$local_bin/gh") is occupied. Inspect it before retrying."
  printf 'Downloading GitHub CLI %s...\n' "$version"
  download "https://github.com/cli/cli/releases/download/v$version/gh_${version}_checksums.txt" "$scratch/gh-checksums.txt"
  download "https://github.com/cli/cli/releases/download/v$version/$archive" "$scratch/$archive" progress
  checksum "$scratch/gh-checksums.txt" "$archive" >/dev/null
  mkdir "$scratch/gh-extract"
  ditto -x -k "$scratch/$archive" "$scratch/gh-extract"
  local binary="$scratch/gh-extract/$directory/bin/gh"
  [[ -d "$scratch/gh-extract/$directory" && ! -L "$scratch/gh-extract/$directory" \
    && -d "$scratch/gh-extract/$directory/bin" && ! -L "$scratch/gh-extract/$directory/bin" \
    && -f "$binary" && ! -L "$binary" && -x "$binary" ]] \
    || fail 'The GitHub CLI archive has an unexpected layout or executable.'
  # file is supplied by macOS and does not require Command Line Tools.
  local architecture_description status=0
  architecture_description=$(LC_ALL=C probe_tool "$system_file" -b "$binary" 2>/dev/null) || status=$?
  stop_if_interrupted "$status"
  # Universal-binary detail lines can contain the input filename.
  architecture_description=${architecture_description%%$'\n'*}
  [[ "$status" == 0 && "$architecture_description" =~ Mach-O[[:space:]]64-bit[[:space:]]executable[[:space:]]${machine}([^[:alnum:]_]|$) ]] \
    || fail 'The GitHub CLI archive does not contain the expected native architecture.'
  gh_compatible "$binary" || fail 'The downloaded GitHub CLI cannot run or is unsupported.'
  mkdir -p "$local_bin"
  gh_temp=$(mktemp "$local_bin/.gh.XXXXXX") || fail 'Unable to stage GitHub CLI.'
  cp "$binary" "$gh_temp"
  chmod 755 "$gh_temp"
  # linkSync is exclusive even if the destination becomes a directory or link.
  "$node_tool" -e 'require("fs").linkSync(process.argv[1], process.argv[2])' "$gh_temp" "$local_bin/gh" \
    || fail "Could not install GitHub CLI at $(display_path "$local_bin/gh"); inspect the destination before retrying."
  rm -f -- "$gh_temp"; gh_temp=''
  gh_tool="$local_bin/gh"
}

path_incomplete() {
  path_setup_complete=false
  printf '\nPersistent PATH setup incomplete: %s\n' "$1" >&2
  printf 'The startup file was left unchanged. Setup can continue with the current process PATH.\n' >&2
  printf 'Review your shell startup and PATH setup, or rerun this quickstart to retry.\n' >&2
}

manual_nvm_guidance() {
  if [[ "${nvm_profile_needed:-false}" == true && "${path_setup_complete:-false}" != true ]]; then
    printf 'Activate NVM in your shell startup file before running Ballin in a new Terminal.\nUse this NVM working directory:\n'
    printf 'export NVM_DIR=%q\n' "$nvm_directory"
    printf '🔗 NVM activation:\nhttps://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md#manual-nvm-activation\n'
  fi
}

profile_unchanged() {
  "$node_tool" -e '
    const fs = require("fs");
    const [file, snapshot, metadata] = process.argv.slice(1);
    try {
      const before = JSON.parse(fs.readFileSync(metadata));
      const parent = fs.lstatSync(require("path").dirname(file));
      if (!parent.isDirectory() || parent.dev !== before.parent.dev || parent.ino !== before.parent.ino) process.exit(1);
      let current = null;
      try { current = fs.lstatSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const keys = ["dev", "ino", "mode", "nlink", "size", "mtimeMs", "ctimeMs"];
      if (before.file === null) process.exit(current === null ? 0 : 1);
      if (!current?.isFile() || current.nlink !== 1 || keys.some(key => current[key] !== before.file[key])
        || !fs.readFileSync(file).equals(fs.readFileSync(snapshot))) process.exit(1);
    } catch { process.exit(1); }
  ' "$profile" "$scratch/profile-original" "$scratch/profile-metadata"
}

# Recognize our exact line; other directory references need manual review.
profile_has_path() {
  "$node_tool" -e '
    const fs = require("fs"), path = require("path");
    const [file, exact, commands, home, snapshot, metadata] = process.argv.slice(1);
    try {
      const parent = fs.lstatSync(path.dirname(file));
      if (!parent.isDirectory()) process.exit(1);
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      let text, contents, stat;
      try {
        stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) process.exit(1);
        contents = fs.readFileSync(fd);
        text = contents.toString("utf8");
      } finally { fs.closeSync(fd); }
      const lines = text.split("\n");
      const exactLine = lines.includes(exact);
      const directories = [".local/share/ballin-quickstart/bin", ...commands.split(":")];
      // Literal suffixes cover common HOME/tilde spellings without interpreting shell code.
      for (const directory of commands.split(":")) {
        const relative = path.relative(home, directory);
        if (relative && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative)) directories.push(relative);
      }
      const referenced = directories.some(directory => directory && text.includes(directory));
      if (exactLine || referenced) {
        fs.writeFileSync(snapshot, contents);
        fs.writeFileSync(metadata, JSON.stringify({ parent, file: stat }));
        process.exit(exactLine ? 0 : 2);
      }
      process.exit(1);
    } catch { process.exit(1); }
  ' "$1" "$line" "$command_path" "$HOME" "$scratch/profile-original" "$scratch/profile-metadata" 2>/dev/null
}

check_existing_path() {
  local status=0
  profile_has_path "$profile" || status=$?
  [[ "$status" == 0 || "$status" == 2 ]] || return 1
  # Before selection, only the exact managed line can skip the location prompt.
  [[ "$status" != 2 || "${1:-}" == selected ]] || return 1
  if ! profile_unchanged; then
    path_incomplete 'The startup file changed during setup. Review it before retrying.'
    return 0
  fi
  if [[ "$status" == 0 ]]; then
    path_setup_complete=true
  else
    path_incomplete "$(display_path "$profile") already mentions a setup directory. Review its PATH entries before changing PATH."$'\n🔗 Manual setup:\n'"https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md#manual-path-setup"
  fi
  return 0
}

configure_path() {
  phase 'Setting up shell startup'
  local command_escaped line choice candidate original default_directory login_profile
  command_escaped=${command_path//\'/\'\\\'\'}
  line="export PATH=\$PATH:'$command_escaped'"
  local nvm_block='' nvm_escaped source_escaped completion_escaped append_path=true
  if [[ "${nvm_profile_needed:-false}" == true ]]; then
    if [[ "$nvm_method" == homebrew && "$nvm_source" == */Cellar/nvm/*/libexec/nvm.sh ]]; then
      path_incomplete 'The Homebrew NVM source has no verified stable path. Review NVM startup before changing shell settings.'
      return
    fi
    nvm_escaped=${nvm_directory//\'/\'\\\'\'}
    source_escaped=${nvm_source//\'/\'\\\'\'}
    local completion="$nvm_directory/bash_completion"
    if [[ "$nvm_method" == homebrew ]]; then
      completion="${nvm_source%/nvm.sh}/etc/bash_completion.d/nvm"
      [[ "$nvm_source" != */libexec/nvm.sh ]] || completion="${nvm_source%/libexec/nvm.sh}/etc/bash_completion.d/nvm"
    fi
    completion_escaped=${completion//\'/\'\\\'\'}
    printf -v nvm_block '%s\n' '# NVM (Ballin Quickstart)' "export NVM_DIR='$nvm_escaped'" \
      "[ ! -s '$source_escaped' ] || . '$source_escaped' --no-use" \
      'if command -v nvm >/dev/null 2>&1; then nvm use --silent default; fi' \
      "if [ -n \"\${BASH_VERSION:-}\" ] && [ -r '$completion_escaped' ]; then . '$completion_escaped'; fi"
  fi
  profile_shell=${SHELL:-}
  if [[ "$profile_shell" != /* || ! -f "$profile_shell" || ! -x "$profile_shell" ]]; then
    path_incomplete 'Select an executable Bash or zsh in SHELL before retrying.'; return
  fi
  case "${profile_shell##*/}" in
    zsh)
      default_directory="$HOME"
      if [[ "${ZDOTDIR:-}" == /* && "$ZDOTDIR" != *$'\n'* && "$ZDOTDIR" != *$'\r'* ]]; then
        default_directory="$ZDOTDIR"
      fi
      if [[ "$default_directory" == "$HOME" ]]; then
        printf 'Zsh settings directory '; prompt_options 'Enter for home (~), an absolute directory, or skip'; printf ': '
      else
        printf 'Zsh settings directory '; prompt_options "Enter for $(display_path "$default_directory"), another absolute directory, or skip"; printf ': '
      fi
      if ! read_prompt_answer; then path_setup_complete=false; printf 'PATH setup skipped.\n'; return; fi
      choice=$prompt_answer
      [[ "$choice" != skip ]] || { path_setup_complete=false; printf 'PATH setup skipped.\n'; return; }
      [[ -n "$choice" ]] || choice="$default_directory"
      [[ "$choice" != home ]] || choice="$HOME"
      if [[ "$choice" != /* || "$choice" == *$'\n'* || "$choice" == *$'\r'* ]]; then path_incomplete 'No absolute zsh startup directory selected.'; return; fi
      profile="${choice%/}/.zshrc"
      ;;
    bash)
      profile="$HOME/.bash_profile"
      for candidate in .bash_profile .bash_login .profile; do
        if [[ -e "$HOME/$candidate" || -L "$HOME/$candidate" ]]; then profile="$HOME/$candidate"; break; fi
      done
      if [[ "${nvm_profile_needed:-false}" != true ]] && check_existing_path; then return; fi
      login_profile="$profile"
      profile="$HOME/.bashrc"
      if [[ "${nvm_profile_needed:-false}" != true ]] && check_existing_path; then return; fi
      profile="$login_profile"
      printf 'Which Bash startup file does your terminal read? '; prompt_options 'login/bashrc; Enter to skip'; printf ' '
      read_prompt_answer || prompt_answer=''
      choice=$prompt_answer
      case "$choice" in
        bashrc) profile="$HOME/.bashrc" ;;
        login) ;; # First existing login file selected above.
        '') path_setup_complete=false; printf 'PATH setup skipped.\n'; return ;;
        *) path_incomplete 'No Bash startup file selected.'; return ;;
      esac
      ;;
    *) path_incomplete 'Automatic PATH setup supports Bash and zsh. Configure the equivalent PATH for your shell, or retry in Bash/zsh.'; return ;;
  esac
  local syntax_check=("$profile_shell" -n)
  # Parsing only: never follow option changes or infer runtime reachability.
  if [[ "${profile_shell##*/}" == bash ]]; then syntax_check+=(-O extglob)
  else syntax_check+=(-f); fi
  original="$scratch/profile-original"
  if ! "$node_tool" -e '
    const fs = require("fs");
    const [file, snapshot, metadata, line, check] = process.argv.slice(1);
    const parent = fs.lstatSync(require("path").dirname(file));
    if (!parent.isDirectory()) throw new Error("Startup directory is not a regular directory");
    let stat = null;
    let contents = Buffer.alloc(0);
    try {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new Error("Startup file is not a regular file");
        if (stat.nlink !== 1) throw new Error("Startup file has multiple hard links");
        contents = fs.readFileSync(fd);
      } finally { fs.closeSync(fd); }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    fs.writeFileSync(snapshot, contents);
    fs.writeFileSync(metadata, JSON.stringify({ parent, file: stat }));
    const text = contents.toString("utf8");
    const trailing = text.match(/(\\+)(?:\r?\n)?$/u)?.[1];
    if (trailing && trailing.length % 2 !== 0) {
      fs.writeFileSync(check + ".continuation", text.replace(/\r?\n$/u, "") + " )\n");
    }
    fs.writeFileSync(check, Buffer.concat([contents, Buffer.from("\n)\n")]));
  ' "$profile" "$original" "$scratch/profile-metadata" "$line" "$scratch/profile-boundary" 2>/dev/null; then
    path_incomplete 'The startup file or directory could not be safely inspected.'; return
  fi
  if ! profile_unchanged; then path_incomplete 'The startup file changed during setup. Review it before retrying.'; return; fi
  # Reuse the explicit location choice later, with separate completion permission.
  selected_profile="$profile"
  # Literal presence is not evidence that the shell executes this line.
  if [[ "${nvm_profile_needed:-false}" != true ]]; then
    if check_existing_path selected; then return; fi
  else
    # A recognizable managed block may be reused; arbitrary personal NVM code
    # needs manual review rather than a second conflicting initialization.
    local nvm_profile_status=0
    "$node_tool" -e '
      const fs = require("fs"); const [file, block] = process.argv.slice(1);
      const text = fs.readFileSync(file, "utf8");
      const managed = text.includes(block);
      const remainder = managed ? text.replace(block, "") : text;
      if (/NVM_DIR|nvm\.sh|nvm use|versions\/node\//u.test(remainder)) process.exit(2);
      process.exit(managed ? 0 : 1);
    ' "$original" "$nvm_block" || nvm_profile_status=$?
    if [[ "$nvm_profile_status" == 2 ]]; then
      path_incomplete 'Existing NVM startup code needs manual review. Load NVM with --no-use, then select its default after earlier startup selections.'; return
    fi
    local existing_path_status=0
    profile_has_path "$profile" || existing_path_status=$?
    if [[ "$existing_path_status" == 2 ]]; then
      path_incomplete 'Existing Ballin PATH entries need manual review before adding NVM startup.'; return
    fi
    [[ "$nvm_profile_status" != 0 ]] || nvm_block=''
    if grep -Fxq -- "$line" "$original" || [[ -z "$command_path" ]]; then append_path=false; fi
    if [[ -z "$nvm_block" && "$append_path" == false ]]; then return; fi
  fi
  # Small append-boundary checks: syntax must parse, a trailing backslash must
  # be inert (for example in a comment), and EOF must expose an invalid token.
  if ! "${syntax_check[@]}" "$original" >/dev/null 2>&1; then
    path_incomplete 'The non-executing check could not confirm a safe append boundary.'; return
  fi
  if [[ -f "$scratch/profile-boundary.continuation" ]] \
    && ! "${syntax_check[@]}" "$scratch/profile-boundary.continuation" >/dev/null 2>&1; then
    path_incomplete 'The startup file may end at an unfinished continuation.'; return
  fi
  if "${syntax_check[@]}" "$scratch/profile-boundary" >/dev/null 2>&1; then
    path_incomplete 'The startup file may end at an unfinished heredoc.'; return
  fi
  if ! confirm "Add Ballin setup to $(display_path "$profile") so it works in new Terminal windows?"; then
    path_setup_complete=false; printf 'PATH setup skipped.\n'; return
  fi
  if ! profile_unchanged; then path_incomplete 'The startup file changed during setup. Review it before retrying.'; return; fi
  if ! profile_temp=$(mktemp "$profile.ballin-quickstart.XXXXXX"); then
    path_incomplete 'A temporary startup file could not be created.'; return
  fi
  if [[ -f "$profile" ]]; then
    if ! cp -p "$profile" "$profile_temp" || ! cmp -s "$profile_temp" "$original"; then
      path_incomplete 'The startup file changed or could not be copied.'; return
    fi
  fi
  if [[ -s "$original" ]] && ! printf '\n' >> "$profile_temp"; then
    path_incomplete 'The proposed append could not be written.'; return
  fi
  if [[ -n "$nvm_block" ]]; then printf '%s\n\n' "$nvm_block" >> "$profile_temp"; fi
  if ! grep -Fxq '# https://github.com/JBallin/ballin-scripts' "$original"; then
    printf '# Ballin\n# https://github.com/JBallin/ballin-scripts\n' >> "$profile_temp"
  fi
  if "$append_path"; then printf '%s\n' "$line" >> "$profile_temp"; fi
  if ! "${syntax_check[@]}" "$profile_temp" >/dev/null 2>&1; then
    path_incomplete 'The proposed append could not be checked.'; return
  fi
  if ! profile_unchanged; then path_incomplete 'The startup file changed during setup. Review it before retrying.'; return; fi
  if ! mv "$profile_temp" "$profile"; then path_incomplete 'The startup file could not be replaced.'; return; fi
  profile_temp=''
}

main() {
  [[ "$(uname -s)" == Darwin ]] || fail 'This quickstart is for macOS.'
  ballin_select "$@" || return $?
  required_node_version=$ballin_minimum
  local approved_root='' approved_command='' approved_snapshot='' exposed_npm os_version major minor machine git_tool need_git need_node need_gh repo path_node local_bin command_path='' destination npm_tool='' path_setup_complete=true selected_profile='' backup_hostname=''
  [[ "$(uname -s)" == Darwin ]] || fail 'This quickstart is for macOS.'
  [[ "${HOME:-}" == /* && "$HOME" != *:* && "$HOME" != *$'\n'* ]] || fail 'HOME must be an absolute path without colons or newlines.'
  os_version=$(sw_vers -productVersion)
  IFS=. read -r major minor _ <<< "$os_version"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || fail 'Unable to identify the macOS version.'
  (( major > 13 || (major == 13 && minor >= 5) )) || fail 'This quickstart requires macOS 13.5 or newer.'
  machine=$(uname -m)
  case "$machine" in
    arm64) gh_arch='arm64' ;;
    x86_64) gh_arch='amd64' ;;
    *) fail "Unsupported Mac architecture: $machine." ;;
  esac
  normalize_process_path
  # Select executable tools and keep child installers from importing overrides.
  unset -f git node npm gh nvm
  normalize_absolute "$HOME/.local/bin"
  local_bin="$normalized"
  phase 'Setting up Ballin'
  backup_choice=no
  if confirm 'Set up backups to GitHub?' y; then backup_choice=yes
  elif "$input_ended"; then printf "Quickstart stopped. Rerun it when you’re ready.\n"; return 0
  else
    printf 'Backup setup skipped. Run '
    command_reference 'ballin backup setup'
    printf " when you’re ready.\n"
  fi
  phase 'Checking required tools'
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/ballin-quickstart.XXXXXX")
  active_node=$(type -P node) || active_node=''
  local active_node_status=0 compatible=false
  node_tool="$active_node"
  if [[ -n "$active_node" ]]; then
    node_compatible "$active_node" || active_node_status=$?
    [[ "$active_node_status" != 2 ]] || manual_node_guidance "$active_node"
    [[ "$active_node_status" != 0 ]] || compatible=true
  else
    node_tool=$(find_node '')
    if [[ -n "$node_tool" ]]; then compatible=true
    else
      hidden_node=$(existing_hidden_node)
      if [[ -n "$hidden_node" ]]; then
        local hidden_status=0
        node_compatible "$hidden_node" || hidden_status=$?
        [[ "$hidden_status" != 2 ]] || manual_node_guidance "$hidden_node"
      fi
    fi
  fi
  path_node="$active_node"
  find_suitable_brew
  if [[ -n "$path_node" && "$compatible" == true ]]; then
    local recheck=0
    node_compatible "$path_node" || recheck=$?
    [[ "$recheck" != 2 ]] || manual_node_guidance "$path_node"
    [[ "$recheck" != 1 ]] || compatible=false
  fi
  plan_nvm "$compatible"
  if "$input_ended"; then printf "Quickstart stopped. Rerun it when you’re ready.\n"; return 0; fi
  gh_tool=''
  [[ "$backup_choice" != yes ]] || gh_tool=$(find_gh)
  git_tool=$(find_git)
  need_git=false; need_node=false; need_gh=false
  [[ -n "$git_tool" ]] || need_git=true
  [[ "$use_nvm" != true ]] || need_node=true
  [[ "$backup_choice" != yes || -n "$gh_tool" ]] || need_gh=true
  # Compute the complete child PATH before previewing the core installer target.
  if [[ -n "$node_tool" && "$node_tool" != "$path_node" && "$use_nvm" != true ]]; then add_path_directory "${node_tool%/*}"; fi
  if [[ -n "$git_tool" ]]; then add_path_directory "${git_tool%/*}"
  elif "$need_git" && [[ -z "$brew_tool" ]]; then add_path_directory "${system_git%/*}"; fi
  if [[ -n "$gh_tool" ]]; then add_path_directory "${gh_tool%/*}"
  elif "$need_gh" && [[ -z "$brew_tool" ]]; then add_path_directory "$local_bin"; fi
  select_command_bin
  add_path_directory "$command_bin"
  # The first addition can expose Homebrew and change the command destination.
  select_command_bin
  add_path_directory "$command_bin"
  if "$need_git" || "$need_node" || "$need_gh"; then
    prerequisite_names=''
    prerequisite_list=()
    if "$need_git"; then
      if [[ -n "$brew_tool" ]]; then prerequisite_list+=(Git); else prerequisite_list+=('Xcode Command Line Tools'); fi
    fi
    "$need_node" && prerequisite_list+=('NVM and latest LTS Node')
    "$need_gh" && prerequisite_list+=('GitHub CLI')
    for (( index=0; index<${#prerequisite_list[@]}; index++ )); do
      if (( index > 0 )); then
        if (( index == ${#prerequisite_list[@]} - 1 )); then
          (( ${#prerequisite_list[@]} < 3 )) || prerequisite_names+=','
          prerequisite_names+=' and '
        else prerequisite_names+=', '; fi
      fi
      prerequisite_names+=${prerequisite_list[index]}
    done
    printf 'Installation will:\n'
    if [[ -n "$brew_tool" ]]; then
      printf '  - Install missing tools and dependencies using existing Homebrew: %s\n' "$prerequisite_names"
    else
      if "$need_git"; then
        printf '  - Install Xcode Command Line Tools\n'
      fi
      if "$need_node"; then
        printf '  - Set up NVM and latest LTS Node in %s\n' "$(display_path "$nvm_directory")"
      fi
      if "$need_gh"; then
        printf '  - Install GitHub CLI in %s\n' "$(display_path "$local_bin")"
      fi
    fi
    approved_root=''; approved_command=''; approved_snapshot=''
    if [[ ! -d "$HOME/.ballin-scripts" ]]; then
      approved_root="$HOME/.ballin-scripts"
      approved_command="$command_bin/ballin"
      approved_snapshot=$(command_entry_snapshot "$approved_command") || fail "Refusing to replace an unsafe command entry at $(display_path "$approved_command")."
      printf '  - Create Ballin and its settings in %s\n' "$(display_path "$approved_root")"
      printf '  - Link the Ballin command in %s\n' "$(display_path "$command_bin")"
      if [[ "$approved_snapshot" != missing ]]; then
        printf 'Warning: installation will replace the existing command at %s' "$(display_path "$approved_command")"
        if [[ -L "$approved_command" ]]; then printf ' (link target: %s)' "$(display_path "$(readlink "$approved_command")")"; fi
        printf '.\n'
      fi
    fi
    documentation_pointer 'Installation details' 'https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md#what-installation-changes'
    if ! confirm 'Proceed with installation?'; then
      "$input_ended" && fail 'No answer received. Quickstart stopped before installing prerequisites.'
      printf "\nPrerequisite installation skipped.\nRerun Quickstart when you’re ready.\n"
      return 0
    fi
  fi
  if [[ -n "$brew_tool" ]] && { "$need_git" || "$need_gh"; }; then
    install_brew_tools
  else
  if "$need_git"; then
    install_command_line_tools
  fi
  fi
  "$use_nvm" && install_nvm_lts
  if [[ -z "$brew_tool" ]] && "$need_gh"; then install_gh; fi
  # Validate what all child processes will actually resolve after every PATH addition.
  qualify_tool node node_compatible
  node_tool=$(type -P node)
  qualify_tool git git_compatible
  git_tool=$(type -P git)
  if [[ "$backup_choice" == yes ]]; then qualify_tool gh gh_compatible; gh_tool=$(type -P gh); fi
  if exposed_npm=$(type -P npm) && [[ -f "$exposed_npm" && -x "$exposed_npm" ]]; then
    npm_tool="$exposed_npm"
    npm_compatible "$npm_tool" || fail "npm cannot run through the final PATH: $(display_path "$npm_tool"). Fix or remove this broken command, then rerun this quickstart. PATH setup and authentication have not run."
  fi
  check_ballin_command
  if [[ "$backup_choice" == yes ]]; then
    backup_hostname=$(backup_setup_host) || return $?
    if [[ -z "$backup_hostname" ]]; then
      printf 'GitHub hostname '; prompt_options 'github.com'; printf ': '
      if ! read_prompt_answer; then printf "Quickstart stopped. Rerun it when you’re ready.\n"; return 0; fi
      backup_hostname=$(backup_setup_host "${prompt_answer:-github.com}") || return $?
    fi
  fi
  if [[ "$nvm_profile_needed" == true ]] || ! original_path_sufficient; then
    configure_path
    manual_nvm_guidance
  fi
  if "$input_ended"; then printf "Quickstart stopped. Rerun it when you’re ready.\n"; return 0; fi
  if [[ "$backup_choice" == yes ]]; then
    auth_status=0
    "$gh_tool" auth status --active --hostname "$backup_hostname" >/dev/null 2>&1 || auth_status=$?
    if [[ "$auth_status" == 130 || "$auth_status" == 143 ]]; then exit "$auth_status"; fi
    if [[ "$auth_status" != 0 ]]; then
      phase 'Signing in to GitHub'
      printf '$ gh auth login --hostname %s --git-protocol https --web\n' "$backup_hostname"
      GH_NO_UPDATE_NOTIFIER=1 "$gh_tool" auth login --hostname "$backup_hostname" --git-protocol https --web
    fi
  fi
  repo="$HOME/.ballin-scripts"
  download "https://raw.githubusercontent.com/JBallin/ballin-scripts/$ballin_sha/install.sh" "$scratch/install.sh"
  # Keep startup hooks from replacing the tools qualified above.
  result_file="$scratch/installation-result"
  printf 'pending\n' > "$result_file"
  BALLIN_APPROVED_INSTALL_ROOT="$approved_root" BALLIN_APPROVED_INSTALL_COMMAND="$approved_command" BALLIN_APPROVED_INSTALL_SNAPSHOT="$approved_snapshot" BALLIN_SETUP_PROFILE="$selected_profile" BALLIN_DEFER_TERMINAL_GUIDANCE=1 BALLIN_BACKUP_CHOICE="$backup_choice" BALLIN_BACKUP_HOSTNAME="$backup_hostname" BALLIN_SETUP_RESULT_FILE="$result_file" BASH_ENV='' bash "$scratch/install.sh" --ballin-resolved-v1 "$ballin_kind" "$ballin_value" "$ballin_sha" "$ballin_minimum" "$ballin_release_id" install
  result=$(cat "$result_file")
  [[ "$result" != cancelled ]] || return 0
  case "$result" in 'complete configured open'|'complete configured ended'|'complete configured failed'|'complete skipped open'|'complete skipped ended'|'complete skipped failed') ;; *) fail 'Installation outcome could not be verified. Review the installation before retrying.' ;; esac
  [[ -x "$repo/bin/ballin" ]] || return 0
  if [[ "$backup_choice" == yes && "$result" == 'complete configured open' ]] && confirm_first_backup; then
    destination=$(backup_destination_kind "$repo")
    if [[ "$destination" == repository ]]; then
      "$repo/bin/ballin" backup
      printf '\n'
      "$repo/bin/ballin" backup open
    fi
  fi
  if "$path_setup_complete"; then
    printf '\n'; setup_complete; printf ' Open a new Terminal and run '
    command_reference 'ballin help'
    printf '.\n'
  else
    printf "\nBallin is installed. PATH setup wasn’t verified.\n🔗 Manual setup:\nhttps://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md#manual-path-setup\n"
  fi
}

if [[ "${BASH_SOURCE[0]:-$0}" == "$0" ]]; then
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  main "$@"
fi
}
