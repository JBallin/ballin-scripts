#!/usr/bin/env bash
phase() {
  if [[ -t 1 && "${TERM:-}" != dumb && -z "${NO_COLOR:-}" ]]; then
    printf '\033[1;34m==>\033[1;39m %s\033[0m\n' "$1"
  else printf '==> %s\n' "$1"; fi
}
command_reference() {
  if [[ -t "${2:-1}" && "${TERM:-}" != dumb && -z "${NO_COLOR:-}" ]]; then
    printf '\033[1m%s\033[0m' "$1"
  else printf "\`%s\`" "$1"; fi
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

if [ "${BALLIN_DEFER_TERMINAL_GUIDANCE:-0}" != 1 ]; then phase 'Setting up Ballin'; fi

repo_dir="$HOME/.ballin-scripts"
docs_url='https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md'
analytics_docs_url='https://github.com/JBallin/ballin-scripts/blob/main/docs/analytics.md#what-will-analytics-share'
required_node_version='24.12'
repo_existed=true
setup_mode='refresh'

print_stale_checkout_guidance() {
  printf '\n⚠️  ERROR: Unable to update %s before setup.\n' "$repo_dir"
  printf 'Update or delete %s, then run this installer again.\n' "$repo_dir"
  printf 'Troubleshooting: %s#health-and-recovery\n' "$docs_url"
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

prerequisite_status=0
if command -v git >/dev/null 2>&1; then git --version >/dev/null 2>&1 || prerequisite_status=$?
else prerequisite_status=127; fi
[[ "$prerequisite_status" != 130 && "$prerequisite_status" != 143 ]] || exit "$prerequisite_status"
if [ "$prerequisite_status" -ne 0 ]; then
  printf '\n⚠️  ERROR: Git is required before install can continue.\n'
  printf '\nInstall Git, then run this installer again.\n'
  exit 1
fi

if [ ! -x "$(command -v node)" ]; then
  printf '\n⚠️  ERROR: Node.js %s or newer is required.\n' "$required_node_version"
  printf "\nInstall supported Node.js, then run this installer again.\n"
  printf 'https://github.com/JBallin/ballin-scripts/blob/main/docs/optional-capabilities.md#nodejs\n'
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
    printf 'https://github.com/JBallin/ballin-scripts/blob/main/docs/optional-capabilities.md#nodejs\n'
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
    if [[ "$default" == y ]]; then printf '%s [Y/n] ' "$1"; else printf '%s [y/N] ' "$1"; fi
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
  const source = path.join(process.argv[1], "bin", "ballin");
  const target = path.join(directory, "ballin");
  let snapshot = "null";
  try {
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) throw Error("Refusing to replace a directory at " + target);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw Error("Refusing to replace an unsafe command entry at " + target);
    const link = stat.isSymbolicLink() ? fs.readlinkSync(target) : null;
    snapshot = JSON.stringify({dev:stat.dev, ino:stat.ino, mode:stat.mode, nlink:stat.nlink, size:stat.size, mtimeMs:stat.mtimeMs, ctimeMs:stat.ctimeMs, link});
    if (!(stat.isSymbolicLink() && path.resolve(path.dirname(target), link) === source)) console.error("Warning: installation will replace the existing command at " + target + (link === null ? "." : " (link target: " + link + ")."));
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
    command_target=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).target)' "$command_preflight") || exit 1
    printf 'Ballin will create %s, save its settings there, and link the command at %s.\n' "$repo_dir" "$command_target"
    printf 'Installation details: %s#what-will-installation-change\n' "$docs_url"
  fi
  if ! "$install_approved" && ! confirm "Install Ballin in $repo_dir and make the ballin command available?"; then
    if "$input_ended"; then
      printf '\nNo answer received. Ballin installation stopped before installing Ballin.\n' >&2
      exit 1
    fi
    printf "Ballin installation cancelled. Rerun the installer when you’re ready.\n"
    write_install_cancelled || exit 1
    exit 0
  fi
fi

################################## CLONE REPO ##################################
if (
  cd "$HOME" || exit
  if [ "$repo_existed" = false ]; then
    phase 'Installing Ballin'
    printf '$ git clone https://github.com/JBallin/ballin-scripts.git .ballin-scripts\n'
    git clone https://github.com/JBallin/ballin-scripts.git .ballin-scripts || exit $?
  fi
); then :
else
  prepare_status=$?
  [[ "$prepare_status" != 130 && "$prepare_status" != 143 ]] || exit "$prepare_status"
  printf '\n⚠️  ERROR: Unable to prepare %s\n' "$repo_dir"
  printf 'Troubleshooting: %s#health-and-recovery\n' "$docs_url"
  exit 1
fi

############################ UPDATE EXISTING REPO ##############################
if [ "$repo_existed" = true ]; then
  phase 'Updating Ballin'
  if [ -f "$repo_dir/commands/repo_update.ts" ]; then
    if (
      cd "$repo_dir" || exit
      node "$repo_dir/commands/repo_update.ts" "$repo_dir"
    ); then :
    else
      update_status=$?
      [[ "$update_status" != 130 && "$update_status" != 143 ]] || exit "$update_status"
      print_stale_checkout_guidance
      exit 1
    fi
  elif (
    cd "$repo_dir" || exit
    git fetch origin +main:refs/remotes/origin/main \
      && git checkout main \
      && git merge origin/main
  ); then :
  else
    update_status=$?
    [[ "$update_status" != 130 && "$update_status" != 143 ]] || exit "$update_status"
    print_stale_checkout_guidance
    exit 1
  fi
fi

################################# TYPED SETUP ##################################
if [ ! -f "$repo_dir/commands/install_setup.ts" ]; then
  print_stale_checkout_guidance
  exit 1
fi

if [ "$repo_existed" = true ] && [ "$setup_mode" = fresh ]; then
  printf '\nInitial configuration\n%s#what-will-installation-change\n' "$docs_url"
fi

(
  cd "$repo_dir" || exit
  BALLIN_COMMAND_PREFLIGHT_JSON="$command_preflight" node "$repo_dir/commands/install_setup.ts" setup "$repo_dir" "$docs_url" "$analytics_docs_url" "$setup_mode"
)
setup_status=$?
if [ "$setup_status" -ne 0 ]; then
  exit "$setup_status"
fi

# Quickstart owns the final guidance after its optional backup/browser work.
if [ "${BALLIN_DEFER_TERMINAL_GUIDANCE:-0}" != 1 ]; then
  printf '\n😎 Setup complete! Open a new Terminal and run '
  command_reference 'ballin help'
  printf '.\n'
fi
