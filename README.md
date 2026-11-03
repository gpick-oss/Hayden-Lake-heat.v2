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

Controls: W/↑ gas, S/↓ brake (hold at a stop to reverse), A/D steer, Space handbrake,
E/Q shift up/down, T auto/manual, L racing line, K car collisions on/off, P demo lap, C camera (chase, far, cockpit, hood), R reset to road (+2 s),
M mute, O quality. Gamepads work (RT/LT, left stick, RB/LB shift, A handbrake, B camera, Y reset).

## The car

2009 Subaru WRX 5-door, Stage 2 (~375 hp / 400 lb-ft, 20 psi), straight pipe, on R-compound tyres
(`src/wrx.js`, all numbers in `SPEC`):

- 1,560 kg with driver, 59.5/40.5 weight split, 2.62 m wheelbase, 0.52 m CG height
- four independent tyres with combined-slip friction, load sensitivity and relaxation length
- 5MT ratios 3.454/1.947/1.296/0.972/0.738, 4.444 final; 50/50 viscous centre diff, viscous rear LSD
- turbo spool with lag, rev limiter, engine braking, auto-clutch launch
- ABS (front at peak slip, rear held lower so the tail stays planted), 67/33 brake bias

Measured on flat ground: 0-60 mph 4.8 s, 1/4 mile 13.05 s @ 111 mph, 60-0 mph 99 ft,
1.13 g on the skidpad, top speed ~150 mph.

Engine sound is synthesised live (`src/engine-worklet.js`): boxer pulses arriving in uneven pairs from
unequal-length headers, a 2.7 m open straight pipe, turbo whistle, compressor-surge flutter on
lift-off and overrun crackle. `wrx_engine_test.wav` is a scripted pull through the gears.

You race three AI drivers; your best run is saved as a ghost.

## Rebuild the world

    python3 -m venv .venv && .venv/bin/pip install rasterio numpy pyproj shapely requests duckdb pillow scipy
    .venv/bin/python tools/fetch.py        # downloads raw data into data/ (~1 GB)
    .venv/bin/python tools/refine_road.py  # snaps the OSM centreline onto the real pavement (aerial photo + lidar)
    .venv/bin/python tools/build.py        # writes game/public/world/
    .venv/bin/python tools/racing_line.py  # minimum-curvature racing line candidates
    (cd game && node tools/racingline.mjs) # lap-sims them with the car, verifies by driving, writes racing_line.json

## Racing line

Press L to cycle off / full line / braking zones only. The line is a minimum-curvature path inside the
pavement (0.4 m clear of the edge). Its target speeds come from a lap simulation using the STI's own
measured grip, braking and power (including turbo lag, slopes, and crests that unload the tyres), and
were verified by driving the whole stage with the physics car. Chevrons are green where you can be on
the power, turning yellow then red where your current speed is too fast for that spot, so the first
red chevron is your braking point.

## Cars

The player car is a 2018+ WRX STI sedan in Crystal Black, rivals are blue BRZs. Both are procedural
(`src/carBuilder.js`; inspect them at /studio.html?car=sti&view=photo). For exact looks, drop a real
model in: download the glTF from Sketchfab and unzip it to `game/public/models/sti/` (scene.gltf) or
`game/public/models/brz/`; the game scales it, finds the wheels and repaints it automatically.

Change the route by editing `data/route_osrm.json` (OSRM output) and the bounds in `tools/fetch.py`.
