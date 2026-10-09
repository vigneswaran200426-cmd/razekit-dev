#!/bin/bash
# RazeKit DEV control plane — EC2 user data (Amazon Linux 2023, x86_64).
#
# One small CPU instance that runs, as three separate systemd services under
# three separate Unix users:
#   razekit-builder   System A — RazeKit DEV Builder
#   razekit-auditor   System B — Runtime Operations and Auditor
#   razekit-gateway   the shared inference gateway (and GPU start/stop)
#
# Each has its own environment file (0600, owned by that user), its own
# workspace and its own log. Secrets are written to the env files by an
# operator after boot (see README.md), never baked into user data.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/vigneswaran200426-cmd/razekit-dev.git}"
REPO_REF="${REPO_REF:-main}"
APP=/opt/razekit-dev
STATE=/var/lib/razekit

dnf -y update
dnf -y install git docker python3 python3-pip iptables-nft tar gzip
# Node.js 22 LTS from the distribution.
dnf -y install nodejs22 nodejs22-npm || dnf -y install nodejs npm
command -v node || ln -s "$(command -v node-22)" /usr/local/bin/node
command -v npm || ln -s "$(command -v npm-22)" /usr/local/bin/npm

systemctl enable --now docker

for user in razekit-builder razekit-auditor razekit-gateway; do
  id "$user" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$STATE/${user#razekit-}" --shell /sbin/nologin "$user"
  install -d -m 0700 -o "$user" -g "$user" "$STATE/${user#razekit-}" "$STATE/${user#razekit-}/workspaces" "$STATE/${user#razekit-}/logs"
done
# The builder runs builds and browser checks in restricted containers.
usermod -aG docker razekit-builder

git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$APP"
cd "$APP"
npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
chmod -R a+rX "$APP"

# Browser sandbox image: Playwright's Chromium in a container with no host
# network access beyond the egress rules below.
docker pull mcr.microsoft.com/playwright:v1.55.1-noble || true

install -d -m 0755 /etc/razekit
for name in builder auditor gateway; do
  f="/etc/razekit/$name.env"
  [ -f "$f" ] || install -m 0600 -o "razekit-$name" -g "razekit-$name" "$APP/infra/aws/control-plane/env/$name.env.example" "$f"
done

# ── Egress restrictions ─────────────────────────────────────────────────────
# Instance metadata (and so the instance role) is reachable only by the
# gateway user; the builder, the auditor and every container are refused.
iptables -I OUTPUT -d 169.254.169.254 -m owner --uid-owner razekit-builder -j REJECT
iptables -I OUTPUT -d 169.254.169.254 -m owner --uid-owner razekit-auditor -j REJECT
iptables -I DOCKER-USER -d 169.254.169.254 -j REJECT || true
# Containers may not reach private networks (VPC, other instances, the model
# server); they get the public internet only.
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16; do
  iptables -I DOCKER-USER -d "$net" -j REJECT || true
done
dnf -y install iptables-services && iptables-save > /etc/sysconfig/iptables && systemctl enable iptables

install -m 0644 "$APP"/infra/aws/control-plane/systemd/razekit-*.service /etc/systemd/system/
systemctl daemon-reload
# Services start once their env files have been filled in (README step 4).
systemctl enable razekit-builder razekit-auditor razekit-gateway
