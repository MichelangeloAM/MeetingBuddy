#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

APP_PATH="dist/MeetingGenerator.app"
DMG_PATH="dist/MeetingGenerator.dmg"
DMG_TMP="dist/dmg_temp"
BACKGROUND="dmg-background.png"
VOLICON="icon.icns"

echo "============================================"
echo "  Meeting Generator - Create DMG"
echo "============================================"
echo ""

if [ ! -d "$APP_PATH" ]; then
    echo "ERROR: $APP_PATH not found."
    echo "Run ./build_macos.sh first."
    exit 1
fi

rm -rf "$DMG_TMP" "$DMG_PATH" 2>/dev/null || true

if command -v create-dmg &>/dev/null; then
    echo "Using create-dmg..."
    ARGS=(
        --volname "Meeting Generator"
        --window-pos 200 120
        --window-size 540 340
        --icon-size 96
        --icon "MeetingGenerator.app" 140 150
        --app-drop-link 400 150
    )
    if [ -f "$BACKGROUND" ]; then ARGS+=(--background "$BACKGROUND"); fi
    if [ -f "$VOLICON" ]; then ARGS+=(--volicon "$VOLICON"); fi
    if [ -f "LICENSE.txt" ]; then ARGS+=(--eula "LICENSE.txt"); fi
    if [ -n "${CODESIGN_IDENTITY:-}" ] && [ "$CODESIGN_IDENTITY" != "-" ]; then
        ARGS+=(--codesign "$CODESIGN_IDENTITY")
    fi

    create-dmg "${ARGS[@]}" "$DMG_PATH" "dist/MeetingGenerator.app"
else
    echo "create-dmg not found, using hdiutil (install via: brew install create-dmg)"
    echo ""

    mkdir -p "$DMG_TMP"
    cp -R "$APP_PATH" "$DMG_TMP/"
    ln -s /Applications "$DMG_TMP/Applications" 2>/dev/null || true

    hdiutil create -volname "Meeting Generator" -srcfolder "$DMG_TMP" -ov -format UDZO "$DMG_PATH"
    rm -rf "$DMG_TMP"

    if [ -n "${CODESIGN_IDENTITY:-}" ] && [ "$CODESIGN_IDENTITY" != "-" ]; then
        echo "Signing DMG with $CODESIGN_IDENTITY..."
        codesign --sign "$CODESIGN_IDENTITY" --timestamp "$DMG_PATH"
    fi
fi

echo ""
echo "DMG created: $DMG_PATH"
echo "Size: $(du -sh "$DMG_PATH" | cut -f1)"
echo ""
echo "Test: open $DMG_PATH"
echo ""
