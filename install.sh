#!/usr/bin/env bash
printf '%s\n' "🏀 let's ball..."

repo_dir="$HOME/.ballin-scripts"
docs_url='https://github.com/JBallin/ballin-scripts/blob/main/docs/README.md'
required_node_version='24.12'

################################## CLONE REPO ##################################
if ! (
  cd "$HOME" || exit
  # only clone if folder doesn't already exist
  if [ ! -d '.ballin-scripts' ]; then
    echo ''
    if ! git clone https://github.com/JBallin/ballin-scripts.git .ballin-scripts; then
      exit 1
    fi
  fi
); then
  printf '\n⚠️  ERROR: Unable to prepare %s\n' "$repo_dir"
  exit 1
fi


############################## CHECK INITIAL SETUP #############################
if [ -x "$(command -v brew)" ]; then
  bin_dir="$(brew --prefix)/bin"
else
  # Use a conventional user-owned bin directory when Homebrew is unavailable.
  bin_dir="$HOME/.local/bin"
fi

# Check that the directory used for commands is in $PATH
if [[ ":$PATH:" != *":$bin_dir:"* ]]; then
  l1="$bin_dir doesn't seem to be in your path."
  l2="Add 'export PATH=\"$bin_dir:\$PATH\"' to your shell profile."
  l3='and open a new terminal window and run this installation again.'
  printf '\n⚠️  ERROR: %s\n%s\n%s\n' "$l1" "$l2" "$l3"
  unset l1 l2 l3
  exit 1
# Check that Node.js is available before running configuration commands
elif [ ! -x "$(command -v node)" ]; then
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
else


########################## CREATE/UPDATE CONFIG FILE #########################
config_existed=true
if [ ! -f "$repo_dir/ballin.config.json" ]; then
  config_existed=false
fi
gu_host_existed=false
if [ "$config_existed" = true ] \
  && [ "$(node -e "const fs = require('fs'); const config = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(config.gu && Object.prototype.hasOwnProperty.call(config.gu, 'host') ? 'true' : 'false')" "$repo_dir/ballin.config.json" 2>/dev/null)" = 'true' ]; then
  gu_host_existed=true
fi

# Configuration must succeed before Gist credentials or command symlinks are touched.
if [ -f "$repo_dir/commands/install_setup.ts" ] \
  && node "$repo_dir/commands/install_setup.ts" configure "$repo_dir" "$docs_url"; then
  :
else
  if ! (
    cd "$repo_dir/config"
    if [ ! -f '../ballin.config.json' ]; then
      # create config
      if ! cp '.defaultConfig.json' '../ballin.config.json'; then
        exit 1
      fi
      printf '\n%s\n' "🧠 Created 'ballin.config.json' file in root using default settings"
    else
      # ballin_update reruns this installer after pulling changes; add any new
      # default options to the existing config without overwriting user settings.
      if ! UPDATE_RESULT=$(node "$repo_dir/config/updateConfig.ts"); then
        exit 1
      fi
      if [ -n "$UPDATE_RESULT" ]; then
        printf '\n🙌 %s\n' "$UPDATE_RESULT"
        printf '\n👀 Docs: %s\n' "$docs_url"
      fi
    fi
  ); then
    printf '\n⚠️  ERROR: Unable to create or update ballin.config.json\n'
    exit 1
  fi
fi


#################################### GIST ####################################
  if ! node "$repo_dir/commands/install_setup.ts" gist "$repo_dir" "$docs_url" "$gu_host_existed"; then
    printf '\n⚠️  ERROR: Unable to configure Gist backup\n'
    exit 1
  fi

  ############################## SYMLINK BINARIES ##############################
  if [ -f "$repo_dir/commands/install_setup.ts" ]; then
    if ! node "$repo_dir/commands/install_setup.ts" symlink-binaries "$repo_dir" "$bin_dir"; then
      exit 1
    fi
  else
    if ! mkdir -p "$bin_dir"; then
      printf '\n⚠️  ERROR: Unable to create %s\n' "$bin_dir"
      exit 1
    fi

    for bin in "$repo_dir/bin/"*; do
      if ! ln -sfn "$bin" "$bin_dir/${bin##*/}"; then
        printf '\n⚠️  ERROR: Unable to symlink binaries into %s\n' "$bin_dir"
        exit 1
      fi
    done
    printf '\n💪 symlinked binaries into %s\n' "$bin_dir"
  fi

  if [ "$config_existed" = false ] && [ -f "$repo_dir/ballin.config.json" ]; then
    printf '\n👀 Docs: %s\n' "$docs_url"
  fi

  printf '\n%s\n' '😎 ballin!'
fi
