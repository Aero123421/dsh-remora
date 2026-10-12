#!/bin/sh
# Install the Remora CLI (`remora`) on macOS or Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/Aero123421/dsh-remora/main/scripts/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --version v0.2.0 --dir /usr/local/bin --form binary
#
# Two forms, both verified against SHA256SUMS before anything is installed:
#   node    remora.mjs (~135 KB) plus a small `remora` launcher, used when
#           Node.js 22.19 or later is available. The default whenever possible.
#   binary  the standalone remora-<os>-<arch> executable (~100 MB, embeds Node.js),
#           used when Node.js is missing or too old, or with --form binary.
# Both go to ~/.local/bin (or $REMORA_INSTALL_DIR). `remora self-update`
# keeps whichever form is installed.
#
# Environment: REMORA_VERSION, REMORA_INSTALL_DIR, REMORA_FORM (auto|node|binary),
# REMORA_NODE (the node to use), REMORA_REPO, REMORA_DOWNLOAD_BASE (a mirror
# serving <base>/<asset> and <base>/SHA256SUMS).
set -eu

REPO="${REMORA_REPO:-Aero123421/dsh-remora}"
VERSION="${REMORA_VERSION:-latest}"
INSTALL_DIR="${REMORA_INSTALL_DIR:-${HOME}/.local/bin}"
FORM="${REMORA_FORM:-auto}"
# Must match RELEASE_ASSETS in packages/protocol/src/endpoints.ts.
SCRIPT_ASSET="remora.mjs"
SUMS_ASSET="SHA256SUMS"

say() { printf '%s\n' "$*" >&2; }
die() { say "remora install: $*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION="$2"; shift 2 ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; INSTALL_DIR="$2"; shift 2 ;;
    --form) [ $# -ge 2 ] || die "--form needs a value"; FORM="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
case "$FORM" in auto|node|binary) ;; *) die "--form must be auto, node or binary" ;; esac

# --- which form -------------------------------------------------------------
# Prints the node to use when it is 22.19 or later; nothing otherwise.
find_node() {
  candidate="${REMORA_NODE:-$(command -v node 2>/dev/null || true)}"
  [ -n "$candidate" ] && [ -x "$candidate" ] || return 0
  version="$("$candidate" -p 'process.versions.node' 2>/dev/null || true)"
  major="${version%%.*}"
  rest="${version#*.}"
  minor="${rest%%.*}"
  case "$major$minor" in ''|*[!0-9]*) return 0 ;; esac
  if [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 19 ]; }; then
    printf '%s\n' "$candidate"
  fi
}

node_bin=""
if [ "$FORM" != binary ]; then
  node_bin="$(find_node)"
  if [ -z "$node_bin" ]; then
    [ "$FORM" = node ] && die "--form node needs Node.js 22.19 or later (set REMORA_NODE to its path)"
    FORM=binary
    say "Node.js 22.19 or later was not found: installing the standalone binary."
  else
    FORM=node
  fi
fi

binary_asset() {
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) die "no standalone binary for $(uname -s); install Node.js 22.19+ and use --form node (on Windows use install.ps1)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "no standalone binary for this CPU ($(uname -m)); install Node.js 22.19+ and use --form node" ;;
  esac
  # An x64 shell under Rosetta still gets the native arm64 binary.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
  # Must match RELEASE_ASSETS.cli in packages/protocol/src/endpoints.ts.
  printf 'remora-%s-%s\n' "$os" "$arch"
}

# --- download and verify ----------------------------------------------------
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

download "${base}/${SUMS_ASSET}" "$tmp/${SUMS_ASSET}" || die "could not download ${base}/${SUMS_ASSET}"

checksum_of() { # asset
  awk -v name="$1" '$2 == name || $2 == "*" name { print tolower($1); exit }' "$tmp/${SUMS_ASSET}"
}

# Releases before remora.mjs existed only have binaries.
if [ "$FORM" = node ] && [ -z "$(checksum_of "$SCRIPT_ASSET")" ]; then
  say "This release has no ${SCRIPT_ASSET}: installing the standalone binary instead."
  FORM=binary
fi
if [ "$FORM" = node ]; then asset="$SCRIPT_ASSET"; else asset="$(binary_asset)"; fi

say "Downloading ${asset} (${VERSION}) ..."
download "${base}/${asset}" "$tmp/${asset}" || die "could not download ${base}/${asset}"

expected="$(checksum_of "$asset")"
[ -n "$expected" ] || die "${SUMS_ASSET} has no entry for ${asset}"
actual="$(sha256 "$tmp/${asset}")"
[ "$expected" = "$actual" ] || die "checksum mismatch for ${asset} (expected ${expected}, got ${actual}); nothing was installed"
say "SHA-256 verified: ${actual}"

# --- install: stage next to the target, then rename (atomic, safe while remora runs)
put() { # source name
  cp "$1" "${INSTALL_DIR}/.$2.new.$$"
  chmod 755 "${INSTALL_DIR}/.$2.new.$$"
  mv -f "${INSTALL_DIR}/.$2.new.$$" "${INSTALL_DIR}/$2"
}
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

if [ "$FORM" = node ]; then
  script_path="$(cd "$INSTALL_DIR" && pwd)/${SCRIPT_ASSET}"
  cat > "$tmp/launcher" <<EOF
#!/bin/sh
# remora launcher, written by Remora's install.sh. Runs remora.mjs with Node.js
# 22.19 or later: \$REMORA_NODE, else the node found at install time, else the
# node on PATH. Reinstall with REMORA_FORM=binary for the standalone build.
node_bin="\${REMORA_NODE:-}"
if [ -z "\$node_bin" ]; then
  if [ -x $(quote "$node_bin") ]; then node_bin=$(quote "$node_bin"); else node_bin="\$(command -v node 2>/dev/null || true)"; fi
fi
if [ -z "\$node_bin" ]; then
  echo "remora: Node.js が見つかりません。REMORA_NODE で node を指定するか、REMORA_FORM=binary でインストールし直してください。" >&2
  exit 127
fi
exec "\$node_bin" $(quote "$script_path") "\$@"
EOF
  put "$tmp/${asset}" "$SCRIPT_ASSET"
  put "$tmp/launcher" remora
  say "Installed: ${INSTALL_DIR}/remora (Node.js form, $("${INSTALL_DIR}/remora" --version 2>/dev/null || echo '?'), using ${node_bin})"
else
  put "$tmp/${asset}" remora
  rm -f "${INSTALL_DIR}/${SCRIPT_ASSET}"
  say "Installed: ${INSTALL_DIR}/remora (standalone binary, $("${INSTALL_DIR}/remora" --version 2>/dev/null || echo '?'))"
fi

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    say ""
    say "${INSTALL_DIR} is not on your PATH. Add it, for example:"
    say "  echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ~/.profile   # or ~/.zshrc / ~/.bashrc"
    ;;
esac
say "Next: remora login https://<your-hub>"
