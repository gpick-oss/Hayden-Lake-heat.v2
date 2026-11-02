# Hayden Lake Run

A point-to-point time trial on the real E Hayden Lake Rd (Hayden Lake, Idaho):
47.802676,-116.705527 → via 47.791726,-116.682640 → 47.750192,-116.724930, 14.5 mi.

Everything in the world is built from real data:

| What | Source |
|---|---|
| Road line | OpenStreetMap (OSRM route through the waypoint) |
| Terrain | USGS 3DEP 1 m lidar bare-earth elevation |
| Ground imagery | USGS NAIP aerial photos (1 m) |
| Trees | Meta/WRI 1 m canopy height model: one tree per detected crown at its real height, species from NAIP near-infrared, colour from the photo |
| Buildings | Overture Maps footprints (with lidar heights), roof colour from the photo |
| Side roads, lake | Overture Maps (OSM-derived) |

## Run

    ./run.sh            # opens http://localhost:5199

Controls: W/↑ gas, S/↓ brake/reverse, A/D steer, Space handbrake, R reset to road (+2 s),
C camera, M mute, Q quality. Gamepads work (RT/LT, left stick, A handbrake, Y reset).

You race three AI drivers; your best run is saved as a ghost.

## Rebuild the world

    python3 -m venv .venv && .venv/bin/pip install rasterio numpy pyproj shapely requests duckdb pillow scipy
    .venv/bin/python tools/fetch.py      # downloads raw data into data/ (~1 GB)
    .venv/bin/python tools/build.py      # writes game/public/world/

Change the route by editing `data/route_osrm.json` (OSRM output) and the bounds in `tools/fetch.py`.
