#!/bin/sh
# Install the Remora CLI (`remora`) on macOS or Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/Aero123421/dsh-remora/main/scripts/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --version v0.1.0 --dir /usr/local/bin
#
# Downloads remora-<os>-<arch> and SHA256SUMS from GitHub Releases (latest by
# default), verifies the SHA-256, and installs to ~/.local/bin (or
# $REMORA_INSTALL_DIR). Nothing is installed when verification fails.
#
# Environment: REMORA_VERSION, REMORA_INSTALL_DIR, REMORA_REPO,
# REMORA_DOWNLOAD_BASE (a mirror serving <base>/<asset> and <base>/SHA256SUMS).
set -eu

REPO="${REMORA_REPO:-Aero123421/dsh-remora}"
VERSION="${REMORA_VERSION:-latest}"
INSTALL_DIR="${REMORA_INSTALL_DIR:-${HOME}/.local/bin}"

say() { printf '%s\n' "$*" >&2; }
die() { say "remora install: $*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION="$2"; shift 2 ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; INSTALL_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,13p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "unsupported OS: $(uname -s) (use install.ps1 on Windows)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac
# An x64 shell under Rosetta still gets the native arm64 binary.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
# Must match RELEASE_ASSETS.cli in packages/protocol/src/endpoints.ts.
asset="remora-${os}-${arch}"

if [ -n "${REMORA_DOWNLOAD_BASE:-}" ]; then
  base="${REMORA_DOWNLOAD_BASE%/}"
elif [ "$VERSION" = latest ]; then
  base="https://github.com/${REPO}/releases/latest/download"
else
  case "$VERSION" in v*) tag="$VERSION" ;; *) tag="v$VERSION" ;; esac
  base="https://github.com/${REPO}/releases/download/${tag}"
fi

download() { # url file
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1"
  else
    die "curl or wget is required"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "sha256sum or shasum is required"
  fi
}

mkdir -p "$INSTALL_DIR"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/remora-install.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading ${asset} (${VERSION}) ..."
download "${base}/SHA256SUMS" "$tmp/SHA256SUMS" || die "could not download ${base}/SHA256SUMS"
download "${base}/${asset}" "$tmp/${asset}" || die "could not download ${base}/${asset}"

expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print tolower($1); exit }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || die "SHA256SUMS has no entry for ${asset}"
actual="$(sha256 "$tmp/${asset}")"
[ "$expected" = "$actual" ] || die "checksum mismatch for ${asset} (expected ${expected}, got ${actual}); nothing was installed"
say "SHA-256 verified: ${actual}"

chmod 755 "$tmp/${asset}"
# Stage next to the target, then rename: atomic, and safe while remora runs.
cp "$tmp/${asset}" "${INSTALL_DIR}/.remora.new.$$"
mv -f "${INSTALL_DIR}/.remora.new.$$" "${INSTALL_DIR}/remora"
say "Installed: ${INSTALL_DIR}/remora ($("${INSTALL_DIR}/remora" --version 2>/dev/null || echo '?'))"

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    say ""
    say "${INSTALL_DIR} is not on your PATH. Add it, for example:"
    say "  echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ~/.profile   # or ~/.zshrc / ~/.bashrc"
    ;;
esac
say "Next: remora login https://<your-hub>"
