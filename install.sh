#!/usr/bin/env bash
printf "🏀 let's ball...\n"


################################## CLONE REPO ##################################
(
  cd $HOME
  # only clone if folder doesn't already exist
  if [ ! -d ".ballin-scripts" ]; then
    echo ''
    git clone https://github.com/JBallin/ballin-scripts.git
    mv ballin-scripts .ballin-scripts
  fi
)


############################## CHECK INITIAL SETUP #############################
# Check that /usr/local/bin is in $PATH
if [[ ! $PATH  = *"/usr/local/bin:"* ]]; then
  l1="usr/local/bin doesn't seem to be in your path."
  l2='Run: echo \"export PATH=/usr/local/bin:$PATH\" > $HOME/.bash_profile'
  l3="and open a new terminal window and run this installation again."
  PATH_ERROR="\n⚠️  ERROR: $l1\n$l2\n$l3\n"
  printf "$PATH_ERROR"
  unset l1 l2 l3 PATH_ERROR
# Check that either gist or brew is installed
elif [ ! -x "$(command -v gist)" ] && [ ! -x "$(command -v brew)" ]; then
  l1="Can't find Homebrew, which is needed to download 'gist'."
  l2="Download Homebrew at brew.sh or install ruby & run 'gem install gist',"
  l3="and run this installation again."
  GIST_MISSING_ERROR="\n⚠️  ERROR: $l1\n$l2\n$l3\n"
  printf "$GIST_MISSING_ERROR"
  unset l1 l2 l3 GIST_MISSING_ERROR
else


  #################################### GIST ####################################
  ### DOWNLOAD GIST
  if [ ! -x "$(command -v gist)" ]; then
    printf "\n🍺 brew installing gist...\n\n"
    brew install gist
  fi

  ### LOGIN GIST
  if [ -f $HOME/.gist ] && ! $(gist -l > /dev/null); then
    printf "\n🗑  Deleting ~/.gist because token is expired/invalid"
    rm $HOME/.gist
  fi
  while [ ! -f $HOME/.gist ]; do
    printf "\n🙏 Please login to gist:\n"
    gist --login
  done


  ########################## CREATE/UPDATE CONFIG FILE #########################
  ### CREATE/UPDATE CONFIG FILE
  (
    cd $HOME/.ballin-scripts/config/
    if [ ! -f ballin.json ]; then
      # create config
      cp .defaultConfig.json ballin.json
      printf "\n🧠 Created 'ballin.json' file in /config using default settings\n"
    else
      # update config
      UPDATE_RESULT=$(node $HOME/.ballin-scripts/config/updateConfig.js)
      if [ ! -z "$UPDATE_RESULT" ]; then
        printf "\n🙌 $UPDATE_RESULT\n"
      fi
    fi
  )

  (
    l1='### Backup of your dev environment'
    l2='Created by [ballin-scripts](https://github.com/JBallin/ballin-scripts)'
    GIST_DESCRIPTION="$l1\n$l2\n"

    ### CHECK IF USER ALREADY HAS GIST ID
    cd $HOME/.ballin-scripts/
    if [ $(bin/ballin_config get gu.id) == 'null' ]; then
      echo ''
      read -p "🤔 Do you already have a ballin-scripts backup gist? [y/N] " YN
      if [[ $YN == "y" || $YN == "Y" ]]; then
        unset YN
        VALID_GIST_ID=1
        printf "\nWelcome Back!\n"
        while [ $VALID_GIST_ID == 1 ]; do
          read -ep "Enter your gist ID: " GIST_ID
          if [ "$(gist -r $GIST_ID)" == "$(printf "$GIST_DESCRIPTION")" ]; then
            printf "\n👍 Storing your previous gist ID in your config:\n"
            bin/ballin_config set gu.id $GIST_ID
            VALID_GIST_ID=0
            # TODO: overwrite ballin.json config file from ballin.json in gist (if it exists) and echo that to user (both action and the stored config?). what if there were updates to the default though? maybe just copy the default and then overwrite any values that exist in the previous ballin.json
          else
            printf "\n⚠️  INVALID: Expected \e[1mgist -r '$GIST_ID'\e[0m to output:\n$GIST_DESCRIPTION\n"
          fi
        done
      fi
      unset YN GIST_ID VALID_GIST_ID
    fi

    ### GENERATE + STORE GIST ID
    if [ $(bin/ballin_config get gu.id) == 'null' ]; then
      printf "$GIST_DESCRIPTION" > .MyConfig.md

      GIST_URL=$(gist -p .MyConfig.md)
      printf "\n💥 Created a private gist titled '.MyConfig' at the following URL:\n$GIST_URL\n"

      GIST_ID=${GIST_URL##*/}
      printf "\n🧳 Storing your new gist ID in your config...\n"
      bin/ballin_config set gu.id $GIST_ID

      if [ -d .gu-cache ]; then
        rm -rf .gu-cache
        printf "\n🗑  Deleted existing .gu-cache folder\n"
      fi

      unset GIST_URL GIST_ID l1 l2 GIST_DESCRIPTION
      rm .MyConfig.md
    fi

    ################################# NPM INSTALL ################################
    # production === don't install devDeps
    printf "\n🧐 installing any missing dependencies...\n"
    npm i --production > /dev/null 2>&1
  )

  ############################## SYMLINK BINARIES ##############################
  for bin in $HOME/.ballin-scripts/bin/*; do
    ln -sf $bin /usr/local/bin
  done
  printf "\n💪 symlinked binaries\n"

  printf "\n😎 ballin!\n"
fi
