#!/usr/bin/env bash
# Optional beginner bootstrap; install.sh remains the core Ballin installer.
set -euo pipefail
umask 077

phase() {
  if [[ -t 1 && "${TERM:-}" != dumb && -z "${NO_COLOR:-}" ]]; then
    printf '\033[1;34m==>\033[1;39m %s\033[0m\n' "$1"
  else printf '==> %s\n' "$1"; fi
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

system_softwareupdate='/usr/sbin/softwareupdate'
system_node_bin='/usr/local/bin'
system_brew_arm='/opt/homebrew'
system_brew_intel='/usr/local'
system_git='/usr/bin/git'
system_xcode_select='/usr/bin/xcode-select'
system_pkgutil='/usr/sbin/pkgutil'
system_sudo='/usr/bin/sudo'
system_sysctl='/usr/sbin/sysctl'
# Mirrored bootstrap requirement; tests keep this aligned with package.json.
required_node_version='24.12'
scratch=''
profile_temp=''
original_path=${PATH-}
original_pwd=$PWD

fail() {
  printf '\nQuickstart: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  [ -z "$prompt_error" ] || rm -f -- "$prompt_error"
  [ -z "$profile_temp" ] || rm -f -- "$profile_temp"
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
  answer=$(probe_tool "$1" -p "const [major, minor] = process.versions.node.split('.').map(Number); const [requiredMajor, requiredMinor] = '$required_node_version'.split('.').map(Number); major > requiredMajor || (major === requiredMajor && minor >= requiredMinor)" 2>/dev/null) || status=$?
  stop_if_interrupted "$status"
  [[ "$status" == 0 ]] || return 2
  case "$answer" in true) return 0 ;; false) return 1 ;; *) return 2 ;; esac
}

tool_uses_managed_link() {
  local candidate="$1" name="$2" target hops=0
  # Follow executable links, not just the PATH directory. Equal final binaries
  # can still be independently reachable through a version manager.
  while :; do
    if [[ "${candidate##*/}" == "$name" && "${candidate%/*}" -ef "$quick_bin" ]]; then return 0; fi
    [[ -L "$candidate" ]] || return 1
    (( hops += 1 ))
    (( hops <= 40 )) || return 0
    # Suppress readlink's delimiter and preserve target newlines with a sentinel.
    target=$(readlink -n "$candidate" && printf .) || return 0
    target=${target%.}
    if [[ "$target" == /* ]]; then candidate="$target"
    else candidate="${candidate%/*}/$target"; fi
  done
}

tool_on_path() {
  local name="$1" validate="${2:-true}" remaining="$PATH" entry candidate
  # Ignore our own fallback links so a version manager can take over on rerun.
  # Exclude aliases that need the managed executable link to remain in place.
  while :; do
    entry=${remaining%%:*}
    candidate="${entry:-.}/$name"
    if [[ "$entry" != "$quick_bin" && ! "${entry:-.}" -ef "$quick_bin" && -f "$candidate" && -x "$candidate" ]] \
      && ! tool_uses_managed_link "$candidate" "$name" && "$validate" "$candidate"; then
      printf '%s' "$candidate"
      return
    fi
    [[ "$remaining" == *:* ]] || break
    remaining=${remaining#*:}
  done
}

find_node() {
  local candidate
  for candidate in "$1" "$quick_bin/node" "$system_node_bin/node"; do
    if [[ "$candidate" == /* ]] && node_compatible "$candidate"; then
      printf '%s' "$candidate"
      return
    fi
  done
}

release_tool_links() {
  local name target
  for name in "$@"; do
    target="$quick_bin/$name"
    if [[ -L "$target" ]]; then
      rm -f -- "$target"
    elif [[ -e "$target" ]]; then
      fail "Refusing to replace an existing file at $target."
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
  local candidate path_candidate
  path_candidate=$(tool_on_path git git_compatible) || return $?
  for candidate in "$path_candidate" "$quick_bin/git" "$system_git"; do
    if git_compatible "$candidate"; then
      printf '%s' "$candidate"
      return
    fi
  done
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
  local candidate path_candidate
  path_candidate=$(tool_on_path gh gh_compatible) || return $?
  for candidate in "$path_candidate" "$quick_bin/gh"; do
    if gh_compatible "$candidate"; then
      printf '%s' "$candidate"
      return
    fi
  done
}

bind_tool() {
  local target="$quick_bin/$1"
  if [[ -e "$target" && ! -L "$target" ]]; then
    fail "Refusing to replace an existing file at $target."
  fi
  [[ "$target" != "$2" ]] || return 0
  if [[ -L "$target" ]] && { [[ "$(readlink "$target")" == "$2" ]] || [[ "$target" -ef "$2" ]]; }; then return; fi
  ln -sfn "$2" "$target"
}

# Qualify the invocation children will actually use, not just discovery's path.
qualify_tool() {
  local name="$1" selected="$2" validate="$3" resolved
  resolved=$(type -P "$name")
  if "$validate" "$resolved"; then return; fi
  # A wrapper may need its original $0 to locate sibling resources. Release
  # only our link when the original tool already wins the retained PATH.
  if [[ "$selected" == "$(tool_on_path "$name")" ]]; then
    if [[ "$name" == node ]]; then release_tool_links node npm
    else release_tool_links "$name"; fi
    resolved=$(type -P "$name")
    if [[ "$resolved" == "$selected" ]] && "$validate" "$resolved"; then return; fi
  fi
  fail "Selected $name cannot run through the final PATH. Put its original directory first on PATH, then rerun this quickstart. PATH setup and authentication have not run."
}

select_command_bin() {
  local selected_brew selected_prefix brew_status
  command_bin="$local_bin"
  if selected_brew=$(type -P brew); then
    brew_status=0
    selected_prefix=$("$selected_brew" --prefix 2>/dev/null) || brew_status=$?
    [[ "$brew_status" != 130 && "$brew_status" != 143 ]] || exit "$brew_status"
    [[ "$brew_status" == 0 ]] || return 0
    local brew_prefix=$selected_prefix
    brew_prefix=$("$node_tool" -e 'process.stdout.write(process.argv[1].trimEnd())' "$brew_prefix")
    [[ -n "$brew_prefix" ]] || fail "Homebrew returned an empty installation prefix. Inspect and fix \`brew --prefix\`, then rerun this quickstart. PATH setup and Ballin installation have not run."
    command_bin=$("$node_tool" -e 'process.stdout.write(require("path").join(process.argv[1], "bin"))' "$brew_prefix")
  fi
  [[ "$command_bin" == /* && "$command_bin" != *:* && "$command_bin" != *$'\n'* ]] || fail 'Unable to select the Ballin command directory.'
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

tools_need_helper() {
  local selected name found
  for selected in "$node_tool" "$git_tool" "$gh_tool" "$npm_tool"; do
    [[ -n "$selected" ]] || continue
    name=${selected##*/}
    found=$(PATH="$original_normalized_path" type -P "$name") || return 0
    [[ "$found" -ef "$selected" ]] || return 0
  done
  return 1
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
  local candidate=$1 state=${2:-incompatible} owner='its existing installation method' resolved=$1 target hops=0
  if [[ "$state" == compatible ]]; then
    fail "Existing compatible Node.js at $candidate is not active on PATH. Activate it using its existing installation method or add its bin directory to PATH, then rerun Quickstart. https://github.com/JBallin/ballin-scripts/blob/main/docs/optional-capabilities.md#nodejs"
  elif [[ "$state" == unknown ]]; then
    fail "Existing Node.js at $candidate could not be verified. Check it using its existing installation method and make a supported Node.js available on PATH, then rerun Quickstart. https://github.com/JBallin/ballin-scripts/blob/main/docs/optional-capabilities.md#nodejs"
  fi
  while [[ -L "$resolved" && $hops -lt 40 ]]; do
    target=$(readlink "$resolved") || break
    if [[ "$target" == /* ]]; then resolved=$target; else resolved="${resolved%/*}/$target"; fi
    (( hops += 1 ))
  done
  # Match actual known binaries, not manager directories or guessed command names.
  case "$resolved" in
    "$HOME"/.nvm/versions/node/*/bin/node|"${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/node) owner='nvm (select a supported version in your shell)' ;;
    *)
      if [[ ! -L "$resolved" && -f "$resolved" ]]; then
        local directory='' prefix cellar_root
        directory=$(cd -P -- "${resolved%/*}" 2>/dev/null && pwd -P) || directory=''
        for prefix in "$system_brew_arm" "$system_brew_intel"; do
          cellar_root=$(cd -P -- "$prefix" 2>/dev/null && pwd -P) || continue
          case "$directory/${resolved##*/}" in
            "$cellar_root"/Cellar/node/*/bin/node)
              owner="Homebrew (review \`brew upgrade node\` yourself)"
              break
              ;;
          esac
        done
      fi
      ;;
  esac
  fail "Existing Node.js at $candidate needs manual attention. Ballin requires Node.js $required_node_version or newer. Update or select Node using $owner, then rerun Quickstart. https://github.com/JBallin/ballin-scripts/blob/main/docs/optional-capabilities.md#nodejs"
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
  "$need_node" && formulas+=(node)
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
        process.stdout.write("Another ballin command would take precedence: " + candidate + ". Move or remove it, then rerun this quickstart.");
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

install_command_line_tools() {
  phase 'Installing Xcode Command Line Tools'
  local updates='' label='' status=0
  updates=$(probe_tool "$system_softwareupdate" --list) || status=$?
  stop_if_interrupted "$status"
  if [[ "$status" == 0 ]]; then
    # Use only an unambiguous Apple-provided label, never a macOS upgrade.
    label=$(printf '%s\n' "$updates" | awk '/^[[:space:]]*\* Label: Command Line Tools for Xcode/ { sub(/^[[:space:]]*\* Label: /, ""); labels[++n]=$0 } END { if (n == 1) print labels[1] }')
  fi
  if [[ -n "$label" ]]; then
    printf '$ sudo softwareupdate --install "%s"\n' "$label"
    probe_tool "$system_sudo" "$system_softwareupdate" --install "$label" \
      || fail 'Xcode Command Line Tools installation failed. Inspect the output, finish installation manually, then rerun Quickstart.'
  else
    printf 'No single Xcode Command Line Tools download was available in Terminal.\n'
    printf 'Use Apple’s graphical installer, or install the tools manually and rerun Quickstart.\n'
    if ! confirm 'Open the graphical Xcode Command Line Tools installer?'; then
      "$input_ended" && fail 'No answer received. Xcode Command Line Tools were not installed.'
      fail 'Install Xcode Command Line Tools manually, then rerun Quickstart.'
    fi
    printf '$ xcode-select --install\n'
    probe_tool "$system_xcode_select" --install || fail 'Apple could not start Xcode Command Line Tools installation. Finish any pending installation, then rerun Quickstart.'
    printf 'Finish the macOS installation, then press Return here: '
    read_prompt_answer || fail 'Git setup did not complete.'
  fi
  git_tool=$(find_git)
  [[ -n "$git_tool" ]] || fail 'Git is still unavailable. Finish Xcode Command Line Tools installation, then rerun Quickstart.'
}

install_node() {
  phase 'Installing Node.js'
  local package version minor expected
  download 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' "$scratch/node-checksums.txt"
  package=$(awk '$2 ~ /^node-v24[.][0-9]+[.][0-9]+[.]pkg$/ { print $2 }' "$scratch/node-checksums.txt")
  [[ "$package" =~ ^node-v24\.[0-9]+\.[0-9]+\.pkg$ ]] || fail 'Unable to identify the official Node.js 24 macOS package.'
  version=${package#node-}
  version=${version%.pkg}
  minor=${version#v24.}
  minor=${minor%%.*}
  (( 10#$minor >= ${required_node_version#*.} )) || fail "The official Node.js package is older than the required $required_node_version; it was not installed."
  printf 'Downloading Node.js %s...\n' "$version"
  download "https://nodejs.org/dist/$version/$package" "$scratch/$package" progress
  expected=$(checksum "$scratch/node-checksums.txt" "$package")
  "$system_pkgutil" --check-signature "$scratch/$package" > "$scratch/node-signature.txt" \
    || fail 'The Node.js package signature could not be verified.'
  grep -Fq 'Developer ID Installer: Node.js Foundation (HX7739G8FX)' "$scratch/node-signature.txt" \
    || fail 'The Node.js package has an unexpected publisher; it was not installed.'
  # Capture the digest before sudo. Only the private staged copy is verified
  # and installed across the privilege boundary; never reread the manifest.
  # shellcheck disable=SC2016 # Expand only in the clean privileged shell.
  "$system_sudo" /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/bash -c '
    set -euo pipefail
    umask 077
    stage=$(/usr/bin/mktemp -d /private/var/root/ballin-node.XXXXXX)
    cleanup_stage() {
      local status=$?
      /bin/rm -rf -- "$stage" || { [[ "$status" != 0 ]] || status=1; }
      exit "$status"
    }
    trap cleanup_stage EXIT
    trap "exit 130" INT
    trap "exit 143" TERM
    /bin/cat "$1" > "$stage/node.pkg"
    actual=$(/usr/bin/shasum -a 256 "$stage/node.pkg")
    [[ "$2" =~ ^[0-9a-f]{64}$ && "${actual%% *}" == "$2" ]] || {
      printf "Quickstart: The staged Node.js package checksum could not be verified.\n" >&2; exit 1;
    }
    /usr/sbin/pkgutil --check-signature "$stage/node.pkg" > "$stage/signature.txt" || {
      printf "Quickstart: The staged Node.js package signature could not be verified.\n" >&2; exit 1;
    }
    /usr/bin/grep -Fq "Developer ID Installer: Node.js Foundation (HX7739G8FX)" "$stage/signature.txt" || {
      printf "Quickstart: The staged Node.js package has an unexpected publisher.\n" >&2; exit 1;
    }
    /usr/sbin/installer -pkg "$stage/node.pkg" -target /
  ' ballin-node-install "$scratch/$package" "$expected"
  node_compatible "$system_node_bin/node" || fail "Node.js installation did not provide a working Node.js $required_node_version or newer."
  node_tool="$system_node_bin/node"
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
  if [[ -d "$quick_root/$directory" && ! -L "$quick_root/$directory" ]] \
    && [[ -f "$quick_root/$directory/bin/gh" && ! -L "$quick_root/$directory/bin/gh" ]] \
    && "$quick_root/$directory/bin/gh" --version >/dev/null 2>&1; then
    gh_tool="$quick_root/$directory/bin/gh"
    return
  fi
  printf 'Downloading GitHub CLI %s...\n' "$version"
  download "https://github.com/cli/cli/releases/download/v$version/gh_${version}_checksums.txt" "$scratch/gh-checksums.txt"
  download "https://github.com/cli/cli/releases/download/v$version/$archive" "$scratch/$archive" progress
  checksum "$scratch/gh-checksums.txt" "$archive" >/dev/null
  mkdir "$scratch/gh-extract"
  ditto -x -k "$scratch/$archive" "$scratch/gh-extract"
  [[ -f "$scratch/gh-extract/$directory/bin/gh" && ! -L "$scratch/gh-extract/$directory/bin/gh" ]] \
    || fail 'The GitHub CLI archive has an unexpected layout.'
  [[ ! -e "$quick_root/$directory" && ! -L "$quick_root/$directory" ]] \
    || fail "An existing quickstart download at $quick_root/$directory needs inspection before retrying."
  mv "$scratch/gh-extract/$directory" "$quick_root/$directory"
  gh_tool="$quick_root/$directory/bin/gh"
  "$gh_tool" --version >/dev/null
}

path_incomplete() {
  path_setup_complete=false
  installer_separator=true
  printf '\nPersistent PATH setup incomplete: %s\n' "$1" >&2
  printf 'The startup file was left unchanged. Setup can continue with the helper PATH.\n' >&2
  printf 'Review your shell startup and PATH setup, or rerun this quickstart to retry.\n' >&2
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
    const [file, exact, legacy, quick, commands, home, snapshot, metadata] = process.argv.slice(1);
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
      const exactLine = lines.includes(exact) || lines.includes(legacy);
      const directories = [quick, ".local/share/ballin-quickstart/bin", ...commands.split(":")];
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
  ' "$1" "$line" "$legacy_line" "$quick_bin" "$command_path" "$HOME" "$scratch/profile-original" "$scratch/profile-metadata" 2>/dev/null
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
    path_setup_complete=false
  else
    path_incomplete "$profile already mentions a setup directory. Review its PATH entries before changing PATH. Manual setup: https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md#manual-path-setup"
  fi
  return 0
}

configure_path() {
  phase 'Setting up PATH'
  local escaped command_escaped line legacy_line choice candidate original default_directory login_profile
  escaped=${quick_bin//\'/\'\\\'\'}
  command_escaped=${command_path//\'/\'\\\'\'}
  legacy_line="export PATH='$escaped':\$PATH:'$command_escaped'"
  if tools_need_helper; then line="export PATH='$escaped':\$PATH:'$command_escaped'"
  else line="export PATH=\$PATH:'$command_escaped'"; fi
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
      installer_separator=true
      printf 'Zsh settings directory [%s; Enter to use, another absolute directory, or skip]: ' "$default_directory"
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
      if check_existing_path; then return; fi
      login_profile="$profile"
      profile="$HOME/.bashrc"
      if check_existing_path; then return; fi
      profile="$login_profile"
      installer_separator=true
      printf 'Which Bash startup file does your terminal read? [login/bashrc; Enter to skip] '
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
  if check_existing_path selected; then return; fi
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
  if ! confirm "Add Ballin setup to $profile so it works in new Terminal windows?"; then
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
  if ! printf '%s\n' "$line" >> "$profile_temp" \
    || ! "${syntax_check[@]}" "$profile_temp" >/dev/null 2>&1; then
    path_incomplete 'The proposed append could not be checked.'; return
  fi
  if ! profile_unchanged; then path_incomplete 'The startup file changed during setup. Review it before retrying.'; return; fi
  if ! mv "$profile_temp" "$profile"; then path_incomplete 'The startup file could not be replaced.'; return; fi
  profile_temp=''
}

main() {
  local approved_root='' approved_command='' approved_snapshot='' exposed_npm managed_tool os_version major minor machine git_tool need_git need_node need_gh repo path_node local_bin command_path destination npm_tool='' new_quick_root=true path_setup_complete=true installer_separator=false selected_profile=''
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
  unset -f git node gh
  quick_root="$HOME/.local/share/ballin-quickstart"
  quick_bin="$quick_root/bin"
  if [[ -e "$quick_root" || -L "$quick_root" ]]; then
    if ! { [[ -d "$quick_root" && ! -L "$quick_root" && -f "$quick_root/.managed" && ! -L "$quick_root/.managed" ]] \
      && [[ "$(cat "$quick_root/.managed")" == 1 ]]; }; then
      fail "Refusing to change an unrecognized directory at $quick_root."
    fi
    [[ ! -L "$quick_bin" && ( ! -e "$quick_bin" || -d "$quick_bin" ) ]] || fail "Refusing to change $quick_bin."
    new_quick_root=false
  fi
  phase 'Setting up Ballin'
  backup_choice=no
  if confirm 'Set up backups to GitHub?' y; then backup_choice=yes
  elif "$input_ended"; then printf "Quickstart stopped. Rerun it when you’re ready.\n"; return 0
  else printf "Backup setup skipped. Run \`ballin backup setup\` when you’re ready.\n"; fi
  # Refuse managed-slot conflicts before discovery can execute them.
  for managed_tool in node npm git gh; do
    [[ "$managed_tool" != gh || "$backup_choice" == yes ]] || continue
    if [[ -e "$quick_bin/$managed_tool" && ! -L "$quick_bin/$managed_tool" ]]; then
      fail "Refusing to replace an existing file at $quick_bin/$managed_tool."
    fi
  done
  phase 'Checking required tools'
  active_node=$(type -P node) || active_node=''
  local active_node_status=0
  if [[ -n "$active_node" ]]; then
    node_compatible "$active_node" || active_node_status=$?
    case "$active_node_status" in
      1) manual_node_guidance "$active_node" incompatible ;;
      2) manual_node_guidance "$active_node" unknown ;;
    esac
  fi
  path_node=$(tool_on_path node)
  find_suitable_brew
  local path_node_status=0
  [[ -z "$path_node" ]] || node_compatible "$path_node" || path_node_status=$?
  if [[ "$path_node_status" != 0 ]]; then
    if [[ -n "$active_node" ]] && tool_uses_managed_link "$active_node" node; then
      # The compatible managed runtime actually wins PATH. Keep it while an
      # older external runtime remains shadowed; do not release its links.
      path_node=''
    else
      case "$path_node_status" in
        1) manual_node_guidance "$path_node" incompatible ;;
        2) manual_node_guidance "$path_node" unknown ;;
      esac
    fi
  fi
  node_tool=$(find_node "$path_node")
  if [[ -z "$node_tool" ]]; then
    hidden_node=$(existing_hidden_node)
    if [[ -n "$hidden_node" ]]; then
      local hidden_status=0
      node_compatible "$hidden_node" || hidden_status=$?
      case "$hidden_status" in
        0) manual_node_guidance "$hidden_node" compatible ;;
        1) manual_node_guidance "$hidden_node" incompatible ;;
        *) manual_node_guidance "$hidden_node" unknown ;;
      esac
    fi
  fi
  gh_tool=''
  [[ "$backup_choice" != yes ]] || gh_tool=$(find_gh)
  git_tool=$(find_git)
  need_git=false; need_node=false; need_gh=false
  [[ -n "$git_tool" ]] || need_git=true
  [[ -n "$node_tool" ]] || need_node=true
  [[ "$backup_choice" != yes || -n "$gh_tool" ]] || need_gh=true
  if "$need_git" || "$need_node" || "$need_gh"; then
    installer_separator=true
    prerequisite_names=''
    prerequisite_list=()
    if "$need_git"; then
      if [[ -n "$brew_tool" ]]; then prerequisite_list+=(Git); else prerequisite_list+=('Xcode Command Line Tools'); fi
    fi
    "$need_node" && prerequisite_list+=('Node.js')
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
    [[ -z "$brew_tool" ]] || printf 'Using existing Homebrew for missing tools.\n'
    if "$need_node"; then
      local replacement_bin=$system_node_bin replacement_method='the official Node installer'
      if [[ -n "$brew_tool" ]]; then
        replacement_bin="$brew_prefix/bin"; replacement_method="Homebrew’s Node installer"
        # The formula's npm post-install can remove this tree. Do not authorize
        # directory replacement through a prerequisite yes/no question.
        if [[ -e "$brew_prefix/lib/node_modules/npm" || -L "$brew_prefix/lib/node_modules/npm" ]]; then
          fail "Existing npm data at $brew_prefix/lib/node_modules/npm needs manual attention before installing Node."
        fi
      fi
      for replacement in "$replacement_bin/node" "$replacement_bin/npm" "$replacement_bin/npx"; do
        [[ ! -d "$replacement" ]] || fail "Refusing to replace a directory at $replacement."
        if [[ -e "$replacement" || -L "$replacement" ]]; then
          printf 'Warning: %s may replace %s' "$replacement_method" "$replacement"
          if [[ -L "$replacement" ]]; then printf ' (link to %s)' "$(readlink "$replacement")"; fi
          printf '.\n'
        fi
      done
    fi
    if [[ -n "$brew_tool" ]]; then
      printf 'Homebrew will install the missing tools and their dependencies; it will not upgrade existing Node.js.\n'
    else
      "$need_git" && printf 'Xcode Command Line Tools: try Apple’s Terminal download with administrator access; offer the graphical installer if unavailable.\n'
      "$need_node" && printf 'Node.js: install the verified official Node 24 package in /usr/local/bin with administrator access.\n'
      "$need_gh" && printf 'GitHub CLI: download and verify the official archive in %s.\n' "$quick_root"
    fi
    local approval_prompt="Install $prerequisite_names?"
    approved_root=''; approved_command=''; approved_snapshot=''
    if [[ ! -d "$HOME/.ballin-scripts" ]]; then
      approved_root="$HOME/.ballin-scripts"
      local planned_prefix="$HOME/.local" detected_prefix='' planned_brew='' prefix_status=0
      if planned_brew=$(type -P brew); then
        detected_prefix=$(probe_tool "$planned_brew" --prefix 2>/dev/null) || prefix_status=$?
        stop_if_interrupted "$prefix_status"
        if [[ "$prefix_status" == 0 ]]; then
          detected_prefix="${detected_prefix%"${detected_prefix##*[![:space:]]}"}"
          [[ "$detected_prefix" == /* && "$detected_prefix" != *:* && "$detected_prefix" != *$'\n'* && "$detected_prefix" != *$'\r'* ]] || fail 'Homebrew returned an invalid installation prefix. Inspect `brew --prefix`, then rerun Quickstart.'
          planned_prefix="$detected_prefix"
        fi
      fi
      approved_command="$planned_prefix/bin/ballin"
      approved_snapshot=$(command_entry_snapshot "$approved_command") || fail "Refusing to replace an unsafe command entry at $approved_command."
      printf 'Ballin will create %s, save its settings there, and link the command at %s.\n' "$approved_root" "$approved_command"
      if [[ "$approved_snapshot" != missing ]]; then
        printf 'Warning: installation will replace the existing command at %s' "$approved_command"
        if [[ -L "$approved_command" ]]; then printf ' (link target: %s)' "$(readlink "$approved_command")"; fi
        printf '.\n'
      fi
      approval_prompt="Install $prerequisite_names and Ballin?"
    fi
    printf 'Installation details: https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md#local-effects\n'
    if ! confirm "$approval_prompt"; then
      "$input_ended" && fail 'No answer received. Quickstart stopped before installing prerequisites.'
      printf "Prerequisite installation skipped. Rerun Quickstart when you’re ready.\n"
      return 0
    fi
  fi
  mkdir -p "$quick_bin"
  # Existing markers were validated above; leave them untouched on reruns.
  if "$new_quick_root"; then printf '1\n' > "$quick_root/.managed"; fi
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/ballin-quickstart.XXXXXX")
  if [[ -n "$brew_tool" ]] && { "$need_git" || "$need_node" || "$need_gh"; }; then
    install_brew_tools
  else
  if "$need_git"; then
    install_command_line_tools
  fi
  "$need_node" && install_node
  "$need_gh" && install_gh
  fi
  if [[ "$node_tool" == "$path_node" ]]; then
    # Release fallbacks only when the selected Node already wins the underlying PATH.
    release_tool_links node npm
  else
    bind_tool node "$node_tool"
    if [[ -x "${node_tool%/*}/npm" ]]; then
      npm_tool="${node_tool%/*}/npm"
      bind_tool npm "$npm_tool"
    else
      release_tool_links npm
    fi
  fi
  [[ "$backup_choice" != yes ]] || bind_tool gh "$gh_tool"
  bind_tool git "$git_tool"
  local_bin=$("$node_tool" -e 'process.stdout.write(require("path").join(process.argv[1], ".local", "bin"))' "$HOME")
  select_command_bin
  command_path="$command_bin"
  export PATH="$quick_bin:$PATH:$command_bin"
  qualify_tool node "$node_tool" node_compatible
  [[ -z "$npm_tool" ]] || qualify_tool npm "$npm_tool" npm_compatible
  qualify_tool git "$git_tool" git_compatible
  [[ "$backup_choice" != yes ]] || qualify_tool gh "$gh_tool" gh_compatible
  # The added command directory can expose Homebrew. Keep that directory so
  # the core installer and fresh shells discover the same brew executable.
  select_command_bin
  if [[ "$command_path" != "$command_bin" ]]; then
    command_path+=":$command_bin"
    export PATH="$PATH:$command_bin"
  fi
  if [[ "$command_bin" != "$local_bin" && ":$PATH:" == *":$local_bin:"* ]]; then
    command_path="$local_bin:$command_bin"
  fi
  if exposed_npm=$(type -P npm) && [[ -f "$exposed_npm" && -x "$exposed_npm" ]]; then
    npm_compatible "$exposed_npm" || fail "npm cannot run through the final PATH: $exposed_npm. Fix or remove this broken command, then rerun this quickstart. PATH setup and authentication have not run."
  fi
  check_ballin_command
  if ! original_path_sufficient; then
    configure_path
  fi
  if "$input_ended"; then printf "Quickstart stopped. Rerun it when you’re ready.\n"; return 0; fi
  if [[ "$backup_choice" == yes ]]; then
    auth_status=0
    "$gh_tool" auth status --active --hostname github.com >/dev/null 2>&1 || auth_status=$?
    if [[ "$auth_status" == 130 || "$auth_status" == 143 ]]; then exit "$auth_status"; fi
    if [[ "$auth_status" != 0 ]]; then
      installer_separator=true
      phase 'Signing in to GitHub'
      printf '$ gh auth login --hostname github.com --git-protocol https --web\n'
      "$gh_tool" auth login --hostname github.com --git-protocol https --web
    fi
  fi
  repo="$HOME/.ballin-scripts"
  download 'https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh' "$scratch/install.sh"
  # Separate prior Quickstart output while keeping quiet reruns flush.
  if "$installer_separator"; then printf '\n'; fi
  # Keep startup hooks from replacing the tools qualified above.
  result_file="$scratch/installation-result"
  printf 'pending\n' > "$result_file"
  BALLIN_APPROVED_INSTALL_ROOT="$approved_root" BALLIN_APPROVED_INSTALL_COMMAND="$approved_command" BALLIN_APPROVED_INSTALL_SNAPSHOT="$approved_snapshot" BALLIN_SETUP_PROFILE="$selected_profile" BALLIN_DEFER_TERMINAL_GUIDANCE=1 BALLIN_BACKUP_CHOICE="$backup_choice" BALLIN_SETUP_RESULT_FILE="$result_file" BASH_ENV='' bash "$scratch/install.sh"
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
    printf "\n😎 Setup complete! Open a new Terminal and run \`ballin help\`.\n"
  else
    printf "\nBallin is installed. PATH setup wasn’t verified. Manual setup: https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md#manual-path-setup\n"
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  main
fi
