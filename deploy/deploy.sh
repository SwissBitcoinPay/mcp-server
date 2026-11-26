#!/usr/bin/env bash
# Installs or updates the hosted assistant on a server with a published release, from your own
# machine and this repository; the same command installs the first time and updates afterwards.
#
#   deploy/deploy.sh <admin@server> <public-host> <version> [--skip-dns-check] [--smoke]
#                    [--allow-downgrade]
#
#   <admin@server>    an account with sudo and your SSH key (such as debian@<IPv4> or ubuntu@<IPv4>)
#   <public-host>     the assistant's DNS name, already pointing to the server (mcp.example.com)
#   <version>         the release to deploy, such as 1.0.0: its tag v<version> must be on GitHub's
#                     main, and nothing else is deployed (docs/RELEASING.md)
#   --smoke           then runs the release's scripts/smoke.mjs against it (needs Node 22 here; it
#                     changes nothing)
#   --allow-downgrade deploys a version older than the one running (docs/RELEASING.md, « Going back »)
#
# Needs here: git, ssh, curl, bash (3.2 is enough: macOS). The server needs nothing but SSH: no
# access to GitHub. Its secrets are made on the server and never leave it.
set -euo pipefail

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

target=${1:-}
host=${2:-}
version=${3:-}
[[ -n $target && -n $host && -n $version && $target != -* && $host != -* && $version != -* ]] || {
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}
shift 3
setup_args=()
smoke=0
allow_downgrade=0
while (($#)); do
  case "$1" in
    --skip-dns-check) setup_args+=(--skip-dns-check) ;;
    --smoke) smoke=1 ;;
    --allow-downgrade) allow_downgrade=1 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
# Checked here too: these values go into commands run on the server.
[[ $host =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ ]] || die "bad public host: $host"
[[ $target =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.:_-]+$ ]] || die "bad SSH target (user@address): $target"
readonly VERSION_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
[[ $version =~ $VERSION_RE ]] || die "the version is x.y.z, such as 1.0.0: $version"

# -1, 0 or 1 as version $1 is lower than, equal to or greater than version $2 (x.y.z).
version_order() {
  local IFS=. i
  local -a a b
  read -r -a a <<<"$1"
  read -r -a b <<<"$2"
  for i in 0 1 2; do
    if ((a[i] < b[i])); then
      echo -1
      return 0
    fi
    if ((a[i] > b[i])); then
      echo 1
      return 0
    fi
  done
  echo 0
}
# The version a package.json given on standard input names ("" for none).
package_version() { sed -n 's/^  "version": "\(.*\)",$/\1/p'; }

cd "$(git rev-parse --show-toplevel)"

echo "== The release v$version, from GitHub"
# The tag as GitHub has it; a local tag of that name pointing elsewhere is refused by git. The
# Release workflow makes the tag only by publishing its release, once every check passed.
git fetch --quiet origin main "refs/tags/v$version:refs/tags/v$version" ||
  die "could not fetch v$version from origin: is it a published release? (or a local tag v$version differs)"
commit=$(git rev-parse "v$version^{commit}")
git merge-base --is-ancestor "$commit" origin/main || die "v$version ($commit) is not on GitHub's main"
[[ $(git show "$commit:package.json" | package_version) == "$version" ]] ||
  die "v$version's package.json is not version $version"
git log -1 --format='   %H%n   %an, %ad%n   %s' --date=short "$commit"
rev=${commit:0:12}
release=$(date -u +%Y%m%d%H%M%S)-$rev
upload=.sattleme-mcp-upload # in the admin's home, removed at the end

# One SSH connection for every step (a single authentication).
ssh_opts=(-o ControlMaster=auto -o "ControlPath=~/.ssh/sattleme-mcp-%C" -o ControlPersist=120)
cleanup() { ssh "${ssh_opts[@]}" -O exit "$target" 2>/dev/null || true; }
trap cleanup EXIT
# The version the server runs ("" for none).
running_version() {
  local package status=0
  package=$(ssh "${ssh_opts[@]}" "$target" "cat /opt/sattleme-mcp/current/package.json 2>/dev/null || true") ||
    status=$?
  ((status == 0)) ||
    die "SSH to $target failed (its message above; docs/RELEASING.md, « When it is refused »):
- connection timed out or refused: the provider's firewall does not let this machine's current
  IPv4 address in on TCP 22;
- permission denied (publickey): SSH offered no key that the admin account takes. SSH offers
  ~/.ssh/id_ed25519 and its other default names only: name your key's file as an
  IdentityFile of this host in ~/.ssh/config (« Your SSH key »)"
  package_version <<<"$package"
}

# The version running, if any: never an older one, unless asked.
running=$(running_version)
if [[ $running =~ $VERSION_RE ]]; then
  echo
  echo "== On the server: v$running"
  if (($(version_order "$version" "$running") < 0)) && ((!allow_downgrade)); then
    die "v$version is older than v$running, which runs on the server: to go back on purpose, add
--allow-downgrade (docs/RELEASING.md, « Going back »)"
  fi
  if git rev-parse -q --verify "refs/tags/v$running" >/dev/null && [[ $running != "$version" ]]; then
    echo "   What changes (git diff v$running v$version to read it all):"
    git log --format='   %h %s' "v$running..$commit" || true
  fi
else
  echo
  echo "== On the server: no release yet"
fi

echo
echo "== Uploading v$version ($rev) to $target"
# shellcheck disable=SC2029 # $upload is expanded here on purpose, ~ on the server
git archive --format=tar "$commit" |
  ssh "${ssh_opts[@]}" "$target" "rm -rf ~/$upload && mkdir -p ~/$upload && tar -x -C ~/$upload"

echo "== Running the setup on the server (sudo)"
# (The odd expansion keeps bash 3.2, macOS's, happy with an empty array under `set -u`.)
remote_args=$(printf ' %q' --public-host "$host" --release-name "$release" ${setup_args[@]+"${setup_args[@]}"})
ssh -t "${ssh_opts[@]}" "$target" "sudo bash ~/$upload/deploy/server-setup.sh$remote_args; status=\$?; rm -rf ~/$upload; exit \$status"
# The release in place: the setup puts the previous one back when the new one is not healthy.
[[ $(running_version) == "$version" ]] || die "the server does not run v$version (the setup's message above)"

echo "== Checking https://$host from here"
health=""
for _ in $(seq 24); do
  if health=$(curl -fsS --max-time 10 "https://$host/health"); then
    echo "$health"
    break
  fi
  health=""
  sleep 5
done
[[ $health == '{"ok":true}' ]] || die "https://$host does not answer from here: check the DNS record
and that the provider's firewall lets in TCP 80 and 443 (and UDP 443)"

if ((smoke)); then
  echo "== End-to-end checks (the release's scripts/smoke.mjs)"
  smoke_dir=$(mktemp -d)
  git show "$commit:scripts/smoke.mjs" >"$smoke_dir/smoke.mjs"
  status=0
  node "$smoke_dir/smoke.mjs" "https://$host" || status=$?
  rm -rf "$smoke_dir"
  ((status == 0)) || die "scripts/smoke.mjs found the server failing (above)"
fi
echo "Deployed v$version ($rev) to https://$host"
