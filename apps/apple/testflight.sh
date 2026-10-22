#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Archives the iOS app and uploads it to TestFlight. Needs an App Store Connect API key: ASC_KEY_ID and ASC_ISSUER_ID set,
# its AuthKey_<id>.p8 in ~/.appstoreconnect/private_keys.
set -eu
cd "$(dirname "$0")"
out=$(mktemp -d)
set -- -allowProvisioningUpdates -authenticationKeyPath "$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8" \
  -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"
xcodegen -q
xcodebuild -project Nouvex.xcodeproj -scheme Nouvex -configuration Release -destination generic/platform=iOS \
  -archivePath "$out/Nouvex.xcarchive" -skipPackagePluginValidation CURRENT_PROJECT_VERSION="$(date +%Y%m%d%H%M)" "$@" archive
xcodebuild -exportArchive -archivePath "$out/Nouvex.xcarchive" -exportOptionsPlist ExportOptions.plist -exportPath "$out" "$@"
