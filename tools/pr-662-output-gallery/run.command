#!/bin/bash
set -eu
exec node "$(cd -- "$(dirname -- "$0")" && pwd)/gallery.cjs"
