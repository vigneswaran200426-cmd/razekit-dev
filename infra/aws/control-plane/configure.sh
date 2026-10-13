#!/bin/bash
# Writes the control plane's secrets and starts the three services.
# Run once from Session Manager:  sudo bash /opt/razekit-dev/infra/aws/control-plane/configure.sh
#
# Values are read without echo and written straight into the 0600 env files;
# nothing is printed, logged or kept in shell history.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }

set_var() { # file key value
  local file="$1" key="$2" value="$3" tmp
  tmp=$(mktemp)
  grep -v "^${key}=" "$file" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

read -r -s -p "DEV Neon connection string (RAZEKIT_DATABASE_URL): " DB; echo
[ -n "$DB" ] || { echo "Required"; exit 1; }
read -r -s -p "GitHub fine-grained token for System A (Enter to skip): " GH; echo
read -r -p "ADMIN_EMAIL for alerts (Enter to keep current): " MAIL

for name in builder auditor gateway; do set_var "/etc/razekit/$name.env" RAZEKIT_DATABASE_URL "$DB"; done
[ -n "$GH" ] && set_var /etc/razekit/builder.env RAZEKIT_BUILDER_GITHUB_TOKEN "$GH"
[ -n "$MAIL" ] && set_var /etc/razekit/auditor.env ADMIN_EMAIL "$MAIL"
for name in builder auditor gateway; do chown "razekit-$name:razekit-$name" "/etc/razekit/$name.env"; chmod 0600 "/etc/razekit/$name.env"; done
unset DB GH

systemctl restart razekit-builder razekit-auditor razekit-gateway
sleep 5
systemctl --no-pager --lines=0 status razekit-builder razekit-auditor razekit-gateway || true
echo "Done. Heartbeats appear on /admin/24-7 within ~30 seconds."
