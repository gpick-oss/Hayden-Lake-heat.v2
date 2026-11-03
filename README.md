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

**Esc opens the options menu** (pad: Start). Everything is in there:

| Option | What it does |
|---|---|
| Mode | **FAST**: day, ghost cars, no traffic. **IRL**: night, car contact on, random traffic, fast AI, deer. Changing any of those makes it Custom. |
| Session | Full stage, or **section practice** between any two checkpoints (rolling start, its own best time and ghost) |
| Direction | Start → Finish, or Finish → Start (its own racing line, pace notes and bests) |
| Time of day | Day / night (headlights, H for high beams; signs glow in your lights; house windows lit) |
| AI rivals | Off / Easy (leader 21:30) / Fast (leader 19:00) / Pro (16:30) / Alien (14:48) |
| Car collisions | On, or ghost cars |
| Random traffic | Off / light / normal / heavy, both lanes |
| Deer crossings | Each run rolls round(Normal(3, 1.5)) deer, half slow walkers, half fast runners |
| Racing line | Off / full / braking zones only |
| Pace notes | Off / on screen + co-driver reads them / on screen only |
| Cockpit field of view, gearbox, graphics quality | |

Keys: W/↑ gas, S/↓ brake (hold at a stop to reverse), A/D steer, Space handbrake, E/Q shift, T auto/manual,
C camera, L racing line, K collisions, N night, H high beams, V pace notes (off / co-driver / on screen),
P demo lap, R reset to road (+2 s), Backspace restart, M mute.

## Pace notes

`pacenotes/hayden-lake-pace-notes-forward.pdf` and `-reverse.pdf` are printable pace notes (13 pages each),
generated from the lidar-matched road and the verified racing line: direction + grade 1 (slowest) to 6
(flat), HP hairpin, SQ square, K kink, long / v.long, < tightens, > opens, ! / !! caution, crests, dips and
bumps, and the distance to the next call (+ = "into"). Each line has the symbol, the shorthand and the
spoken call. Grouped by checkpoint so you can learn the stage a section at a time. In game the same notes
show on screen, and the co-driver reads them out — Pace notes in the menu, or V.

The co-driver is recorded, not the browser's speech engine (which is silent on Linux without
speech-dispatcher): `game/public/codriver/` holds ~60 clips ("left four", "hairpin right", "long",
"tightens", "one hundred", ...) made offline with [Piper](https://github.com/rhasspy/piper) (British
`en_GB-alan-medium` voice). The game stitches each call from them on the Web Audio clock through a
helmet-intercom filter and ducks the engine while he talks. He starts each call ~3.4 s before the corner,
never queues more than ~1 s of speech ahead, skips a call the car has already reached, and talks up to 16%
faster when a dense section would make a call finish late (at racing-line pace every call ends 0.4 s or
more before its corner). If the clips can't load it falls back to the browser's speech.

## Landmarks

From real data: 32 street-name signs at the real junctions (Overture), 10 gates and 2 stop signs (OSM),
39 mailboxes at the real driveways, the 35 mph limit (OSM), and 4.3 km of guard rail wherever the lidar
shows a high, steep drop or the lake right below the road. Placed by standard road-design rules (not
surveyed): curve / turn / hairpin / reverse-turn signs with advisory speeds, "NEXT X MILES" winding-road
signs, chevrons on the hairpins, mile posts, and a pole line with wires through the stretches with houses.
Rails, poles and gate posts are solid.

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
    .venv/bin/python tools/landmarks.py    # signs, rails, gates, mailboxes, poles -> landmarks.json
    .venv/bin/python tools/racing_line.py [--reverse]   # minimum-curvature racing line candidates
    (cd game && node tools/racingline.mjs [--reverse])  # lap-sims them with the car, verifies by driving
    (cd game && node tools/pacenotes.mjs)               # printable pace notes (HTML + PDF)
    (cd game && node tools/codriver.mjs [--all])        # co-driver voice clips (needs Piper + ffmpeg)

## Racing line

Press L to cycle off / full line / braking zones only (each direction has its own line). The line is a minimum-curvature path inside the
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

## Data sources and licenses

The code is MIT licensed (see LICENSE). The map data in `game/public/world/` and `data/` is derived from:

- Elevation and lidar: USGS 3DEP (public domain)
- Aerial imagery: USDA/USGS NAIP (public domain)
- Tree canopy heights: Meta & World Resources Institute, High Resolution Canopy Height Maps (CC BY 4.0)
- Roads, gates, stop signs, speed limits: © OpenStreetMap contributors (ODbL)
- Building footprints, road names, water and land use: Overture Maps Foundation (CDLA Permissive 2.0 / ODbL for OSM-derived parts)

`data/` keeps only the small inputs; `tools/fetch.py` re-downloads the large GeoTIFFs (DEM, NAIP, canopy).
