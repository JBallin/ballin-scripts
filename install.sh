#!/usr/bin/env bash

printf "let's ball...\n"

### CLONE REPO
(
  cd $HOME
  # only clone if folder doesn't already exist
  if [ ! -d ".ballin-scripts" ]; then
    echo ''
    git clone https://github.com/JBallin/ballin-scripts.git
    mv ballin-scripts .ballin-scripts
  fi
)

### CHECK INITIAL SETUP
# Check that /usr/local/bin is in $PATH
if [[ ! $PATH  = *"/usr/local/bin:"* ]]; then
  printf "\nusr/local/bin doesn't seem to be in your path. Add 'export PATH=/usr/local/bin:$PATH' to the bottom of your profile/rc file' and open a new terminal window\n"
# Check that either gist or brew is installed
elif [ ! -x "$(command -v gist)" ] && [ ! -x "$(command -v brew)" ]; then
    printf "\nCan't find Homebrew, which is needed to download 'gist'. Either download Homebrew at brew.sh or install ruby & run 'gem install gist, and then run this installation again.'\n"

### INITIAL SETUP LOOKS GOOD!
else

  ### GIST
  ## DOWNLOAD GIST
  if [ ! -x "$(command -v gist)" ]; then
    printf "\nbrew installing gist...\n\n"
    brew install gist
  fi

  ## LOGIN GIST
  # TODO: find way to truly verify if user is logged in? token in .gist may be expired
  while [ ! -f $HOME/.gist ]; do
    printf "\nPlease login to gist!\n\n"
    gist --login
  done

  ## STORE GIST ID
  # TODO: check if already have gist ID in config before proceeding
  # ballin_config get gu.id
  # ask do you have a gist id that you've used with ballin-scripts before? Y/N
  # Y?
  # Please provide it (accept user input)
  # Check that github API gives status 200, otherwise say that gist ID isn't valid and kick back to above
  # N?
  printf "\nCreating a private gist titled '.MyConfig' at the following URL:\n"
  printf '### Backup of environment files\n\nCreated by [ballin-scripts](https://github.com/JBallin/ballin-scripts)' > .MyConfig.md
  gist -p .MyConfig.md > CONFIG_GIST_URL
  cat CONFIG_GIST_URL
  # TODO: extract ID from CONFIG_GIST_URL and store in config
  # NEW_GIST_ID=$( cat CONFIG_GIST_URL |  )
  # ballin_config set gu.id
  rm .MyConfig.md CONFIG_GIST_URL

  ### CREATE/UPDATE CONFIG FILE
  (
    cd $HOME/.ballin-scripts/config/
    if [ ! -f ballin.json ]; then
      cp .defaultconfig.json ballin.json
      printf "\nCreated 'ballin.json' file in /config using default settings\n\n"
    fi
  )



  ### NPM INSTALL (production === don't install devDeps)
  printf "Installing any missing dependencies...\n\n"
  npm i $HOME/.ballin-scripts --production > /dev/null 2>&1

  ### SYMLINK BINARIES
  for bin in $HOME/.ballin-scripts/bin/*; do
    ln -sf $bin /usr/local/bin
  done
  printf "\nSymlinked binaries\n\n"

  ### DONE
  printf "ballin!\n"

fi
