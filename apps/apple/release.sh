#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Uploads the iOS app to TestFlight and installs the Mac app in /Applications. `release.sh ios` or `release.sh mac` does
# only one. The App Store Connect key comes from ASC_KEY_ID and ASC_ISSUER_ID, or from ~/.appstoreconnect/env, which sets
# them; its AuthKey_<id>.p8 lives in ~/.appstoreconnect/private_keys.
set -eu
cd "$(dirname "$0")"
what=${1:-all}
xcodegen -q

if [ "$what" != ios ]; then
  out=$(mktemp -d)
  xcodebuild -project Nouvex.xcodeproj -scheme Nouvex -configuration Release -destination 'generic/platform=macOS' \
    -derivedDataPath "$out" -skipPackagePluginValidation -quiet build
  osascript -e 'quit app "Nouvex Mail"' 2>/dev/null || true
  rm -rf "/Applications/Nouvex Mail.app"
  ditto "$out/Build/Products/Release/Nouvex Mail.app" "/Applications/Nouvex Mail.app"
  open "/Applications/Nouvex Mail.app"
fi

if [ "$what" != mac ]; then
  [ -n "${ASC_KEY_ID:-}" ] || . "$HOME/.appstoreconnect/env"
  out=$(mktemp -d)
  set -- -allowProvisioningUpdates -authenticationKeyPath "$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8" \
    -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"
  xcodebuild -project Nouvex.xcodeproj -scheme Nouvex -configuration Release -destination generic/platform=iOS \
    -archivePath "$out/Nouvex.xcarchive" -skipPackagePluginValidation CURRENT_PROJECT_VERSION="$(date +%Y%m%d%H%M)" "$@" archive
  xcodebuild -exportArchive -archivePath "$out/Nouvex.xcarchive" -exportOptionsPlist ExportOptions.plist -exportPath "$out" "$@"
fi
