#!/usr/bin/env bash
# Prepares a Debian 12/13 or Ubuntu 24.04/26.04 server for the hosted assistant and (re)starts it
# from this copy of the repository. Run as root through sudo by deploy/deploy.sh; running it again
# is safe: every step converges to the same state, so the same command installs and updates.
#
#   sudo bash deploy/server-setup.sh --public-host mcp.example.com [--release-name <name>]
#                                    [--skip-dns-check]
#
# What it sets up, and nothing else:
#   - security updates installed every day, with a reboot at 04:30 when one needs it;
#   - SSH by key only, no root login (refused if the admin account has no key: no lock-out);
#   - Docker from Docker's own apt repository (signing key checked against its fingerprint);
#   - the assistant and Caddy (docker-compose.yml), from a release kept in /opt/sattleme-mcp/releases;
#   - its secret, MCP_SEAL_SECRET, made here once (in /etc/sattleme-mcp/mcp.env, root only): it never
#     leaves this server. Nothing else is stored, so there is nothing to back up: a new server makes
#     a new secret, and every merchant connects their AI app again;
#   - a watchdog that restarts the assistant if its health check fails (watchdog.sh);
#   - `sattleme-mcp`, a shortcut for docker compose on this project: `sudo sattleme-mcp ps`.
# The hosting provider's firewall is set by hand: TCP 80 and 443 (and UDP 443, HTTP/3) from
# everywhere, TCP 22 from your own IP address only.
set -euo pipefail
shopt -s nullglob

readonly BASE=/opt/sattleme-mcp
readonly ETC=/etc/sattleme-mcp
readonly ENV_FILE=$ETC/mcp.env
readonly WRAPPER=/usr/local/sbin/sattleme-mcp
# Docker's apt signing key (docs.docker.com/engine/install), the same for Debian and Ubuntu.
readonly DOCKER_KEY_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

log() { printf '\n== %s\n' "$*"; }
die() {
  printf '\nerror: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}

PUBLIC_HOST=""
RELEASE_NAME=""
SKIP_DNS_CHECK=0
value() { (($# >= 2)) || die "$1 needs a value"; }
while (($#)); do
  case "$1" in
    --public-host) value "$@" && PUBLIC_HOST=$2 && shift ;;
    --release-name) value "$@" && RELEASE_NAME=$2 && shift ;;
    --skip-dns-check) SKIP_DNS_CHECK=1 ;;
    -h | --help) usage ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

# --- checks before changing anything --------------------------------------------------------------

[[ $EUID -eq 0 ]] || die "run as root (sudo bash $0 …)"
[[ -n $PUBLIC_HOST ]] || die "--public-host is required (see --help)"
# A DNS name; checked here because the value is written into files and commands below.
[[ $PUBLIC_HOST =~ ^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$ && $PUBLIC_HOST != *..* ]] ||
  die "--public-host must be a lower-case DNS name, without scheme, port or path: $PUBLIC_HOST"
if [[ -z $RELEASE_NAME ]]; then RELEASE_NAME=$(date -u +%Y%m%d%H%M%S)-manual; fi
[[ $RELEASE_NAME =~ ^[0-9]{14}-[0-9a-z]{1,40}$ ]] || die "bad --release-name: $RELEASE_NAME"

SOURCE=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
[[ -f $SOURCE/docker-compose.yml && -f $SOURCE/Caddyfile && -f $SOURCE/deploy/watchdog.sh ]] ||
  die "$SOURCE is not a copy of the mcp-server repository"
# Caddy serves both (Caddyfile, SECURITY.md); Docker would mount a missing one as an empty directory.
for file in security.txt pgp-key.txt; do
  [[ -f $SOURCE/.well-known/$file && -s $SOURCE/.well-known/$file ]] ||
    die "$SOURCE/.well-known/$file is missing or empty"
done

# shellcheck source=/dev/null
. /etc/os-release
case "$ID:$VERSION_ID" in
  debian:12 | debian:13 | ubuntu:24.04 | ubuntu:26.04) ;;
  *) die "unsupported system $PRETTY_NAME: use Debian 12/13 or Ubuntu 24.04/26.04" ;;
esac

# The admin account (the one sudo was called from) must log in with a key before passwords go.
ADMIN=${SUDO_USER:-}
[[ -n $ADMIN && $ADMIN != root ]] || die "run through sudo from the admin account (debian, ubuntu…)"
ADMIN_HOME=$(getent passwd "$ADMIN" | cut -d: -f6)
ssh-keygen -l -f "$ADMIN_HOME/.ssh/authorized_keys" >/dev/null 2>&1 ||
  die "no valid key in $ADMIN_HOME/.ssh/authorized_keys: SSH by key only would lock you out"

if [[ -f $ENV_FILE ]]; then
  current_host=$(sed -n 's/^PUBLIC_HOST=//p' "$ENV_FILE")
  [[ $current_host == "$PUBLIC_HOST" ]] ||
    die "this server already serves $current_host. AI apps registered their client and hold tokens
for that name: to change it on purpose, edit $ENV_FILE first, knowing every merchant then connects
again."
  # Never made again here: a new secret ends every client and token (docs/HOSTING.md).
  [[ $(sed -n 's/^MCP_SEAL_SECRET=//p' "$ENV_FILE") =~ ^[A-Za-z0-9_-]{43,}$ ]] ||
    die "$ENV_FILE has no valid MCP_SEAL_SECRET (43 base64url characters or more): fix it by hand.
A new one ends every connection: every merchant then connects again."
fi

if ((!SKIP_DNS_CHECK)); then
  # Caddy needs PUBLIC_HOST to reach this machine to get its certificate: check it before starting,
  # rather than burning the certificate authority's rate limit on a wrong DNS record.
  mapfile -t local_ips < <(ip -o addr show scope global | awk '{print $4}' | cut -d/ -f1)
  mapfile -t a_records < <(getent ahostsv4 "$PUBLIC_HOST" | awk '{print $1}' | sort -u)
  mapfile -t aaaa_records < <(getent ahostsv6 "$PUBLIC_HOST" | awk '$1 !~ /^::ffff:/ {print $1}' | sort -u)
  ((${#a_records[@]})) || die "$PUBLIC_HOST has no A record yet: point it to this server's IPv4 address"
  for ip in "${a_records[@]}" "${aaaa_records[@]}"; do
    [[ " ${local_ips[*]} " == *" $ip "* ]] ||
      die "$PUBLIC_HOST points to $ip, which is not an address of this server (${local_ips[*]}).
Fix the DNS record (an AAAA record only if this server has that IPv6 address), wait for it to
propagate, then run again. If this server sits behind NAT, use --skip-dns-check."
  done
fi

# One run at a time.
exec 9>/run/sattleme-mcp-deploy.lock
flock -n 9 || die "another deployment is running on this server: run again once it is over"

# --- system ---------------------------------------------------------------------------------------

export DEBIAN_FRONTEND=noninteractive
# Waits for the apt lock: on a fresh server, the image's own unattended-upgrades may hold it.
apt_get() {
  apt-get -q -y -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef \
    -o Dpkg::Options::=--force-confold "$@"
}

log "System packages"
apt_get update
apt_get upgrade
apt_get install ca-certificates curl gnupg iproute2 openssh-server unattended-upgrades

log "Clock"
# TLS certificates, OAuth tokens' expiry and invoices' dates need a correct clock.
if [[ $(timedatectl show -p NTP --value 2>/dev/null || true) != yes ]]; then
  dpkg -s chrony >/dev/null 2>&1 || dpkg -s systemd-timesyncd >/dev/null 2>&1 || apt_get install systemd-timesyncd
  timedatectl set-ntp true 2>/dev/null || true
fi

log "Automatic security updates"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
cat >/etc/apt/apt.conf.d/52sattleme-mcp <<'EOF'
// sattleme-mcp: security updates install every day (unattended-upgrades' default origins); when one
// needs a reboot (a new kernel), it happens at 04:30 UTC, and the assistant comes back with Docker.
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF

log "SSH: keys only, no root login"
# sshd keeps the first value it reads and Debian/Ubuntu read sshd_config.d/*.conf first, in name
# order: "10-" comes before the images' own files (50-cloud-init.conf may allow passwords).
cat >/etc/ssh/sshd_config.d/10-sattleme-mcp.conf <<EOF
# Written by mcp-server's deploy/server-setup.sh.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
if ! sshd -t; then
  rm -f /etc/ssh/sshd_config.d/10-sattleme-mcp.conf
  die "sshd refused the configuration; nothing was changed"
fi
# Read whole, then searched: `sshd -T | grep -q` fails under pipefail once sshd's answer passes
# 4 KB (grep stops at its line, sshd's next write gets SIGPIPE).
effective=$(sshd -T -C user="$ADMIN",host=localhost,addr=127.0.0.1 2>/dev/null)
if ! grep -qx 'passwordauthentication no' <<<"$effective" || ! grep -qx 'permitrootlogin no' <<<"$effective"; then
  die "sshd does not apply /etc/ssh/sshd_config.d/10-sattleme-mcp.conf (no Include line in sshd_config?)"
fi
systemctl try-reload-or-restart ssh 2>/dev/null || systemctl try-reload-or-restart sshd

log "Docker"
if ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  key=$(mktemp)
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o "$key"
  gnupg_home=$(mktemp -d)
  fpr=$(GNUPGHOME=$gnupg_home gpg --show-keys --with-colons "$key" | awk -F: '$1 == "fpr" {print $10; exit}')
  rm -rf "$gnupg_home"
  [[ $fpr == "$DOCKER_KEY_FPR" ]] || die "Docker's signing key has fingerprint '$fpr', expected $DOCKER_KEY_FPR"
  install -m 0644 "$key" /etc/apt/keyrings/docker.asc
  rm -f "$key"
  cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt_get update
  apt_get install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
# Bounded container logs (Docker keeps them forever by default), and containers that keep running
# while the Docker daemon itself restarts (an upgrade of Docker).
daemon_json='{
  "log-driver": "local",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}'
if [[ ! -f /etc/docker/daemon.json || $(</etc/docker/daemon.json) != "$daemon_json" ]]; then
  install -d -m 0755 /etc/docker
  printf '%s\n' "$daemon_json" >/etc/docker/daemon.json
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null

# --- the assistant --------------------------------------------------------------------------------

log "Configuration ($ENV_FILE)"
install -d -m 0700 "$ETC"
if [[ ! -f $ENV_FILE ]]; then
  # 32 random bytes from the kernel, base64url (src/http.ts): made here, never shown nor copied.
  secret=$(head -c 32 /dev/urandom | base64 -w0 | tr '+/' '-_' | tr -d '=')
  [[ $secret =~ ^[A-Za-z0-9_-]{43}$ ]] || die "could not make the secret"
  (
    umask 077
    cat >"$ENV_FILE.tmp" <<EOF
# The hosted assistant's settings (docs/HOSTING.md, Configuration). Root only: it holds the secret.
# PUBLIC_HOST: AI apps register their client and get tokens for it.
PUBLIC_HOST=$PUBLIC_HOST
# Seals clients, codes and tokens. Never shown, never copied off this server. Changing it ends every
# connection: every merchant connects their AI app again.
MCP_SEAL_SECRET=$secret
# MCP_TIME_ZONE=Europe/Zurich
# MCP_LANGUAGE=fr
# MCP_ALLOWED_REDIRECTS=
EOF
  )
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  unset secret
fi
chown root:root "$ETC" "$ENV_FILE"
chmod 0700 "$ETC"
chmod 0600 "$ENV_FILE"

log "Release $RELEASE_NAME"
release=$BASE/releases/$RELEASE_NAME
install -d -m 0755 "$BASE/releases"
if [[ $SOURCE != "$release" ]]; then
  rm -rf "$release.tmp"
  cp -a "$SOURCE" "$release.tmp"
  chown -R root:root "$release.tmp"
  chmod -R go-w "$release.tmp"
  rm -rf "$release"
  mv "$release.tmp" "$release"
fi
cat >"$WRAPPER" <<EOF
#!/bin/sh
# docker compose for the hosted assistant: sudo sattleme-mcp ps | logs mcp | restart | …
exec docker compose -p sattleme-mcp --env-file $ENV_FILE -f $BASE/current/docker-compose.yml "\$@"
EOF
chmod 0755 "$WRAPPER"
# The release running until now, if any (-e: empty when there is none, or the link is broken).
previous=$(readlink -e "$BASE/current" 2>/dev/null || true)
ln -sfn "$release" "$BASE/current.new"
mv -T "$BASE/current.new" "$BASE/current"

# Back to the release that ran before, if any. Its image is built again (from Docker's cache): the
# image's name is the project's, which the new release's build took over.
roll_back() {
  if [[ -n $previous && -d $previous && $previous != "$release" ]]; then
    ln -sfn "$previous" "$BASE/current.new" && mv -T "$BASE/current.new" "$BASE/current"
    "$WRAPPER" up -d --build --remove-orphans || true
    die "$1; back to $(basename "$previous")"
  fi
  die "$1"
}

log "Starting the assistant (image build, then Caddy and the assistant)"
"$WRAPPER" up -d --build --remove-orphans || roll_back "the new release did not start"

status=""
for _ in $(seq 60); do
  id=$("$WRAPPER" ps -q mcp || true)
  status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$id" 2>/dev/null || true)
  [[ $status == healthy ]] && break
  sleep 3
done
[[ $status == healthy ]] ||
  roll_back "the new release is not healthy after 3 minutes (sudo sattleme-mcp logs mcp)"

# Caddy reads /opt/sattleme-mcp/current/Caddyfile, .well-known/security.txt and pgp-key.txt through
# bind mounts, which keep the files they found when the container started: `up` does not recreate
# Caddy for a new release, so a changed file would not apply. Compared with what Caddy actually
# sees, and recreated only when they differ (the HTTPS check below then runs on the new
# configuration).
if ! "$WRAPPER" exec -T caddy cat /etc/caddy/Caddyfile | cmp -s - "$release/Caddyfile" ||
  ! "$WRAPPER" exec -T caddy cat /srv/.well-known/security.txt |
  cmp -s - "$release/.well-known/security.txt" ||
  ! "$WRAPPER" exec -T caddy cat /srv/.well-known/pgp-key.txt |
  cmp -s - "$release/.well-known/pgp-key.txt"; then
  log "Caddyfile, security.txt or pgp-key.txt changed: recreating Caddy"
  "$WRAPPER" up -d --no-deps --force-recreate caddy
fi

log "HTTPS on $PUBLIC_HOST (Caddy obtains the certificate on first start)"
# Straight to this machine's port 443 (--resolve), never through a proxy the environment may set.
local_https() {
  curl -fsS --noproxy '*' --max-time 10 --resolve "$PUBLIC_HOST:443:127.0.0.1" "https://$PUBLIC_HOST$1"
}
health=""
for _ in $(seq 36); do
  health=$(local_https /health 2>/dev/null) && break
  health=""
  sleep 5
done
[[ $health == '{"ok":true}' ]] ||
  die "no answer on https://$PUBLIC_HOST after 3 minutes: sudo sattleme-mcp logs caddy"
# The server knows its own name (MCP_PUBLIC_URL): AI apps check the issuer against it.
# Read whole, then searched (a piped grep -q can fail under pipefail: SIGPIPE).
metadata=$(local_https /.well-known/oauth-authorization-server) || metadata=""
grep -qF "\"issuer\":\"https://$PUBLIC_HOST/\"" <<<"$metadata" ||
  die "https://$PUBLIC_HOST does not name itself as its OAuth issuer: sudo sattleme-mcp logs mcp"
# The security contact, as this release has it.
security_txt=$(local_https /.well-known/security.txt) || security_txt=""
[[ $security_txt == "$(cat "$release/.well-known/security.txt")" ]] ||
  die "https://$PUBLIC_HOST/.well-known/security.txt is not this release's: sudo sattleme-mcp logs caddy"

log "Watchdog"
cat >/etc/systemd/system/sattleme-mcp-watchdog.service <<EOF
[Unit]
Description=Restart the hosted assistant if its health check fails
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
ExecStart=$BASE/current/deploy/watchdog.sh
EOF
cat >/etc/systemd/system/sattleme-mcp-watchdog.timer <<'EOF'
[Unit]
Description=Check the hosted assistant's health every minute

[Timer]
OnBootSec=5min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now sattleme-mcp-watchdog.timer >/dev/null

log "Cleaning up"
# Keep the current release and the two before it (a quick way back), and drop unused images.
# Release names start with their UTC time: sorting them sorts by age.
mapfile -t old < <(find "$BASE/releases" -mindepth 1 -maxdepth 1 -type d ! -name '*.tmp' -printf '%f\n' |
  sort -r | grep -vxF "$RELEASE_NAME" | tail -n +3 | sed "s:^:$BASE/releases/:")
((${#old[@]})) && rm -rf -- "${old[@]}"
docker image prune -f >/dev/null

cat <<EOF

The hosted assistant is running: https://$PUBLIC_HOST
  release        $release
  settings       $ENV_FILE (root only: it holds MCP_SEAL_SECRET)
  commands       sudo sattleme-mcp ps | logs mcp | logs caddy
                 systemctl list-timers 'sattleme-mcp-*'
EOF
