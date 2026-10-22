#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Brings this server to the newest main once every CI check on it passed. deploy/nouvex-update.timer runs it every two
# minutes; it can also be run by hand. A commit whose build fails here is skipped until the next one.
set -eu
cd "$(dirname "$0")/.."
state=/var/lib/nouvex
mkdir -p $state
git fetch -q origin main
new=$(git rev-parse origin/main)
[ "$new" = "$(cat $state/deployed 2>/dev/null)" ] && exit 0
[ "$new" = "$(cat $state/failed 2>/dev/null)" ] && exit 0

repo=$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')
verdict=$(curl -fsS "https://api.github.com/repos/$repo/commits/$new/check-runs" | python3 -c '
import json, sys
runs = json.load(sys.stdin)["check_runs"]
if not runs or any(r["status"] != "completed" for r in runs): print("waiting")
elif all(r["conclusion"] in ("success", "skipped", "neutral") for r in runs): print("green")
else: print("red")')
[ "$verdict" = waiting ] && exit 0
if [ "$verdict" = red ]; then
	echo "CI failed on $new, staying where we are"
	echo "$new" > $state/failed
	exit 0
fi

git checkout -q --detach "$new"
if docker compose -f deploy/compose.yml up -d --build --remove-orphans; then
	echo "$new" > $state/deployed
	docker image prune -f > /dev/null
	echo "now on $(git log --oneline -1)"
else
	echo "$new" > $state/failed
	exit 1
fi
