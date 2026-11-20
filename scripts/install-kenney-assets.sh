#!/usr/bin/env bash
# Install the Kenney CC0 model kits used by list_assets / add_solid kind "mesh".
# The .glb files are not committed. Download the two kits by hand from kenney.nl (free, CC0; the site
# hands out a signed link from its download popup, so there is no stable URL to script):
#   Furniture Kit: https://kenney.nl/assets/furniture-kit
#   Nature Kit:    https://kenney.nl/assets/nature-kit
# then run:  scripts/install-kenney-assets.sh path/to/kenney_furniture-kit.zip path/to/kenney_nature-kit.zip
# It unpacks the GLB models into assets/kenney-furniture and assets/kenney-nature and checks every model
# named in assets/index.json is present. It fails loudly; it never guesses.
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 FURNITURE_ZIP NATURE_ZIP" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")/.." && pwd)"
install_kit() {
  local zip="$1" kit="$2" tmp dir
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  unzip -q "$zip" -d "$tmp"
  # the folder in the zip holding the most .glb files (Kenney kits ship one GLB folder per kit)
  dir="$(find "$tmp" -type f -iname '*.glb' -printf '%h\n' | sort | uniq -c | sort -rn | head -1 | sed -E 's/^ *[0-9]+ //')"
  [ -n "$dir" ] || { echo "no .glb files in $zip" >&2; exit 1; }
  mkdir -p "$HERE/assets/$kit"
  cp "$dir"/*.glb "$HERE/assets/$kit/"
  echo "$kit: $(ls "$HERE/assets/$kit"/*.glb | wc -l) models from $dir"
}
install_kit "$1" kenney-furniture
install_kit "$2" kenney-nature
node -e '
const fs = require("fs"), path = require("path"), dir = path.join(process.argv[1], "assets");
const idx = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
const missing = Object.entries(idx).filter(([n, v]) => !fs.existsSync(path.join(dir, v.kit, n.split("/")[1] + ".glb"))).map(([n]) => n);
if (missing.length) { console.error("missing models: " + missing.join(", ")); process.exit(1); }
console.log("all " + Object.keys(idx).length + " models in index.json are present");
' "$HERE"
