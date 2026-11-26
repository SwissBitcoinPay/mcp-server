#!/usr/bin/env bash
# Checks the deployment scripts with ShellCheck 0.11.0, the same everywhere (CI, Release, your
# machine): the official static binary, as PyPI's shellcheck-py ships it, pinned by its SHA-256 and
# installed in a virtual environment of its own: whatever ShellCheck a machine has, or none, and
# without sudo.
#
#   scripts/shellcheck.sh      needs python3 with venv, Linux x86-64
set -euo pipefail
cd "$(dirname "$0")/.."

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
python3 -m venv "$dir/venv"
echo 'shellcheck-py==0.11.0.1 --hash=sha256:1b274df81de5b000ff78db433e7328b87e52e3c38481c60f8e488c3095beef05' >"$dir/requirements.txt"
"$dir/venv/bin/pip" install --quiet --disable-pip-version-check --only-binary=:all: --require-hashes -r "$dir/requirements.txt"
"$dir/venv/bin/shellcheck" --version | sed -n 2p
"$dir/venv/bin/shellcheck" -x deploy/*.sh scripts/*.sh
