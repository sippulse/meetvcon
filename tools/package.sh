#!/bin/sh
# Chrome Web Store package: only what the manifest loads at runtime, which is
# everything except the tests, the tools, the docs and the store images.
#
#   npm run package   ->  dist/meetvcon-<version>.zip
#
# Uses Python's zipfile because this repo has no build step and the box may
# have no `zip`; anything else would mean a dependency to package a folder.

set -e
cd "$(dirname "$0")/.."

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to build the zip (or run: zip -r dist/meetvcon.zip manifest.json enterprise-policy.json icons src)" >&2
  exit 1
fi

VERSION=$(node -p "require('./package.json').version")
MANIFEST_VERSION=$(node -p "require('./manifest.json').version")
if [ "$VERSION" != "$MANIFEST_VERSION" ]; then
  echo "package.json is $VERSION but manifest.json is $MANIFEST_VERSION; the store reads the manifest" >&2
  exit 1
fi

OUT="dist/meetvcon-$VERSION.zip"
mkdir -p dist
rm -f "$OUT"
python3 -m zipfile -c "$OUT" manifest.json enterprise-policy.json icons src
echo "$OUT"
