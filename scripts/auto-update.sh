#!/bin/bash
# ZeroLLM Auto-Updater for Linux / macOS
# Periodically checks for new releases on GitHub and pulls them automatically.

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR" || exit 1

echo "=========================================="
echo "⚡ ZeroLLM Extension Auto-Updater Active"
echo "📁 Directory: $REPO_DIR"
echo "=========================================="

while true; do
  git fetch origin main --quiet 2>/dev/null
  LOCAL_HASH=$(git rev-parse HEAD 2>/dev/null)
  REMOTE_HASH=$(git rev-parse origin/main 2>/dev/null)

  if [ -n "$LOCAL_HASH" ] && [ -n "$REMOTE_HASH" ] && [ "$LOCAL_HASH" != "$REMOTE_HASH" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 🚀 Update baru ditemukan di GitHub! Memperbarui..."
    git pull origin main --quiet
    NEW_VER=$(node -e "try { console.log(JSON.parse(require('fs').readFileSync('manifest.json')).version); } catch(e) {}" 2>/dev/null)
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ Berhasil diperbarui ke versi v$NEW_VER"
  fi

  sleep 60
done
