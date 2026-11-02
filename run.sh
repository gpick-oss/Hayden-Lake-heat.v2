#!/usr/bin/env bash
# Start the game and open it in the browser.
cd "$(dirname "$0")/game"
[ -d node_modules ] || npm install
[ -f public/world/terrain.bin ] || { echo "World assets missing: run tools/fetch.py then tools/build.py first"; exit 1; }
(sleep 2 && xdg-open http://localhost:5199/ >/dev/null 2>&1) &
exec npx vite --port 5199
