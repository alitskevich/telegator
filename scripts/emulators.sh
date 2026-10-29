#!/usr/bin/env bash
# Starts every emulator but Auth: the console signs in with real Google accounts,
# so the Functions emulator verifies real tokens. Data persists in .emulator/ between runs.
set -eu
cd "$(dirname "$0")/.."
import=""
[ -f .emulator/firebase-export-metadata.json ] && import="--import=.emulator"
exec firebase emulators:start --project telegator-581db --only functions,firestore $import --export-on-exit=.emulator
