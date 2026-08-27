#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_NAME="slide-helper.service"
SYSTEM_UNIT="/etc/systemd/system/${UNIT_NAME}"
USER_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
USER_UNIT="${USER_UNIT_DIR}/${UNIT_NAME}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--system | --user]

Install Slideact to start automatically on boot.

  --system   Install a system-wide systemd unit (requires sudo). Recommended for servers.
  --user     Install a user systemd unit (no sudo). Requires 'loginctl enable-linger'
             for boot without login.

Default: --system when run as root, otherwise --user.
EOF
}

mode=""
if [[ "${1:-}" == "--system" ]]; then
  mode="system"
elif [[ "${1:-}" == "--user" ]]; then
  mode="user"
elif [[ "$(id -u)" -eq 0 ]]; then
  mode="system"
else
  mode="user"
fi

chmod +x "${ROOT}/scripts/compose-up.sh"

if [[ "$mode" == "system" ]]; then
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "Installing system unit — sudo required."
    exec sudo "$0" --system
  fi

  sed "s|/home/moriss/slide-helper|${ROOT}|g" \
    "${ROOT}/infra/systemd/slide-helper.service" >"${SYSTEM_UNIT}"

  systemctl daemon-reload
  systemctl enable "${UNIT_NAME}"
  systemctl start "${UNIT_NAME}"

  echo "Installed ${SYSTEM_UNIT}"
  systemctl status "${UNIT_NAME}" --no-pager || true
else
  mkdir -p "${USER_UNIT_DIR}"
  sed "s|/home/moriss/slide-helper|${ROOT}|g" \
    "${ROOT}/infra/systemd/slide-helper-user.service" >"${USER_UNIT}"

  systemctl --user daemon-reload
  systemctl --user enable "${UNIT_NAME}"
  systemctl --user start "${UNIT_NAME}"

  echo "Installed ${USER_UNIT}"
  systemctl --user status "${UNIT_NAME}" --no-pager || true

  if [[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)" != "yes" ]]; then
    cat <<EOF

Note: user services only start at boot after login unless linger is enabled.
Run once (requires sudo):

  sudo loginctl enable-linger $(id -un)

Or install the system unit instead:

  sudo ${ROOT}/scripts/install-autostart.sh --system
EOF
  fi
fi
