#!/bin/bash
# Build brightsign/autorun.zip — the single-file installer for a BrightSign player.
#
#   scripts/build-autorun-zip.sh [--server https://your-server] [-o path/to/autorun.zip]
#
# Drop the resulting autorun.zip on the root of a player's storage (microSD, USB, or internal
# flash over SFTP) and power-cycle. autozip.brs unpacks it in place, marks it done, and reboots
# into the player. One file to distribute instead of four that must all land intact.
#
# ⚠️ The zip must expand to files AT ITS ROOT — no wrapper directory. A player extracts to the
# storage root, so a nested folder puts autorun.brs somewhere the player never looks and the
# card silently does nothing. That is why this zips from *inside* the staging directory.
#
# ⚠️ autorun.brs must NOT sit next to autorun.zip on the storage root: its presence stops the zip
# being processed at all. It belongs inside, which is where this puts it.
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER=""
OUT="brightsign/autorun.zip"
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="${2:-}"; shift 2 ;;
    -o|--out) OUT="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

command -v zip >/dev/null || { echo "ERROR: 'zip' is not installed." >&2; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# The payload. autozip.brs must be here too: it is what the NEXT player to receive this archive
# runs, and it has to survive being extracted alongside everything else.
cp brightsign/autozip.brs        "$STAGE/"
cp brightsign/autorun.brs        "$STAGE/"
cp brightsign/offline.html       "$STAGE/"
cp brightsign/screentinker.json  "$STAGE/"

# Stamp the version into the host so the script REPORTS the version it actually is. A package that
# ships reporting the old version is applied, reports the old version, and is offered again on the
# next check — forever. server/lib/brightsign-package.js does the identical substitution, anchored
# on the same ST_PACKAGE_VERSION marker, so a zip built here and one built by the server agree.
VERSION="$(cat VERSION 2>/dev/null | tr -d '[:space:]')"
if [ -n "$VERSION" ]; then
  python3 - "$STAGE/autorun.brs" "$VERSION" <<'PY'
import re, sys
path, version = sys.argv[1], sys.argv[2]
src = open(path).read()
out = re.sub(r'return "[^"]*"(\s*\'\s*ST_PACKAGE_VERSION)', 'return "%s"\\1' % version, src)
if out == src:
    sys.exit("ERROR: ST_PACKAGE_VERSION marker not found in autorun.brs — refusing to ship an "
             "unstamped package, which would loop on every update check.")
open(path, 'w').write(out)
PY
  echo "  stamped package version $VERSION"
fi

# Point a batch at a specific server without hand-editing each card.
if [ -n "$SERVER" ]; then
  python3 - "$STAGE/screentinker.json" "$SERVER" <<'PY'
import json, sys
path, server = sys.argv[1], sys.argv[2]
cfg = json.load(open(path))
cfg['server_url'] = server
json.dump(cfg, open(path, 'w'), indent=2)
PY
  echo "  server_url set to $SERVER"
fi

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
ABS_OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"

# -0 = STORED, no compression. This is not a size/speed preference, it is a compatibility
# requirement: BrightSign's automated deployment reported our first archive as invalid and could
# not open it. The player bootstrap extracts autozip.brs by itself, before any script runs, and
# roBrightPackage documents a specific set of supported methods — "no compression" is the one that
# is universally safe. A deflated archive copies onto the player perfectly and then fails to open,
# which looks like a broken deployment rather than a broken zip.
#
# -X drops extra attributes; -j would flatten any directories added later, so instead cd in and zip
# '.' so the archive root IS the staging root and future subdirectories keep their structure.
( cd "$STAGE" && zip -q -r -X -0 "$ABS_OUT" . )

echo "  built $OUT"
unzip -l "$OUT" | sed 's/^/    /'

# Prove the root-level invariant rather than trusting it: this is the one mistake that makes a
# card look blank to the player, and it is invisible until hardware refuses to boot.
if unzip -l "$OUT" | awk 'NR>3 && $4 ~ /\// && $4 !~ /^[^\/]+$/ {print $4}' | grep -qE '^[^/]+/'; then
  echo "  NOTE: archive contains directories — verify they are intended subdirectories, not a wrapper."
fi
if ! unzip -l "$OUT" | grep -qE ' autorun\.brs$'; then
  echo "ERROR: autorun.brs is not at the archive root — the player would never find it." >&2
  exit 1
fi
if ! unzip -l "$OUT" | grep -qE ' autozip\.brs$'; then
  echo "ERROR: autozip.brs is missing — nothing would unpack this archive." >&2
  exit 1
fi
# Prove every entry is STORED. A single deflated member is enough to make the archive unopenable
# on the player, and it is invisible until a deployment fails in the field.
if unzip -v "$OUT" | awk '$1 ~ /^[0-9]+$/ && $2 ~ /^[A-Za-z]/ && $2 != "Stored" {print $2}' | grep -q .; then
  echo "ERROR: archive contains compressed members; BrightSign needs it stored (zip -0)." >&2
  unzip -v "$OUT" | sed 's/^/    /' >&2
  exit 1
fi
echo "  root-level layout verified, all members stored"
