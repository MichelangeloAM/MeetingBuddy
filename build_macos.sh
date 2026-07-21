#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "============================================"
echo "  Meeting Generator - macOS Build"
echo "============================================"
echo ""

echo "[1/5] Checking prerequisites..."
python3 --version
echo ""

echo "[2/5] Setting up virtual environment..."
if [ ! -d ".venv" ]; then
    python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install --upgrade pip --quiet
pip install -r requirements.txt
echo ""

echo "[3/5] Building app with PyInstaller..."
rm -rf dist build 2>/dev/null || true
pyinstaller --clean --noconfirm app_macos.spec
echo ""

APP_PATH="dist/MeetingGenerator.app"

if [ ! -d "$APP_PATH" ]; then
    echo "ERROR: PyInstaller did not produce $APP_PATH"
    exit 1
fi

CODESIGN_IDENTITY="${CODESIGN_IDENTITY:-}"

if [ -n "$CODESIGN_IDENTITY" ] && [ "$CODESIGN_IDENTITY" != "-" ]; then
    echo "[4/5] Code-signing bundle with $CODESIGN_IDENTITY..."
    codesign --deep --force --verify --verbose \
        --sign "$CODESIGN_IDENTITY" \
        --entitlements entitlements.plist \
        --options runtime \
        "$APP_PATH"
    codesign -d --entitlements - "$APP_PATH" || true

    if [ "${NOTARIZE:-0}" = "1" ]; then
        echo "  Submitting for notarization..."
        ZIP_TMP="dist/MeetingGenerator.zip"
        /usr/bin/ditto -c -k --keepParent "$APP_PATH" "$ZIP_TMP"
        xcrun notarytool submit "$ZIP_TMP" \
            --apple-id "${APPLE_ID:?set APPLE_ID}" \
            --team-id "${TEAM_ID:?set TEAM_ID}" \
            --password "${APP_PASSWORD:?set APP_PASSWORD}" \
            --wait
        xcrun stapler staple "$APP_PATH"
        rm -f "$ZIP_TMP"
    fi
else
    echo "[4/5] Ad-hoc signing (no CODESIGN_IDENTITY set)..."
    codesign --deep --force --verify \
        --sign - \
        --entitlements entitlements.plist \
        --options runtime \
        "$APP_PATH" || true
    codesign -d --entitlements - "$APP_PATH" || true
fi

echo ""
echo "[5/5] Creating DMG installer..."
bash create_dmg.sh
echo ""

echo "=== Build complete ==="
echo ""
echo "DISTRIBUTION:"
echo "  .dmg installer:   dist/MeetingGenerator.dmg"
echo "  .app bundle:      dist/MeetingGenerator.app"
echo ""
echo "For real code signing + notarization, see build/signing/macos.md"
echo ""
