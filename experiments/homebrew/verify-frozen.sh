#!/bin/bash
# Checks trusted local transport bytes, not release publication or authenticity.
set -euo pipefail
[[ $# == 2 && "$2" =~ ^[a-f0-9]{40}$ ]] || { echo 'Use: verify-frozen.sh ARTIFACT_DIR FULL_SHA' >&2; exit 2; }
artifact=$(cd "$1" && pwd -P)
[[ $(cat "$artifact/source-sha") == "$2" ]] || { echo 'Frozen source SHA does not match.' >&2; exit 1; }
# Do not let an edited checksum manifest name arbitrary files or omit a member.
expected=$'source-sha\nsource.bundle\nsource.tar.gz\nbootstrap/package.json\nbootstrap/quickstart.sh\nbootstrap/install.sh\nbootstrap/commands/repo_update.ts'
actual=$(sed -E -e 's/^[a-f0-9]{64}  //' -e t -e 's/.*/INVALID/' "$artifact/SHA256SUMS")
[[ "$actual" == "$expected" ]] || { echo 'Invalid frozen checksum manifest.' >&2; exit 1; }
for member in source-sha source.bundle source.tar.gz bootstrap/package.json bootstrap/quickstart.sh bootstrap/install.sh bootstrap/commands/repo_update.ts; do
  [[ -f "$artifact/$member" && ! -L "$artifact/$member" ]] || { echo 'Frozen artifact contains a missing file or symlink.' >&2; exit 1; }
done
(cd "$artifact" && shasum -a 256 -c SHA256SUMS) >&2
