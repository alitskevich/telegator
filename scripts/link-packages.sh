#!/usr/bin/env bash
#
# Usage: scripts/link-packages.sh <package>...
#
# Links sibling checkouts (../<package>, i.e. ~/Projects/<package>) into
# node_modules/, so the console (packages/tg-web) builds against library source:
# esbuild and Tailwind read each package's `exports` map from there. The
# Arrmatura packages are private and unpublished, so a checkout is the only
# source; `npm install` prunes the links, hence `postinstall`.
#
# Run by `npm run link:packages` / `postinstall`. Safe to re-run.

set -eu

[ $# -gt 0 ] || { echo "usage: $0 <package>..." >&2; exit 1; }

mkdir -p node_modules

for pkg in "$@"; do
  if [ -d "../$pkg" ]; then
    rm -rf "node_modules/$pkg";
    ln -sfn "../../$pkg" "node_modules/$pkg"
    echo "linked package: $pkg"
  else
    echo "skipped $pkg: no checkout at ../$pkg" >&2
  fi
done
