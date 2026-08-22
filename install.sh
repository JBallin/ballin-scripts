#!/usr/bin/env bash
printf '%s\n' "🏀 let's ball..."

repo_dir="$HOME/.ballin-scripts"
docs_url='https://github.com/JBallin/ballin-scripts/blob/main/docs/installation.md'
analytics_docs_url='https://github.com/JBallin/ballin-scripts/blob/main/docs/analytics.md'
installer_source_url='https://github.com/JBallin/ballin-scripts/blob/main/install.sh'
required_node_version='24.12'
repo_existed=true
setup_mode='refresh'

print_stale_checkout_guidance() {
  printf '\n⚠️  ERROR: Unable to update %s before setup.\n' "$repo_dir"
  printf 'Update or delete %s, then run this installer again.\n' "$repo_dir"
}

############################### CHECK PREREQUISITES ############################
if [ ! -d "$repo_dir" ]; then
  repo_existed=false
  setup_mode='fresh'
fi

if ! command -v git >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; then
  printf '\n⚠️  ERROR: Git is required before install can continue.\n'
  printf '\nInstall Git, then run this installer again.\n'
  exit 1
fi

if [ ! -x "$(command -v node)" ]; then
  printf '\n⚠️  ERROR: Node.js is required.\n'
  printf '\nRecommended: install Node.js %s or newer with nvm.' "$required_node_version"
  printf '\nSetup guide: %s\n' "$docs_url"
  printf '\nAlternatively:\n  brew install node\n'
  printf '\nThen run this installer again.\n'
  exit 1
elif [ "$(node -p "const [major, minor] = process.versions.node.split('.').map(Number); const [requiredMajor, requiredMinor] = '$required_node_version'.split('.').map(Number); major > requiredMajor || (major === requiredMajor && minor >= requiredMinor)" 2>/dev/null)" != 'true' ]; then
  printf '\n⚠️  ERROR: Node.js %s or newer is required.\n' "$required_node_version"
  printf '\nRecommended: install Node.js %s or newer with nvm.' "$required_node_version"
  printf '\nSetup guide: %s\n' "$docs_url"
  printf '\nAlternatively:\n  brew install node\n'
  printf '\nThen run this installer again.\n'
  exit 1
fi

if [ "$repo_existed" = false ]; then
  printf '\nInstallation plan\n'
  printf -- '- Clone Ballin into %s and create its config there.\n' "$repo_dir"
  printf -- '- Link the ballin command from Homebrew\047s bin directory when available, otherwise from %s.\n' "$HOME/.local/bin"
  printf -- '- Create a local analytics install ID when analytics are enabled; later commands may send the documented minimal event.\n'
  printf -- '- Offer optional secret-Gist backup setup separately; adoption can restore compatible config preferences.\n'
  printf -- '- Treat .backup-cache as derived state; later backup setup may invalidate an unproven cache before configuring a destination.\n'
  printf -- '- Do not run ballin update or collect backup snapshots during installation.\n'
  printf -- '- Existing command targets may be replaced; later refreshes can merge checkout files and add config defaults.\n'
  printf -- '- Uninstall removes owned links and this checkout, but not a remote Gist.\n'
  printf 'Review installer source: %s\n' "$installer_source_url"
  printf 'Inspect effects, uninstall, and manual removal: %s\n' "$docs_url"

  printf '\nProceed with installation? [y/N] '
  IFS= read -r install_confirm
  if [ "$install_confirm" != 'y' ] && [ "$install_confirm" != 'Y' ]; then
    printf '\nInstallation cancelled; no installation changes were made.\n'
    exit 0
  fi
fi

################################## CLONE REPO ##################################
if ! (
  cd "$HOME" || exit
  if [ "$repo_existed" = false ]; then
    echo ''
    if ! git clone https://github.com/JBallin/ballin-scripts.git .ballin-scripts; then
      exit 1
    fi
  fi
); then
  printf '\n⚠️  ERROR: Unable to prepare %s\n' "$repo_dir"
  exit 1
fi

############################ UPDATE EXISTING REPO ##############################
if [ "$repo_existed" = true ]; then
  if [ -f "$repo_dir/commands/repo_update.ts" ]; then
    if ! (
      cd "$repo_dir" || exit
      node "$repo_dir/commands/repo_update.ts" "$repo_dir"
    ); then
      print_stale_checkout_guidance
      exit 1
    fi
  elif ! (
    cd "$repo_dir" || exit
    git fetch origin +main:refs/remotes/origin/main \
      && git checkout main \
      && git merge origin/main
  ); then
    print_stale_checkout_guidance
    exit 1
  fi
fi

################################# TYPED SETUP ##################################
if [ ! -f "$repo_dir/commands/install_setup.ts" ]; then
  print_stale_checkout_guidance
  exit 1
fi

(
  cd "$repo_dir" || exit
  node "$repo_dir/commands/install_setup.ts" setup "$repo_dir" "$docs_url" "$analytics_docs_url" "$setup_mode"
)
setup_status=$?
if [ "$setup_status" -ne 0 ]; then
  exit "$setup_status"
fi
