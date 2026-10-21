#!/usr/bin/env bash
# Starts every emulator. Data persists in .emulator/ between runs.
set -eu
cd "$(dirname "$0")/.."
import=""
[ -f .emulator/firebase-export-metadata.json ] && import="--import=.emulator"
exec firebase emulators:start --only auth,functions,firestore $import --export-on-exit=.emulator
