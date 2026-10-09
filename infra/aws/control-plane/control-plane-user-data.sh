#!/bin/bash
# RazeKit DEV control plane — EC2 user data (Ubuntu 24.04 LTS, x86_64).
#
# One small CPU instance that runs, as three separate systemd services under
# three separate Unix users:
#   razekit-builder   System A — RazeKit DEV Builder
#   razekit-auditor   System B — Runtime Operations and Auditor
#   razekit-gateway   the shared inference gateway (and GPU start/stop)
#
# Each has its own environment file (0600, owned by that user), its own
# workspace and its own log. Secrets are written by the operator after boot
# with configure.sh (Session Manager), never baked into user data.
#
# System A is deliberately NOT in the docker group: that group is root on the
# host. Builds run as its own hardened user (see the systemd unit); a
# container sandbox needs rootless Docker, which is a later step.
set -uo pipefail
exec > >(tee -a /var/log/razekit-bootstrap.log) 2>&1

REPO_URL="${REPO_URL:-https://github.com/vigneswaran200426-cmd/razekit-dev.git}"
REPO_REF="${REPO_REF:-main}"
NODE_VERSION="${NODE_VERSION:-v22.12.0}"
APP=/opt/razekit-dev
STATE=/var/lib/razekit
export DEBIAN_FRONTEND=noninteractive

echo "== razekit bootstrap $(date -u +%FT%TZ) ref=$REPO_REF"

# 2 GB of swap: a t3.small has 2 GB of memory and the test suite plus
# Chromium can briefly exceed it.
if [ ! -f /swapfile ]; then fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi

apt-get update -y
apt-get install -y git python3 python3-pip ca-certificates curl xz-utils iptables-persistent

# Node.js 22 LTS from nodejs.org, checksum-verified.
cd /tmp
curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz"
curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
grep " node-${NODE_VERSION}-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c - || { echo "Node checksum mismatch"; exit 1; }
tar -xJf "node-${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local --strip-components=1
node --version && npm --version

for user in razekit-builder razekit-auditor razekit-gateway; do
  name="${user#razekit-}"
  id "$user" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$STATE/$name" --shell /usr/sbin/nologin "$user"
  install -d -m 0700 -o "$user" -g "$user" "$STATE/$name" "$STATE/$name/workspaces" "$STATE/$name/logs"
done

rm -rf "$APP"
git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$APP"
cd "$APP"
npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
# Chromium for the browser tool, in a shared read-only location.
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
npx --yes playwright@1.55.1 install --with-deps chromium || echo "WARN: Playwright Chromium install failed"
chmod -R a+rX "$APP" /opt/ms-playwright 2>/dev/null || true

install -d -m 0755 /etc/razekit
for name in builder auditor gateway; do
  f="/etc/razekit/$name.env"
  [ -f "$f" ] || install -m 0600 -o "razekit-$name" -g "razekit-$name" "$APP/infra/aws/control-plane/env/$name.env.example" "$f"
done
CHROME=$(ls -d /opt/ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | head -1)
if [ -n "$CHROME" ] && ! grep -q '^RAZEKIT_BROWSER_EXECUTABLE=' /etc/razekit/builder.env; then echo "RAZEKIT_BROWSER_EXECUTABLE=$CHROME" >> /etc/razekit/builder.env; fi
# The administrator address is not a secret; it is passed in at launch.
if [ -n "${ADMIN_EMAIL:-}" ]; then sed -i "s|^ADMIN_EMAIL=.*|ADMIN_EMAIL=${ADMIN_EMAIL}|" /etc/razekit/auditor.env; fi

# ── Egress restrictions ─────────────────────────────────────────────────────
# Instance metadata (and so the instance role) is reachable only by the
# gateway user; the builder and the auditor are refused.
iptables -I OUTPUT -d 169.254.169.254 -m owner --uid-owner razekit-builder -j REJECT
iptables -I OUTPUT -d 169.254.169.254 -m owner --uid-owner razekit-auditor -j REJECT
# The builder (which runs model-written code and the browser) may not reach
# private networks either: no VPC neighbours, no model server.
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
  iptables -I OUTPUT -d "$net" -m owner --uid-owner razekit-builder -j REJECT
done
netfilter-persistent save || true

install -m 0644 "$APP"/infra/aws/control-plane/systemd/razekit-*.service /etc/systemd/system/
systemctl daemon-reload
# Services are enabled; they start after configure.sh has written the secrets.
systemctl enable razekit-builder razekit-auditor razekit-gateway
echo "== razekit bootstrap finished $(date -u +%FT%TZ). Next: sudo bash $APP/infra/aws/control-plane/configure.sh"
