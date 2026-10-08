#!/usr/bin/env bash
# Optional beginner bootstrap; install.sh remains the core Ballin installer.
set -euo pipefail
umask 077

system_node_bin='/usr/local/bin'
system_git='/usr/bin/git'
system_xcode_select='/usr/bin/xcode-select'
scratch=''
profile_temp=''

fail() {
  printf '\nQuickstart: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  [ -z "$profile_temp" ] || rm -f -- "$profile_temp"
  [ -z "$scratch" ] || rm -rf -- "$scratch"
}

confirm() {
  local answer
  printf '%s [y/N] ' "$1"
  IFS= read -r answer || return 1
  [[ "$answer" == y || "$answer" == Y ]]
}

download() {
  local options=(-fsSL)
  [[ "${3:-}" != progress ]] || options=(-fL --progress-bar)
  curl "${options[@]}" --proto '=https' --proto-redir '=https' --tlsv1.2 "$1" -o "$2"
}

checksum() {
  local expected actual
  expected=$(awk -v name="$2" '$2 == name { print $1 }' "$1")
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail 'The official download checksum is missing or ambiguous.'
  actual=$(shasum -a 256 "$scratch/$2")
  [[ "${actual%% *}" == "$expected" ]] || fail "Checksum verification failed for $2; nothing from that download was installed."
}

normalize_process_path() {
  local remaining="$PATH" entry result='' separator=''
  # Keep the same search order across the core installer's directory changes.
  while :; do
    entry=${remaining%%:*}
    if [[ "$entry" != /* ]]; then
      [[ "$PWD" != *:* ]] || fail 'Relative PATH entries need a current directory without colons. Change directories or use absolute PATH entries, then try again.'
      entry="$PWD/${entry:-.}"
    fi
    result+="$separator$entry"
    separator=':'
    [[ "$remaining" == *:* ]] || break
    remaining=${remaining#*:}
  done
  export PATH="$result"
}

node_compatible() {
  [[ -x "$1" ]] && [[ "$("$1" -p 'const [major, minor] = process.versions.node.split(".").map(Number); major > 24 || (major === 24 && minor >= 12)' 2>/dev/null)" == true ]]
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
  local name="$1" search_path='' remaining="$PATH" entry separator='' retained=false
  # Ignore our own fallback links so a version manager can take over on rerun.
  # Exclude aliases that need the managed executable link to remain in place.
  while :; do
    entry=${remaining%%:*}
    if [[ "$entry" != "$quick_bin" && ! "${entry:-.}" -ef "$quick_bin" ]] \
      && ! tool_uses_managed_link "${entry:-.}/$name" "$name"; then
      search_path+="$separator$entry"
      separator=':'
      retained=true
    fi
    [[ "$remaining" == *:* ]] || break
    remaining=${remaining#*:}
  done
  "$retained" || return 0
  PATH="$search_path" command -v "$name" || true
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

release_node_links() {
  local name target
  for name in node npm; do
    target="$quick_bin/$name"
    if [[ -L "$target" ]]; then
      rm -f -- "$target"
    elif [[ -e "$target" ]]; then
      fail "Refusing to replace an existing file at $target."
    fi
  done
}

find_git() {
  local candidate
  for candidate in "$(command -v git || true)" "$system_git"; do
    if [[ "$candidate" -ef "$system_git" ]] && ! "$system_xcode_select" -p >/dev/null 2>&1; then
      continue
    fi
    if [[ "$candidate" == /* && -x "$candidate" ]] && "$candidate" --version >/dev/null 2>&1; then
      printf '%s' "$candidate"
      return
    fi
  done
}

find_gh() {
  local candidate
  for candidate in "$(tool_on_path gh)" "$quick_bin/gh"; do
    if [[ "$candidate" == /* && -x "$candidate" ]] \
      && "$candidate" --version >/dev/null 2>&1 \
      && "$candidate" auth status --help 2>/dev/null | grep -q -- '--active'; then
      printf '%s' "$candidate"
      return
    fi
  done
}

bind_tool() {
  local target="$quick_bin/$1"
  [[ "$target" != "$2" ]] || return 0
  if [[ -e "$target" && ! -L "$target" ]]; then
    fail "Refusing to replace an existing file at $target."
  fi
  if [[ -L "$target" ]] && { [[ "$(readlink "$target")" == "$2" ]] || [[ "$target" -ef "$2" ]]; }; then return; fi
  ln -sfn "$2" "$target"
}

install_node() {
  local package version minor
  download 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' "$scratch/node-checksums.txt"
  package=$(awk '$2 ~ /^node-v24[.][0-9]+[.][0-9]+[.]pkg$/ { print $2 }' "$scratch/node-checksums.txt")
  [[ "$package" =~ ^node-v24\.[0-9]+\.[0-9]+\.pkg$ ]] || fail 'Unable to identify the official Node.js 24 macOS package.'
  version=${package#node-}
  version=${version%.pkg}
  minor=${version#v24.}
  minor=${minor%%.*}
  (( 10#$minor >= 12 )) || fail 'The official Node.js package is older than the required 24.12; it was not installed.'
  printf 'Downloading Node.js %s...\n' "$version"
  download "https://nodejs.org/dist/$version/$package" "$scratch/$package" progress
  checksum "$scratch/node-checksums.txt" "$package"
  pkgutil --check-signature "$scratch/$package" > "$scratch/node-signature.txt" \
    || fail 'The Node.js package signature could not be verified.'
  grep -Fq 'Developer ID Installer: Node.js Foundation (HX7739G8FX)' "$scratch/node-signature.txt" \
    || fail 'The Node.js package has an unexpected publisher; it was not installed.'
  sudo /usr/sbin/installer -pkg "$scratch/$package" -target /
  node_compatible "$system_node_bin/node" || fail 'Node.js installation did not provide a working Node.js 24.12 or newer.'
  node_tool="$system_node_bin/node"
}

install_gh() {
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
  checksum "$scratch/gh-checksums.txt" "$archive"
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
  printf '\nPersistent PATH setup incomplete: %s\n' "$1" >&2
  printf 'The startup file was left unchanged. First-backup setup can continue with the helper PATH.\n' >&2
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

configure_path() {
  local escaped command_escaped line choice candidate original
  escaped=${quick_bin//\'/\'\\\'\'}
  command_escaped=${command_bin//\'/\'\\\'\'}
  line="export PATH='$escaped':\$PATH:'$command_escaped'"
  printf '\nPATH line (also run this in your current Bash/zsh Terminal to use these tools there):\n%s\n' "$line"
  printf 'If ballin is unavailable in a new Terminal, review the startup file your shell reads and the placement of the line.\n'
  profile_shell=${SHELL:-}
  if [[ "$profile_shell" != /* || ! -f "$profile_shell" || ! -x "$profile_shell" ]]; then
    path_incomplete 'Select an executable Bash or zsh in SHELL before retrying.'; return
  fi
  case "${profile_shell##*/}" in
    zsh)
      if [[ -n "${ZDOTDIR+x}" ]]; then printf 'Exported ZDOTDIR: "%s" (an empty value does not mean home).\n' "$ZDOTDIR"; fi
      printf 'Which directory contains the .zshrc your terminal reads? [home or absolute directory; Enter to skip] '
      IFS= read -r choice || choice=''
      [[ "$choice" != home ]] || choice="$HOME"
      if [[ "$choice" != /* ]]; then path_incomplete 'No absolute zsh startup directory selected.'; return; fi
      profile="${choice%/}/.zshrc"
      ;;
    bash)
      printf 'Which Bash startup file does your terminal read? [login/bashrc; Enter to skip] '
      IFS= read -r choice || choice=''
      case "$choice" in
        bashrc) profile="$HOME/.bashrc" ;;
        login)
          profile="$HOME/.bash_profile"
          for candidate in .bash_profile .bash_login .profile; do
            if [[ -e "$HOME/$candidate" || -L "$HOME/$candidate" ]]; then profile="$HOME/$candidate"; break; fi
          done
          ;;
        *) path_incomplete 'No Bash startup file selected.'; return ;;
      esac
      ;;
    *) path_incomplete 'Automatic PATH setup supports Bash and zsh. Configure the equivalent PATH for your shell, or retry in Bash/zsh.'; return ;;
  esac
  printf '\nPATH setup for %s\n' "$profile"
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
    if (text.split("\n").includes(line)) fs.writeFileSync(check + ".present", "");
    const trailing = text.match(/(\\+)(?:\r?\n)?$/u)?.[1];
    if (trailing && trailing.length % 2 !== 0) {
      fs.writeFileSync(check + ".continuation", text.replace(/\r?\n$/u, "") + " )\n");
    }
    fs.writeFileSync(check, Buffer.concat([contents, Buffer.from("\n)\n")]));
  ' "$profile" "$original" "$scratch/profile-metadata" "$line" "$scratch/profile-boundary" 2>/dev/null; then
    path_incomplete 'The startup file or directory could not be safely inspected.'; return
  fi
  if ! profile_unchanged; then path_incomplete 'The startup file changed during setup. Review it before retrying.'; return; fi
  # Literal presence is not evidence that the shell executes this line.
  if [[ -f "$scratch/profile-boundary.present" ]]; then
    printf 'PATH line already present in %s; open a new Terminal. Its activation was not checked.\n' "$profile"
    return
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
  printf '\nAdd to %s:\n%s\n' "$profile" "$line"
  if ! confirm 'Add this PATH line?'; then path_incomplete 'PATH setup was declined.'; return; fi
  if ! profile_unchanged; then path_incomplete 'The startup file changed during setup. Review it before retrying.'; return; fi
  if ! profile_temp=$(mktemp "$profile.ballin-quickstart.XXXXXX"); then
    path_incomplete 'A temporary startup file could not be created.'; return
  fi
  if [[ -f "$profile" ]]; then
    if ! cp -p "$profile" "$profile_temp" || ! cmp -s "$profile_temp" "$original"; then
      path_incomplete 'The startup file changed or could not be copied.'; return
    fi
  fi
  if ! printf '\n%s\n' "$line" >> "$profile_temp" \
    || ! "${syntax_check[@]}" "$profile_temp" >/dev/null 2>&1; then
    path_incomplete 'The proposed append could not be checked.'; return
  fi
  if ! profile_unchanged; then path_incomplete 'The startup file changed during setup. Review it before retrying.'; return; fi
  if ! mv "$profile_temp" "$profile"; then path_incomplete 'The startup file could not be replaced.'; return; fi
  profile_temp=''
  printf 'PATH line added to %s; open a new Terminal.\n' "$profile"
}

main() {
  local os_version major minor machine git_tool need_git need_node need_gh fresh repo path_node brew_tool brew_prefix
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
  quick_root="$HOME/.local/share/ballin-quickstart"
  quick_bin="$quick_root/bin"
  if [[ -e "$quick_root" || -L "$quick_root" ]]; then
    if ! { [[ -d "$quick_root" && ! -L "$quick_root" && -f "$quick_root/.managed" && ! -L "$quick_root/.managed" ]] \
      && [[ "$(cat "$quick_root/.managed")" == 1 ]]; }; then
      fail "Refusing to change an unrecognized directory at $quick_root."
    fi
    [[ ! -L "$quick_bin" && ( ! -e "$quick_bin" || -d "$quick_bin" ) ]] || fail "Refusing to change $quick_bin."
  fi
  path_node=$(tool_on_path node)
  node_tool=$(find_node "$path_node")
  gh_tool=$(find_gh)
  git_tool=$(find_git)
  need_git=false; need_node=false; need_gh=false
  [[ -n "$git_tool" ]] || need_git=true
  [[ -n "$node_tool" ]] || need_node=true
  [[ -n "$gh_tool" ]] || need_gh=true
  if "$need_git" || "$need_node" || "$need_gh"; then
    printf 'Missing prerequisites:'
    "$need_git" && printf ' Git (Apple Command Line Tools);'
    "$need_node" && printf ' Node.js 24 and npm (official macOS package);'
    "$need_gh" && printf ' GitHub CLI (official release);'
    printf '\n'
    "$need_node" && printf 'The Node.js package writes to /usr/local and may replace existing Node.js/npm there.\n'
    "$need_gh" && printf 'GitHub CLI will be installed in %s.\n' "$quick_root"
    confirm 'Install these prerequisites?' || return 0
  fi
  mkdir -p "$quick_bin"
  printf '1\n' > "$quick_root/.managed"
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/ballin-quickstart.XXXXXX")
  if "$need_git"; then
    "$system_xcode_select" --install || fail 'Apple could not start Command Line Tools installation. Finish any pending installation, then run this quickstart again.'
    printf 'Finish the macOS installation, then press Return here: '
    IFS= read -r _ || fail 'Git setup did not complete.'
    git_tool=$(find_git)
    [[ -n "$git_tool" ]] || fail 'Git is still unavailable. Finish Command Line Tools installation, then run this quickstart again.'
  fi
  "$need_node" && install_node
  "$need_gh" && install_gh
  if [[ "$node_tool" == "$path_node" ]]; then
    # Leave a working PATH Node/npm under its existing version manager.
    release_node_links
  else
    bind_tool node "$node_tool"
    if [[ -x "${node_tool%/*}/npm" ]]; then bind_tool npm "${node_tool%/*}/npm"; fi
  fi
  bind_tool gh "$gh_tool"
  bind_tool git "$git_tool"
  command_bin="$HOME/.local/bin"
  if brew_tool=$(type -P brew) && brew_prefix=$("$brew_tool" --prefix 2>/dev/null); then
    [[ -n "$brew_prefix" ]] || fail "Homebrew returned an empty installation prefix. Inspect and fix \`brew --prefix\`, then rerun this quickstart. PATH setup and Ballin installation have not run."
    command_bin="$brew_prefix/bin"
  fi
  [[ "$command_bin" == /* && "$command_bin" != *:* && "$command_bin" != *$'\n'* ]] || fail 'Unable to select the Ballin command directory.'
  export PATH="$quick_bin:$PATH:$command_bin"
  configure_path
  "$gh_tool" auth status --active --hostname github.com \
    || "$gh_tool" auth login --hostname github.com --git-protocol https --web
  repo="$HOME/.ballin-scripts"
  fresh=false
  [[ -d "$repo" && -f "$repo/ballin.config.json" ]] || fresh=true
  download 'https://raw.githubusercontent.com/JBallin/ballin-scripts/main/install.sh' "$scratch/install.sh"
  bash "$scratch/install.sh"
  [[ -x "$repo/bin/ballin" ]] || return 0
  if [[ "$fresh" == false ]] && [[ "$("$node_tool" -e '
    const root = process.argv[1];
    const config = JSON.parse(require("fs").readFileSync(root + "/ballin.config.json", "utf8"));
    process.stdout.write(require(root + "/commands/backup_config.ts").configuredBackupDestination(config).kind);
  ' "$repo")" == unconfigured ]]; then
    "$repo/bin/ballin" backup setup
  fi
  "$repo/bin/ballin" backup && "$repo/bin/ballin" backup open
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  main
fi
