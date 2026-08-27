#!/usr/bin/env bash
# One-command LivePage install. Works on macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/abhushansahu/livepage-exploration/main/scripts/install.sh | bash
set -euo pipefail

REPO="${LIVEPAGE_REPO:-https://github.com/abhushansahu/livepage-exploration.git}"
DEST="${LIVEPAGE_SRC:-$HOME/.livepage/src}"
BIN_DIR="${LIVEPAGE_BIN:-$HOME/.local/bin}"
BRANCH="${LIVEPAGE_BRANCH:-main}"

echo "Installing LivePage → $DEST"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required (for the local dashboard server)." >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")" "$BIN_DIR"

if [ -d "$DEST/.git" ]; then
  git -C "$DEST" fetch origin "$BRANCH"
  git -C "$DEST" checkout "$BRANCH"
  git -C "$DEST" pull --ff-only origin "$BRANCH"
else
  git clone --branch "$BRANCH" --depth 1 "$REPO" "$DEST"
fi

ln -sfn "$DEST/bin/livepage" "$BIN_DIR/livepage"
chmod +x "$DEST/bin/livepage"

if ! echo ":$PATH:" | grep -q ":$BIN_DIR:"; then
  echo
  echo "Add this to your shell rc (zsh: ~/.zshrc, bash: ~/.bashrc):"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
  echo
fi

echo "Installed."
echo "  command   $BIN_DIR/livepage"
echo
echo "Launching…"
"$BIN_DIR/livepage"
