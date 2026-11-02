#!/usr/bin/env bash
{ # Parse the complete body before starting installation.
# BEGIN RELEASE BOOTSTRAP
ballin_entry='install.sh'
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

ballin_select "$@" || exit $?
if [[ "${BALLIN_DEFER_TERMINAL_GUIDANCE:-0}" != 1 && "$ballin_mode" != self-update ]]; then phase 'Setting up Ballin'; fi

repo_dir="$HOME/.ballin-scripts"
docs_url='https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md'
analytics_docs_url='https://github.com/JBallin/ballin-scripts/blob/main/docs/analytics.md#what-will-analytics-share'
required_node_version=$ballin_minimum
repo_existed=true
setup_mode='refresh'

print_stale_checkout_guidance() {
  printf '\n⚠️  ERROR: Unable to update %s before setup.\n' "$(display_path "$repo_dir")"
  printf 'Inspect %s and preserve local work before retrying. Ballin will not stash or reset it.\n' "$(display_path "$repo_dir")"
  documentation_pointer 'Troubleshooting' "$docs_url#health-and-recovery"
}

############################### CHECK PREREQUISITES ############################
if [ ! -d "$repo_dir" ]; then
  repo_existed=false
  setup_mode='fresh'
fi
if [ ! -f "$repo_dir/ballin.config.json" ]; then
  setup_mode='fresh'
fi

if [[ -n "${BALLIN_APPROVED_INSTALL_ROOT:-}" && ( "$BALLIN_APPROVED_INSTALL_ROOT" != "$repo_dir" || "$repo_existed" == true ) ]]; then
  printf 'The checkout changed after approval. Inspect it, then rerun Quickstart.\n' >&2
  exit 1
fi

system_git='/usr/bin/git'
system_xcode_select='/usr/bin/xcode-select'
git_tool=$(type -P git) || git_tool=''
if [[ -z "$git_tool" ]]; then
  printf '\n'; error_icon; printf ' Git is required before install can continue.\n'
  printf 'Install Git, then run this installer again.\n'
  exit 1
fi
prerequisite_status=0
if [[ "$(uname -s)" == Darwin && "$git_tool" -ef "$system_git" ]]; then
  "$system_xcode_select" -p >/dev/null 2>&1 || prerequisite_status=$?
  [[ "$prerequisite_status" != 130 && "$prerequisite_status" != 143 ]] || exit "$prerequisite_status"
  if [[ "$prerequisite_status" != 0 ]]; then
    printf '\n'; error_icon; printf " Xcode Command Line Tools are required to use Apple’s Git.\n"
    printf 'Run '; command_reference 'xcode-select --install'; printf ', finish installation, then rerun this installer.\n'
    exit 1
  fi
fi
git_diagnostics=$("$git_tool" --version 2>&1) || prerequisite_status=$?
[[ "$prerequisite_status" != 130 && "$prerequisite_status" != 143 ]] || exit "$prerequisite_status"
if [[ "$prerequisite_status" != 0 ]]; then
  [[ -z "$git_diagnostics" ]] || printf '%s\n' "$git_diagnostics"
  printf '\n'; error_icon; printf ' Git was found but could not run.\n'
  printf 'Make sure '; command_reference 'git --version'; printf ' works, then rerun this installer.\n'
  exit 1
fi

if [ ! -x "$(command -v node)" ]; then
  printf '\n⚠️  ERROR: Node.js %s or newer is required.\n' "$required_node_version"
  printf "\nInstall supported Node.js, then run this installer again.\n"
  documentation_pointer 'Node.js details' 'https://github.com/JBallin/ballin-scripts/blob/main/docs/optional-capabilities.md#nodejs'
  exit 1
else
  node_check=$(node -p "
    const version = process.versions.node;
    const [major, minor] = version.split('.').map(Number);
    const [requiredMajor, requiredMinor] = '$required_node_version'.split('.').map(Number);
    /^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(version)
      ? (major > requiredMajor || (major === requiredMajor && minor >= requiredMinor) ? 'true' : version)
      : ''
  " 2>/dev/null) || { prerequisite_status=$?; node_check=''; }
  [[ "$prerequisite_status" != 130 && "$prerequisite_status" != 143 ]] || exit "$prerequisite_status"
  if [ "$node_check" != 'true' ]; then
    printf '\n⚠️  ERROR: Node.js %s or newer is required.' "$required_node_version"
    if [[ "$node_check" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
      printf ' Detected Node.js %s.' "$node_check"
    fi
    printf '\n'
    printf "\nUpdate or activate Node.js using your existing installation method, then run this installer again.\n"
    documentation_pointer 'Node.js details' 'https://github.com/JBallin/ballin-scripts/blob/main/docs/optional-capabilities.md#nodejs'
    exit 1
  fi
fi

# Keep complete answers, EOF and diagnosed read failures distinct. Never echo input.
input_ended=false
prompt_error=''
trap '[ -z "$prompt_error" ] || rm -f -- "$prompt_error"' EXIT
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
write_install_cancelled() {
  [[ -n "${BALLIN_SETUP_RESULT_FILE:-}" ]] || return 0
  node -e '
    const fs = require("fs"); const fd = fs.openSync(process.argv[1], fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try { const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw Error("Unsafe installer result file"); fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, "cancelled\n"); } finally { fs.closeSync(fd); }
  ' "$BALLIN_SETUP_RESULT_FILE"
}
# Report only command entries that this installation would actually replace.
# Directories and unsafe link targets never gain replacement permission.
# The JavaScript diagnostics receive their stderr command-reference presentation.
# shellcheck disable=SC2016
if command_preflight=$(node -e '
  const fs = require("fs"), path = require("path"), cp = require("child_process");
  let directory = path.join(process.env.HOME, ".local", "bin");
  const brew = cp.spawnSync("brew", ["--prefix"], { encoding: "utf8" });
  if (brew.signal === "SIGINT" || brew.status === 130) process.exit(130);
  if (brew.signal === "SIGTERM" || brew.status === 143) process.exit(143);
  if (brew.status === 0) {
    const prefix = brew.stdout.trimEnd();
    if (!path.isAbsolute(prefix) || /[:\r\n\0]/u.test(prefix)) { console.error("Homebrew returned an invalid installation prefix. Inspect " + process.argv[2] + ", then rerun installation."); process.exit(1); }
    directory = path.join(prefix, "bin");
  }
  const displayPath = value => value === process.env.HOME ? "~" : value.startsWith(process.env.HOME + "/") ? "~" + value.slice(process.env.HOME.length) : value;
  const source = path.join(process.argv[1], "bin", "ballin");
  const target = path.join(directory, "ballin");
  let snapshot = "null";
  try {
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) throw Error("Refusing to replace a directory at " + displayPath(target));
    if (!stat.isFile() && !stat.isSymbolicLink()) throw Error("Refusing to replace an unsafe command entry at " + displayPath(target));
    const link = stat.isSymbolicLink() ? fs.readlinkSync(target) : null;
    snapshot = JSON.stringify({dev:stat.dev, ino:stat.ino, mode:stat.mode, nlink:stat.nlink, size:stat.size, mtimeMs:stat.mtimeMs, ctimeMs:stat.ctimeMs, link});
    if (!(stat.isSymbolicLink() && path.resolve(path.dirname(target), link) === source)) console.error("Warning: installation will replace the existing command at " + displayPath(target) + (link === null ? "." : " (link target: " + displayPath(link) + ")."));
  } catch (error) {
    if (error.code !== "ENOENT") { console.error(error.message); process.exit(1); }
  }
  process.stdout.write(JSON.stringify({directory, target, snapshot}));
' "$repo_dir" "$(command_reference 'brew --prefix' 2)"); then :
else
  exit $?
fi
if [ "$repo_existed" = false ]; then
  install_approved=false
  if [[ "${BALLIN_APPROVED_INSTALL_ROOT:-}" == "$repo_dir" && -n "${BALLIN_APPROVED_INSTALL_COMMAND:-}" ]]; then
    reviewed_command=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).target)' "$command_preflight") || exit 1
    reviewed_snapshot=$(command_entry_snapshot "$reviewed_command") || exit 1
    approved_command=$(node -e 'process.stdout.write(require("path").normalize(process.argv[1]))' "$BALLIN_APPROVED_INSTALL_COMMAND") || exit 1
    if [[ "$reviewed_command" != "$approved_command" || "$reviewed_snapshot" != "${BALLIN_APPROVED_INSTALL_SNAPSHOT:-}" ]]; then
      printf 'The installation plan changed after approval. Inspect the command target, then rerun Quickstart.\n' >&2
      exit 1
    fi
    install_approved=true
  fi
  if ! "$install_approved"; then
    command_directory=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).directory)' "$command_preflight") || exit 1
    printf 'Installation will:\n'
    printf '  - Create Ballin and its settings in %s\n' "$(display_path "$repo_dir")"
    printf '  - Link the Ballin command in %s\n' "$(display_path "$command_directory")"
    documentation_pointer 'Installation details' "$docs_url#what-will-installation-change"
  fi
  if ! "$install_approved" && ! confirm 'Proceed with installation?'; then
    if "$input_ended"; then
      printf '\nNo answer received. Ballin installation stopped before installing Ballin.\n' >&2
      exit 1
    fi
    printf "\nBallin installation cancelled.\nRerun the installer when you’re ready.\n"
    write_install_cancelled || exit 1
    exit 0
  fi
fi

# Use the selected standalone helper, never executable code from the old checkout.
ballin_runtime || exit $?
if [[ "$ballin_mode" != self-update ]]; then
  if [[ "$repo_existed" == true ]]; then phase 'Updating Ballin'; else phase 'Installing Ballin'; fi
fi
revision_scratch=$(mktemp -d "${TMPDIR:-/tmp}/ballin-checkout.XXXXXX") || exit 1
trap '[ -z "$prompt_error" ] || rm -f -- "$prompt_error"; rm -rf -- "$revision_scratch"' EXIT
ballin_download "https://raw.githubusercontent.com/JBallin/ballin-scripts/$ballin_sha/commands/repo_update.ts" "$revision_scratch/repo_update.ts" || exit $?
if [[ "$repo_existed" == false ]]; then
  [[ "$ballin_mode" != self-update ]] || { ballin_error 'Self-update requires an existing installation.'; exit 1; }
  if git clone --no-checkout https://github.com/JBallin/ballin-scripts.git "$repo_dir"; then :
  else
    status=$?
    [[ "$status" != 130 && "$status" != 143 ]] || exit "$status"
    printf '\nUnable to prepare %s\n' "$(display_path "$repo_dir")"
    documentation_pointer 'Troubleshooting' "$docs_url#health-and-recovery"
    exit 1
  fi
fi
if node "$revision_scratch/repo_update.ts" apply "$repo_dir" "$ballin_kind" "$ballin_value" "$ballin_sha" "$ballin_minimum" "$ballin_release_id" "$ballin_mode" "$([[ "$repo_existed" == false ]] && printf true || printf false)"; then :
else
  status=$?
  [[ "$status" != 130 && "$status" != 143 ]] || exit "$status"
  print_stale_checkout_guidance
  exit 1
fi
[[ "$ballin_mode" != self-update ]] || setup_mode=self-update

################################# TYPED SETUP ##################################
if [ ! -f "$repo_dir/commands/install_setup.ts" ]; then
  print_stale_checkout_guidance
  exit 1
fi

if [ "$repo_existed" = false ]; then
  printf '\n'
fi

if [ "$repo_existed" = true ] && [ "$setup_mode" = fresh ]; then
  printf '\nInitial configuration\n🔗 Installation details:\n%s#what-will-installation-change\n' "$docs_url"
fi

(
  cd "$repo_dir" || exit
  BALLIN_COMMAND_PREFLIGHT_JSON="$command_preflight" node "$repo_dir/commands/install_setup.ts" setup "$repo_dir" "$docs_url" "$analytics_docs_url" "$setup_mode"
)
setup_status=$?
if [ "$setup_status" -ne 0 ]; then
  printf "Ballin checkout is now %s, but setup refresh failed. Rerun installation to finish.\n" "$ballin_sha" >&2
  exit "$setup_status"
fi

# Quickstart owns the final guidance after its optional backup/browser work.
if [[ "${BALLIN_DEFER_TERMINAL_GUIDANCE:-0}" != 1 && "$ballin_mode" != self-update ]]; then
  printf '\n'; setup_complete; printf ' Open a new Terminal and run '
  command_reference 'ballin help'
  printf '.\n'
fi
}
