#!/usr/bin/env bash

(
  cd $HOME
  git clone https://github.com/JBallin/ballin-scripts.git
  mv ballin-scripts .ballin-scripts
)

### CHECK INITIAL SETUP
# Check for $HOME/.ballin-scripts
if [ ! -d "$HOME/.ballin-scripts" ]; then
  echo "Can't find ~/.ballin-scripts, try 'mv ~/ballin-scripts ~/.ballin-scripts'"
# Check that /usr/local/bin is in $PATH
elif [[ ! $PATH  = *"/usr/local/bin:"* ]]; then
  echo "usr/local/bin doesn't seem to be in your path. Add 'export PATH=/usr/local/bin:$PATH' to the bottom of your profile/rc file' and open a new terminal window"
# Check that either gist or brew is installed
elif [ ! -x "$(command -v gist)" ] && [ ! -x "$(command -v brew)" ]; then
    echo "Can't find Homebrew, which is needed to download 'gist'. Download at Homebrew at brew.sh or install ruby and run 'gem install gist'"

### INITIAL SETUP LOOKS GOOD!
else
  ### SYMLINK BINARIES
  # ballin
  ln -sf $HOME/.ballin-scripts/bin/ballin /usr/local/bin
  # ballin_update
  ln -sf $HOME/.ballin-scripts/bin/ballin_update /usr/local/bin
  # ballin_uninstall
  ln -sf $HOME/.ballin-scripts/bin/ballin_uninstall /usr/local/bin
  # ballin_config
  ln -sf $HOME/.ballin-scripts/bin/ballin_config /usr/local/bin
  # gu
  ln -sf $HOME/.ballin-scripts/scripts/gist_update/bin/gu /usr/local/bin
  # theme
  ln -sf $HOME/.ballin-scripts/scripts/atom_theme/bin/theme /usr/local/bin
  # up
  ln -sf $HOME/.ballin-scripts/scripts/updater/bin/up /usr/local/bin


  ### GIST
  ## DOWNLOAD GIST
  if [ ! -x "$(command -v gist)" ]; then
    echo 'BALLIN: brew installing gist...'
    brew install gist
  fi

  ## LOGIN GIST
  # TODO: find way to truly verify if user is logged in? token in .gist may be expired
  while [ ! -f $HOME/.gist ]; do
    printf "BALLIN: \nPlease login to gist to continue!\n\n"
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
  echo 'BALLIN: creating private gist with title .MyConfig'
  printf '### Backup of environment files\n\nCreated by [ballin-scripts](https://github.com/JBallin/ballin-scripts)' > .MyConfig.md
  gist -p .MyConfig.md > CONFIG_GIST_URL
  cat CONFIG_GIST_URL
  # TODO: extract ID from CONFIG_GIST_URL and store in config
  # NEW_GIST_ID=$( cat CONFIG_GIST_URL |  )
  # ballin_config set gu.id
  rm .MyConfig.md CONFIG_GIST_URL

  ### NPM INSTALL (production === don't install devDeps)
  (
    export NODE_ENV='production'
    cd $HOME/.ballin-scripts
    npm i > /dev/null 2>&1
    cd scripts
    for script in */ ; do
      cd "$script"
      npm i > /dev/null 2>&1
      cd ..
    done
    unset NODE_ENV
  )


  ### CREATE/UPDATE CONFIG FILE
  (
    cd $HOME/.ballin-scripts/config/
    if [ ! -f ballin.json ]; then
      cp .defaultconfig.json ballin.json
    fi
  )


  ### DONE
  echo "BALLIN: ballin!"


fi
