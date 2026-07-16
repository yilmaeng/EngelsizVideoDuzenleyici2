#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_DIR="$PROJECT_ROOT/tools/EvdMacAudioCapture"
OUTPUT_DIR="$PROJECT_ROOT/build/native-audio/mac-arm64"
HELPER_NAME="EvdMacAudioCapture"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "EvdMacAudioCapture can only be built on macOS." >&2
  exit 2
fi

export MACOSX_DEPLOYMENT_TARGET=14.2
swift build --package-path "$PACKAGE_DIR" -c release --arch arm64

SOURCE_BINARY="$PACKAGE_DIR/.build/arm64-apple-macosx/release/$HELPER_NAME"
if [[ ! -f "$SOURCE_BINARY" ]]; then
  SOURCE_BINARY="$PACKAGE_DIR/.build/release/$HELPER_NAME"
fi
if [[ ! -f "$SOURCE_BINARY" ]]; then
  echo "Native audio helper output was not found." >&2
  exit 3
fi

mkdir -p "$OUTPUT_DIR"
cp "$SOURCE_BINARY" "$OUTPUT_DIR/$HELPER_NAME"
chmod 755 "$OUTPUT_DIR/$HELPER_NAME"

echo "macOS native audio helper is ready:"
file "$OUTPUT_DIR/$HELPER_NAME"
