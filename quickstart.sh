#!/usr/bin/env bash
# Optional beginner bootstrap; install.sh remains the core Ballin installer.
set -euo pipefail
umask 077

system_node_bin='/usr/local/bin'
system_git='/usr/bin/git'
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

node_compatible() {
  [[ -x "$1" ]] && [[ "$("$1" -p 'const [major, minor] = process.versions.node.split(".").map(Number); major > 24 || (major === 24 && minor >= 12)' 2>/dev/null)" == true ]]
}

node_on_path() {
  local search_path=":$PATH:"
  # Ignore our own fallback links so a version manager can take over on rerun.
  while [[ "$search_path" == *":$quick_bin:"* ]]; do
    search_path=${search_path//":$quick_bin:"/:}
  done
  search_path=${search_path#:}
  search_path=${search_path%:}
  PATH="$search_path" command -v node || true
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

find_gh() {
  local candidate
  for candidate in "$(command -v gh || true)" "$quick_bin/gh"; do
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
  if [[ -L "$target" && "$(readlink "$target")" == "$2" ]]; then return; fi
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

configure_path() {
  local escaped command_escaped line original
  escaped=${quick_bin//\'/\'\\\'\'}
  command_escaped=${command_bin//\'/\'\\\'\'}
  line="export PATH='$escaped':\$PATH:'$command_escaped'"
  if [[ -L "$profile" || ( -e "$profile" && ! -f "$profile" ) ]]; then
    fail "The startup file $profile is not a regular file; leave it unchanged and use the standard installation guide."
  fi
  if [[ -f "$profile" ]]; then
    "$node_tool" -e '
      const contents = require("fs").readFileSync(process.argv[1], "utf8");
      const trailing = contents.match(/(\\+)(?:\r?\n)?$/u)?.[1];
      if (trailing && trailing.length % 2 !== 0) process.exit(1);
    ' "$profile" || fail 'The startup file ends at an unfinished continuation; it was left unchanged.'
    "$profile_shell" -n "$profile" || fail 'The startup file has invalid shell syntax; it was left unchanged.'
    # Both supported shells can accept an unfinished heredoc under -n. A
    # deliberate syntax error must remain visible to the parser at EOF.
    cp "$profile" "$scratch/profile-boundary-check"
    printf '\n)\n' >> "$scratch/profile-boundary-check"
    if "$profile_shell" -n "$scratch/profile-boundary-check" >/dev/null 2>&1; then
      fail 'The startup file ends at an unfinished heredoc; it was left unchanged.'
    fi
  fi
  if [[ -f "$profile" ]] && grep -Fqx "$line" "$profile"; then return; fi
  printf '\nAdd to %s:\n%s\n' "$profile" "$line"
  confirm 'Use these tools in new Terminal windows?' || fail 'PATH setup was declined; prerequisites remain available, but Ballin setup has not run.'
  [[ -d "${profile%/*}" ]] || fail "The startup directory ${profile%/*} does not exist."
  profile_temp=$(mktemp "$profile.ballin-quickstart.XXXXXX")
  original="$scratch/profile-original"
  if [[ -f "$profile" ]]; then
    cp -p "$profile" "$profile_temp"
    cp -p "$profile" "$original"
  fi
  printf '\n%s\n' "$line" >> "$profile_temp"
  "$profile_shell" -n "$profile_temp" || fail 'The startup file has invalid shell syntax; it was left unchanged.'
  if [[ -L "$profile" ]] || { [[ -f "$original" ]] && ! cmp -s "$original" "$profile"; } \
    || { [[ ! -f "$original" ]] && [[ -e "$profile" ]]; }; then
    fail 'The startup file changed during setup; it was left unchanged.'
  fi
  mv "$profile_temp" "$profile"
  profile_temp=''
}

main() {
  local os_version major minor machine git_tool need_git need_node need_gh fresh repo candidate shell_name path_node
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
  shell_name=${SHELL:-}
  case "${shell_name##*/}" in
    zsh) profile="${ZDOTDIR:-$HOME}/.zshrc"; profile_shell='zsh' ;;
    bash)
      profile="$HOME/.bash_profile"
      for candidate in .bash_profile .bash_login .profile; do
        if [[ -e "$HOME/$candidate" || -L "$HOME/$candidate" ]]; then profile="$HOME/$candidate"; break; fi
      done
      profile_shell='bash'
      ;;
    *) fail 'This quickstart supports the standard zsh or Bash Terminal setup.' ;;
  esac
  [[ "$profile" == /* ]] || fail 'The shell startup directory must be an absolute path.'
  quick_root="$HOME/.local/share/ballin-quickstart"
  quick_bin="$quick_root/bin"
  if [[ -e "$quick_root" || -L "$quick_root" ]]; then
    if ! { [[ -d "$quick_root" && ! -L "$quick_root" && -f "$quick_root/.managed" && ! -L "$quick_root/.managed" ]] \
      && [[ "$(cat "$quick_root/.managed")" == 1 ]]; }; then
      fail "Refusing to change an unrecognized directory at $quick_root."
    fi
    [[ ! -L "$quick_bin" && ( ! -e "$quick_bin" || -d "$quick_bin" ) ]] || fail "Refusing to change $quick_bin."
  fi
  path_node=$(node_on_path)
  node_tool=$(find_node "$path_node")
  gh_tool=$(find_gh)
  git_tool=$(command -v git || true)
  need_git=false; need_node=false; need_gh=false
  if [[ "$git_tool" == "$system_git" ]] && ! xcode-select -p >/dev/null 2>&1; then
    need_git=true
  else
    [[ -n "$git_tool" ]] && "$git_tool" --version >/dev/null 2>&1 || need_git=true
  fi
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
    xcode-select --install || fail 'Apple could not start Command Line Tools installation. Finish any pending installation, then run this quickstart again.'
    printf 'Finish the macOS installation, then press Return here: '
    IFS= read -r _ || fail 'Git setup did not complete.'
    git --version >/dev/null 2>&1 || fail 'Git is still unavailable. Finish Command Line Tools installation, then run this quickstart again.'
    git_tool=$(command -v git)
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
  if command -v brew >/dev/null 2>&1; then
    command_bin="$(brew --prefix)/bin"
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
