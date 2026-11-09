#!/bin/bash
# Local unpublished candidate only; public Quickstart and release selection remain separate.
set -euo pipefail
choice_root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
choice_fail() { printf '%s\n' "$*" >&2; return 1; }
choice_confirm() {
  local answer
  printf '%s [y/N]: ' "$1"
  IFS= read -r answer || return 1
  [[ "$answer" == y || "$answer" == Y ]]
}
choice_platform() {
  [[ "$(uname -s)" == Darwin ]] || choice_fail 'This experiment requires macOS.'
  choice_arch=$(uname -m)
  case "$choice_arch" in arm64|x86_64) ;; *) choice_fail 'Unsupported architecture.'; return 1 ;; esac
  # uname under Rosetta describes the process, not the hardware. Do not bootstrap
  # an Intel prefix on Apple Silicon, or force an obsolete installer on Intel.
  local translated
  translated=$(/usr/sbin/sysctl -in sysctl.proc_translated 2>/dev/null) || translated=0
  [[ "$translated" != 1 ]] || choice_fail 'Run a native terminal, not Rosetta, then retry.'
}
choice_brew_path() {
  case "$choice_arch" in arm64) choice_prefix=/opt/homebrew ;; x86_64) choice_prefix=/usr/local ;; esac
  choice_brew="$choice_prefix/bin/brew"
}
choice_verify_brew() {
  [[ -x "$choice_brew" ]] || choice_fail 'Homebrew is not usable. Inspect upstream recovery instructions; no route switch occurred.'
  local prefix
  prefix=$("$choice_brew" --prefix) || return $?
  [[ "$prefix" == "$choice_prefix" ]] || choice_fail 'Homebrew reported an unexpected prefix. Inspect it before retrying.'
  "$choice_brew" --version
}
choice_install_brew() {
  local status=0 url='https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh' code
  [[ "$choice_arch" == arm64 ]] || { choice_fail 'Current official Homebrew bootstrap does not support Intel Macs. Choose the direct route; no obsolete installer will run.'; return 1; }
  [[ ! -e "$choice_prefix" && ! -L "$choice_prefix" ]] || { choice_fail 'A partial or unusable Homebrew prefix exists. Inspect it before retrying; no repair or removal was attempted.'; return 1; }
  [[ -z "${NONINTERACTIVE:-}" && -z "${CI:-}" ]] || { choice_fail 'Unset CI and NONINTERACTIVE and retry from an interactive terminal.'; return 1; }
  choice_confirm 'Install Homebrew using its official installer? It may request your Mac administrator password and install developer tools' || { printf 'Cancelled before Homebrew installation.\n'; choice_cancelled=true; return 0; }
  code=$(curl -q -sS -L --proto '=https' --proto-redir '=https' --tlsv1.2 --connect-timeout 15 --max-time 120 -w '%{http_code}' "$url" -o "$choice_scratch/homebrew-install.sh") || status=$?
  [[ "$status" == 0 && "$code" == 200 && -s "$choice_scratch/homebrew-install.sh" ]] || { choice_fail "Homebrew download failed (curl $status, HTTP ${code:-unknown}). No installer executed. Retry explicitly."; return 1; }
  /bin/bash -n "$choice_scratch/homebrew-install.sh" || return $?
  printf 'Official installer: %s\nSHA256: ' "$url"
  shasum -a 256 "$choice_scratch/homebrew-install.sh"
  # Execute the downloaded bytes unchanged, with the caller's terminal attached.
  # Upstream owns consent, sudo and developer-tool behavior. Never feed answers.
  BASH_ENV='' /bin/bash "$choice_scratch/homebrew-install.sh" || status=$?
  [[ "$status" == 0 ]] || { choice_fail "Homebrew setup stopped ($status). Inspect its output and retry; no direct fallback."; return "$status"; }
}
choice_shell_setup() {
  local snapshot="$choice_scratch/profile.json" profile
  printf 'For this shell, run: eval "$(%s shellenv %s)"\n' "$choice_brew" "${SHELL##*/}"
  if ! "$choice_node" "$choice_root/profile.cjs" inspect "$choice_brew" > "$snapshot"; then
    printf 'Automatic startup setup skipped. Review your shell configuration manually.\n'; return 0
  fi
  profile=$("$choice_node" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).file)' "$snapshot")
  if choice_confirm "Add Homebrew shellenv to $profile?"; then
    "$choice_node" "$choice_root/profile.cjs" apply "$choice_brew" "$snapshot" || { printf 'Startup setup was not changed. Review it manually.\n'; return 0; }
    printf 'Homebrew startup setup saved.\n'
  else printf 'Startup setup skipped. Future-shell activation remains manual.\n'; fi
}
choice_main() {
  [[ $# == 2 && "$2" =~ ^[a-f0-9]{40}$ ]] || { choice_fail 'Usage: run-choice.sh FROZEN_ARTIFACT_DIRECTORY FULL_COMMIT_SHA'; return 1; }
  [[ -t 0 && -t 1 ]] || { choice_fail 'Interactive terminal required. No changes made; run the saved script from Terminal.'; return 1; }
  local artifact sha=$2 route status=0 shellenv command selected previous choice_cancelled=false
  artifact=$(cd "$1" && pwd -P)
  "$choice_root/verify-frozen.sh" "$artifact" "$sha"
  printf 'Ballin installation-owner experiment, unpublished commit %s\n' "$sha"
  printf 'Choose: Homebrew [h], install without Homebrew [d], or cancel [c]: '
  IFS= read -r route || return 0
  case "$route" in
    d) selected=$(type -P ballin) || selected=''
       for command in "$HOME/.local/bin/ballin" "$selected"; do
         if [[ -e "$command" || -L "$command" ]]; then
           [[ "$command" -ef "$HOME/.ballin-scripts/bin/ballin" ]] || { choice_fail "Conflicting command: $command. Inspect its owner before direct installation."; return 1; }
         fi
       done
       printf 'Owner: direct installer. Code/settings: ~/.ballin-scripts; command: ~/.local/bin/ballin. No Brew calls.\n'
       BALLIN_EXPERIMENT_INSTALL_OWNER=direct "$choice_root/run-frozen-direct.sh" "$artifact" "$sha"; return $? ;;
    c|'') printf 'Cancelled.\n'; return 0 ;;
    h) ;;
    *) choice_fail 'Invalid choice. No installation started.'; return 1 ;;
  esac
  choice_platform
  choice_brew_path
  printf 'Owner: Homebrew at %s. Ballin state: ~/.ballin. No migration or forced links.\n' "$choice_prefix"
  choice_scratch=$(mktemp -d "${TMPDIR:-/tmp}/ballin-choice.XXXXXX")
  trap 'rm -rf -- "$choice_scratch"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  mkdir "$choice_scratch/artifact"
  cp -R "$artifact/." "$choice_scratch/artifact/"
  artifact="$choice_scratch/artifact"
  "$choice_root/verify-frozen.sh" "$artifact" "$sha"
  if [[ ! -x "$choice_brew" ]]; then
    choice_install_brew || status=$?
    [[ "$choice_cancelled" == false ]] || return 0
    [[ "$status" == 0 ]] || return "$status"
  fi
  choice_verify_brew
  previous=$(type -P ballin) || previous=''
  shellenv=$("$choice_brew" shellenv bash) || return $?
  eval "$shellenv"
  # Refuse other owners even when Brew's bin would shadow their existing command.
  for command in "$HOME/.local/bin/ballin" "$choice_prefix/bin/ballin" "$previous"; do
    if [[ -e "$command" || -L "$command" ]]; then
      [[ "$command" -ef "$choice_prefix/opt/ballin-experiment/bin/ballin" ]] || { choice_fail "Conflicting command: $command. Choose an owner explicitly; no force linking."; return 1; }
    fi
  done
  selected=$(type -P ballin) || selected=''
  [[ -z "$selected" || "$selected" -ef "$choice_prefix/opt/ballin-experiment/bin/ballin" ]] || { choice_fail "Another Ballin command is selected: $selected. Inspect ownership first."; return 1; }
  choice_confirm 'Create a guest-local experimental tap and install the frozen Ballin package and its Node dependency with Homebrew?' || return 0
  # The generator needs Node, so install the frozen archive's declared major first.
  tar -xzf "$artifact/source.tar.gz" -C "$choice_scratch"
  local source="$choice_scratch/ballin-scripts" major checksum repository tap_path
  local tap=ballin-local/choice formula=ballin-local/choice/ballin-experiment
  major=$(cat "$source/.nvmrc")
  [[ "$major" =~ ^[1-9][0-9]*$ ]] || { choice_fail 'Invalid frozen Node major.'; return 1; }
  export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_UPGRADE=1 HOMEBREW_NO_INSTALL_CLEANUP=1
  "$choice_brew" install --formula "node@$major" || { choice_fail 'Node installation failed. Homebrew remains installed; inspect and retry.'; return 1; }
  choice_node="$choice_prefix/opt/node@$major/bin/node"
  checksum=$(shasum -a 256 "$artifact/source.tar.gz"); checksum=${checksum%% *}
  repository=$("$choice_brew" --repository)
  [[ "$repository" == "$choice_prefix" || "$repository" == "$choice_prefix/Homebrew" ]] || { choice_fail 'Unexpected Homebrew repository.'; return 1; }
  tap_path="$repository/Library/Taps/ballin-local/homebrew-choice"
  if [[ ! -e "$tap_path" && ! -L "$tap_path" ]]; then
    HOMEBREW_DEVELOPER=1 "$choice_brew" tap-new --no-git "$tap"
  fi
  [[ -d "$tap_path/Formula" && ! -L "$tap_path" && ! -L "$tap_path/Formula" ]] || { choice_fail 'Unsafe or incomplete local experiment tap. Inspect it manually.'; return 1; }
  # Keep source available after temporary scratch cleanup. Never replace a tap's
  # existing source/formula with different bytes during retry.
  if [[ -e "$tap_path/source.tar.gz" || -L "$tap_path/source.tar.gz" ]]; then
    [[ -f "$tap_path/source.tar.gz" && ! -L "$tap_path/source.tar.gz" ]] && cmp -s "$artifact/source.tar.gz" "$tap_path/source.tar.gz" || { choice_fail 'Local experiment tap contains different source. Inspect it before switching candidates.'; return 1; }
  else ( set -o noclobber; cat "$artifact/source.tar.gz" > "$tap_path/source.tar.gz" ); fi
  "$choice_node" "$source/experiments/homebrew/generate-formula.cjs" --archive "$tap_path/source.tar.gz" --sha256 "$checksum" --source-sha "$sha" --formula "$formula" > "$choice_scratch/ballin-experiment.rb"
  if [[ -e "$tap_path/Formula/ballin-experiment.rb" || -L "$tap_path/Formula/ballin-experiment.rb" ]]; then
    [[ -f "$tap_path/Formula/ballin-experiment.rb" && ! -L "$tap_path/Formula/ballin-experiment.rb" ]] && cmp -s "$choice_scratch/ballin-experiment.rb" "$tap_path/Formula/ballin-experiment.rb" || { choice_fail 'Local experiment formula differs. Inspect it before retrying.'; return 1; }
  else ( set -o noclobber; cat "$choice_scratch/ballin-experiment.rb" > "$tap_path/Formula/ballin-experiment.rb" ); fi
  "$choice_brew" install --formula "$formula" || { choice_fail 'Ballin installation failed. Homebrew remains installed; inspect and rerun to retry.'; return 1; }
  command="$choice_prefix/opt/ballin-experiment/bin/ballin"
  [[ -x "$command" && "$choice_prefix/bin/ballin" -ef "$command" ]] || { choice_fail 'Package command links were not verified. Inspect Homebrew; no forced links.'; return 1; }
  # Do not silently onboard an older installed package if brew install was a no-op.
  "$choice_node" -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1])); if(m.manager!=="homebrew" || m.schema!==2 || m.formula!==process.argv[4] || m.sourceRevision!==process.argv[2] || m.archiveSha256!==process.argv[3] || m.selection?.kind!=="development") process.exit(1)' "$choice_prefix/opt/ballin-experiment/libexec/.ballin-package.json" "$sha" "$checksum" "$formula" || { choice_fail 'Installed package is not this frozen candidate. Inspect the existing formula; no automatic upgrade.'; return 1; }
  choice_shell_setup
  printf 'Installed command: %s\n' "$command"
  "$command" setup --initial
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then choice_main "$@"; fi
