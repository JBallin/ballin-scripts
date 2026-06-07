#!/usr/bin/env bash
printf '%s\n' "🏀 let's ball..."


################################## CLONE REPO ##################################
(
  cd "$HOME"
  # only clone if folder doesn't already exist
  if [ ! -d '.ballin-scripts' ]; then
    echo ''
    git clone https://github.com/JBallin/ballin-scripts.git .ballin-scripts
  fi
)


############################## CHECK INITIAL SETUP #############################
if [ -x "$(command -v brew)" ]; then
  bin_dir="$(brew --prefix)/bin"
else
  bin_dir='/usr/local/bin'
fi

# Check that the directory used for commands is in $PATH
if [[ ":$PATH:" != *":$bin_dir:"* ]]; then
  l1="$bin_dir doesn't seem to be in your path."
  l2="Add 'export PATH=\"$bin_dir:\$PATH\"' to your shell profile."
  l3='and open a new terminal window and run this installation again.'
  printf '\n⚠️  ERROR: %s\n%s\n%s\n' "$l1" "$l2" "$l3"
  unset l1 l2 l3
# Check that either gist or brew is installed
elif [ ! -x "$(command -v gist)" ] && [ ! -x "$(command -v brew)" ]; then
  l1="Can't find Homebrew, which is needed to download 'gist'."
  l2="Download Homebrew at brew.sh or install ruby & run 'gem install gist',"
  l3='and run this installation again.'
  printf '\n⚠️  ERROR: %s\n%s\n%s\n' "$l1" "$l2" "$l3"
  unset l1 l2 l3
else


#################################### GIST ####################################
# Retrieve path for token and URL from configuration
gist_token_path="$HOME/$(bin/ballin_config get gu.token_file)"
gist_config_url="$(bin/ballin_config get gu.url)"

### DOWNLOAD GIST
# Check if gist is already installed, if not, install it
if [ ! -x "$(command -v gist)" ]; then
  printf '\n%s\n\n' '🍺 brew installing gist...'
  brew install gist
fi

### LOGIN GIST
# Check if token file exists and is valid, if not, delete it
if [ -f "$gist_token_path" ] && ! gist -l > /dev/null; then
  printf '\n%s' "🗑  Deleting $gist_token_path because token is expired/invalid"
  rm "$gist_token_path"
fi

# Prompt user for GitHub URL and token until a valid token file is created
while [ ! -f "$gist_token_path" ]; do
  printf '\n%s\n' "🙏 Please enter your Gist base URL (for example, 'https://gist.github.com' for personal accounts or 'https://gist.[your GitHub Enterprise domain]' for enterprise accounts):"
  read -p 'URL: ' URL
  # Save entered URL to configuration
  bin/ballin_config set gu.url "$URL"
  gist_config_url="$(bin/ballin_config get gu.url)"

  # Check if entered URL is valid
  if ! curl -s -o /dev/null "$gist_config_url"; then
    printf '\n%s\n' "⛔️ Unable to reach $gist_config_url. Please verify your connection and the URL, and try again."
    continue
  fi

  # Guide user to generate a new token on GitHub
  printf '\n%s' "1. Go to $gist_config_url/settings/tokens/new"
  printf '\n%s' "2. Generate a new token with the 'gist' scope"
  printf '\n%s\n' '3. Copy the token and paste it here'
  read -sp 'Token: ' TOKEN
  # Save entered token to file
  printf '%s\n' "$TOKEN" > "$gist_token_path"
  unset TOKEN

  # Set secure permissions for the token file
  chmod 600 "$gist_token_path"
done

  ########################## CREATE/UPDATE CONFIG FILE #########################
  ### CREATE/UPDATE CONFIG FILE
  (
    cd "$HOME/.ballin-scripts/config"
    if [ ! -f '../ballin.config.json' ]; then
      # create config
      cp '.defaultConfig.json' '../ballin.config.json'
      printf '\n%s\n' "🧠 Created 'ballin.config.json' file in root using default settings"
    else
      # update config
      UPDATE_RESULT=$(node "$HOME/.ballin-scripts/config/updateConfig.js")
      if [ -n "$UPDATE_RESULT" ]; then
      printf '\n🙌 %s\n' "$UPDATE_RESULT"
      fi
    fi
  )

  (
    l1='### Backup of your dev environment'
    l2='Created by [ballin-scripts](https://github.com/JBallin/ballin-scripts)'
    GIST_DESCRIPTION="$l1\n$l2\n"

    ### CHECK IF USER ALREADY HAS GIST ID
    cd "$HOME/.ballin-scripts"
    if [ "$(bin/ballin_config get gu.id)" = 'null' ]; then
      echo ''
      read -p '🤔 Do you already have a ballin-scripts backup gist? [y/N] ' YN
      if [[ $YN == 'y' || $YN == 'Y' ]]; then
        unset YN
        VALID_GIST_ID=1
        printf '\n%s\n' 'Welcome Back!'
        while [ "$VALID_GIST_ID" == 1 ]; do
          read -ep 'Enter your gist ID: ' GIST_ID
          if [ "$(gist -r "$GIST_ID")" == "$(printf "$GIST_DESCRIPTION")" ]; then
            printf '\n%s\n' '👍 Storing your previous gist ID in your config:'
            bin/ballin_config set gu.id "$GIST_ID"
            VALID_GIST_ID=0
            # TODO: overwrite ballin.config.json config file from ballin.config.json in gist (if it exists) and echo that to user (both action and the stored config?). what if there were updates to the default though? maybe just copy the default and then overwrite any values that exist in the previous ballin.config.json
          else
            printf "\n⚠️  INVALID: Expected \e[1mgist -r '%s'\e[0m to output:\n%s\n" "$GIST_ID" "$GIST_DESCRIPTION"
          fi
        done
      fi
      unset YN GIST_ID VALID_GIST_ID
    fi

    ### GENERATE + STORE GIST ID
    if [ "$(bin/ballin_config get gu.id)" = 'null' ]; then
      printf "$GIST_DESCRIPTION" > '.MyConfig.md'

      GIST_URL=$(gist -p '.MyConfig.md')
      printf "\n💥 Created a private gist titled '.MyConfig' at the following URL:\n%s\n" "$GIST_URL"

      GIST_ID=${GIST_URL##*/}
      printf '\n%s\n' '🧳 Storing your new gist ID in your config...'
      bin/ballin_config set gu.id "$GIST_ID"

      if [ -d '.gu-cache' ]; then
        rm -rf '.gu-cache'
        printf '\n%s\n' '🗑  Deleted existing .gu-cache folder'
      fi

      unset GIST_URL GIST_ID l1 l2 GIST_DESCRIPTION
      rm '.MyConfig.md'
    fi
  )

  ############################## SYMLINK BINARIES ##############################
  if ! mkdir -p "$bin_dir"; then
    printf '\n⚠️  ERROR: Unable to create %s\n' "$bin_dir"
    exit 1
  fi

  for bin in "$HOME/.ballin-scripts/bin/"*; do
    if ! ln -sfn "$bin" "$bin_dir/${bin##*/}"; then
      printf '\n⚠️  ERROR: Unable to symlink binaries into %s\n' "$bin_dir"
      exit 1
    fi
  done
  printf '\n💪 symlinked binaries into %s\n' "$bin_dir"

  printf '\n%s\n' '😎 ballin!'
fi
