# ADR 015: Client performance optimizations and adaptive Eco mode

| | |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-11-27 |
| **Deciders** | Daniel |

## Context

Lofi Lobby is meant to stay open in the background while people study or work, on laptops, integrated GPUs, and phones. Profiling the scene (`src/main.js`) revealed several bottlenecks that caused frame drops while walking at night and unnecessary GPU/CPU load while idle:

- Every step ran up to ~20 vertical `Raycaster.intersectObjects(townMeshes)` queries against all ~1,300 unmerged town meshes (`topHeight`, `groundHeight`, `isWater`, `surfaceAt`, `waterY`), and `updateOthers` re-raycasted every standing remote player every frame.
- Each of the 4 shadowed road `PointLight` posts (`distance = 22`) triggered 6 cubemap shadow passes whenever the 5 roaming cats, capybara, or owl moved near them, while `sun.shadow` redrew every frame (`autoUpdate = true`).
- Static props added avoidable draw calls (13 meshes and 3 materials per bench = 65 draw calls; 5 meshes per lamp post), `camera.far = 1000` exceeded the `140` fog limit, off-screen lights and rides still ticked, fireflies uploaded vertex buffers from CPU every frame, remote players re-processed trainer sprite sheets per connection, and DOM name tags/bubbles mutated `left`/`top` every frame.

## Decision

Optimize client rendering, terrain queries, DOM overlays, and idle power usage without altering the pixel-art aesthetic or gameplay rules:

### 1. Spatial XZ index and O(1) terrain cache (`src/main.js`)
- **Two-layer lookup (`buildTerrainIndex`, `meshesAt`, `sampleTerrain`):**
  - At town load (`prepareTown`), `buildTerrainIndex()` partitions `townMeshes` into `5×5` XZ buckets (`TERRAIN_BUCKET = 5`) using each mesh's bounding box so any raycast only intersects the few meshes in that cell instead of all ~1,300 meshes.
  - A lazy `0.5`-unit `TypedArray` cache (`TERRAIN_CELL = 0.5`) stores `topY`, `groundY`, `surfY`, `waterY`, and bitmask flags (`FLAG_CACHED`, `FLAG_WATER_OR_EDGE`, `FLAG_HAS_WATER`) across `townBox`. Lazy population avoids a heavy upfront raycast pass at startup while turning all subsequent `topHeight`, `groundHeight`, `isWater`, `surfaceAt`, and `waterY` lookups into O(1) array reads.
  - `buildCatNavGrid()` also queries `meshesAt(x, z)` directly, preserving exact navgrid coordinates while accelerating startup generation.
- **Per-player height cache (`updateOthers`):** remote players cache `groundY` at `(groundX, groundZ)` and only re-sample `topHeight` when their interpolated XZ position moves by more than `0.05` units.

### 2. Demand-driven, smooth shadows (`src/main.js`, `src/cat.js`, `src/capybara.js`, `src/owl.js`)
- **Contact blob shadows for small animals:** `cats`, `capy`, and `owl` set `castShadow = false` and are removed from `updateLampShadows`. The capybara and ground cats render lightweight shared circular contact shadows (`animalShadowGeo` / `animalShadowMat`), eliminating constant 6-face lamp cubemap redraws throughout the night when players are idle.
- **Smooth 60 FPS trainer shadows with tighter reach:** road `PointLight` posts retain `512×512` shadow maps and reduce `SHADOW_STEP` from `0.25` to `0.05` (no time throttle) so trainer shadows glide smoothly every frame while walking. To cut shadow overhead without losing immersion, `light.distance` and `light.shadow.camera.far` tighten from `22` to `16` (shrinking the trigger area nearly in half and culling distant town chunks inside each cubemap face), and `updateLampShadows` skips lamps whose reach falls outside `_frustum`.
- **On-demand directional shadow (`sun`):** `sun.shadow.autoUpdate = false` updates `sun.shadow.needsUpdate = true` only when `sunShadowStale` is flagged (town load, `prepareWet` material swap, sun position/state change) or when a shadow-casting trainer moves.

### 3. Frustum culling, merged static props, and low-poly trim (`src/main.js`, `src/ferris-wheel.js`)
- **Tighter camera clip planes:** `PerspectiveCamera(30, 1, 2, 165)` matches the `50..140` fog range, discarding distant geometry and improving depth precision.
- **Light and ride frustum culling:** `_frustum` is computed once per frame after `camera.lookAt`. `cullLights()` sets `light.intensity = 0` and hides glow sprites for off-screen lamp posts and `benchGlow` (avoiding shader recompilation from adding/removing lights). `carousel.update()` and `wheel.update()` only run when inside `_frustum` or when the local player is riding them.
- **Merged benches (`benchGeo`, `benchMaterial`):** previously `createBench()` built 13 separate `BoxGeometry` meshes across 3 materials (`ironMaterial`, `woodLight`, `woodDark`), costing 65 draw calls (plus shadow passes) for 5 benches. Because merging requires a single material, all 13 parts now bake their flat RGB colors (`#2f3b45`, `#b07a45`, `#8a5a34`) into a `color` vertex attribute (`MeshLambertMaterial({ vertexColors: true, flatShading: true })`, matching `carousel.js` and `ferris-wheel.js`) into one shared `benchGeo` with `matrixAutoUpdate = false`, reducing 65 draw calls to **5**.
- **Shared lamp post geometries (`lampShadowGeo`, `lampTopGeo`, `lampLanternGeo`, `lampGlowMat`):** splits each post into 3 shared meshes instead of 5 per-post geometries: `base` + `pole` (`castShadow = true`), `arm` + `cap` (`castShadow = false`, so the hood never blocks its own bulb), and `lantern`, all sharing one `lampGlowMat` sprite material.
- **Ferris wheel segment trim:** reduces `TorusGeometry` tubular segments on the outer/inner rims (`48→32`, `32→24`) in `src/ferris-wheel.js`.

### 4. GPU particles, sprite-sheet cache, and zero-reflow overlays (`src/main.js`, `index.html`, `src/board.css`)
- **GPU fireflies:** wandering math (`uWander`, `uTime`, `phase`, `speed`) runs in the `Points` vertex shader over static `fireflyBase` positions, eliminating the per-frame CPU loop and GPU buffer upload.
- **Dirty-checked rain splashes:** `updateRain()` only flags `splashGeometry` `offset`, `size`, and `age` attributes with `needsUpdate = true` when splashes spawn or are actively fading (`age < 1`), and reuses a single `_surfOut` object in `surfaceAt`.
- **Sprite-sheet processing cache (`rawSheets`, `processedSheets`):** caches the loaded `Image` per gender and the processed `HTMLCanvasElement` (background removal, cap recoloring, sitting frames) by `${gender}:${cap}` so multiple remote players sharing a look skip PNG decoding, pixel loops, and duplicate `bodyShape()` scans. `removeOther()` also disposes per-player `material`, `customDepthMaterial`, and `customDistanceMaterial`.
- **Compositor-only DOM overlays (`placeOverlay`, `placeLeftTop`):** moves `.tag`, `.bubble`, `#sit-prompt`, `#capy-prompt`, `#cat-prompt`, and `#stone-prompt` via `transform: translate3d(x, y, 0) translate(-50%, -100%)` with pixel-rounded dirty checking and NDC off-screen culling (`±1.15` / `_v.z < 1`). `#wall-prompt` and `#fish-prompt` keep pixel-rounded `placeLeftTop` so their CSS bob animations stay isolated. `nameTag()` metadata updates only fire on join/state messages instead of every frame.

### 5. Adaptive Eco / Study mode and Dev-only Stress Test (`src/main.js`, `index.html`, `src/stress-debug.js`, `src/debug.js`)
- **Eco / Study mode (`#eco` button, `L` key, `localStorage` `"eco"`):** caps rendering to 30 FPS (`minFrameMs = 33`, checked *before* `clock.getDelta()` so movement/animations keep accurate real-time `dt`) and disables `.glass` `backdrop-filter: blur(10px)` via `body.eco` (also disabled on `pointer: coarse` mobile devices).
- **Automatic idle & background throttling:** caps to 30 FPS on the pause screen or after 10 s without player input, and skips simulation/rendering completely when `document.hidden` is true.
- **Dev-only Stress Test (`src/stress-debug.js`):** registered in the Debug Hub (`import.meta.env.DEV` only, stripped from production builds) to spawn `0..80` walking bots with optional chat bubbles and live FPS, frame time, draw calls, triangles, and GPU memory counters. `sock.onclose` preserves `__stress_*` entries across reconnects and `keepAwake()` prevents idle 30 FPS throttling while bots are active.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Throttle shadow updates to 15–20 Hz (`66 ms` / `50 ms`) and shrink lamp maps to `256×256`** | Tested in browser: made shadows step visibly behind walking trainers instead of gliding at 60 FPS; keeping `512×512` + `SHADOW_STEP = 0.05` with tighter `distance = 16` and animal blob shadows kept smooth motion while eliminating idle and out-of-frustum redraws. |
| **Disable shadows on the 2 house/board road lamps (`castShadow = false`)** | Cuts 2 more cubemap shadow sets, but removes dynamic trainer shadows in the main hub area and hurts night immersion. |
| **Convert the Twinleaf FBX to compressed GLB offline** | Not applied in this environment (`blender`/`fbx2gltf` unavailable) and ADR 005 versions the original FBX in `public/assets/`. |

## Consequences

- **Measured client benchmark (`1280×800`, 0 console errors):**

| Scenario | Before (FPS / draw calls) | After (FPS / draw calls) |
|---|---|---|
| Night (active) | 50–60 fps · 187–559 calls (slowest 45.9 ms) | **59–61 fps · 38 calls** (141 on shadow update; slowest 28.9 ms) |
| Night + Walking (WASD) | 42–54 fps · 325–570 calls (slowest 101.0 ms) | **60–61 fps · 27–145 calls** (peak 289; slowest 26.4 ms) |
| Night + Rain (`R`) | 50–59 fps · 182–556 calls | **59–60 fps · 39 calls** |
| Day (`N`) | 60 fps · 179 calls | **60 fps · 39 calls (−78%)** |
| Eco (`L`) / Idle > 10 s | — | **26–30 fps · 36–42 calls** (`backdrop-filter` off in Eco) |

*(Note: when later tested with the roller coaster + tighter `distance = 16` lamps, idle night settles around ~61–71 draw calls and walking near a post around ~179–218 draw calls.)*

- Terrain queries inside `townBox` snap to a `0.5`-unit cell grid after first hit; any dynamic geometry added after `prepareTown` is not tracked in `terrainCache`.
- Production builds (`npm run build`) strip `src/stress-debug.js` along with the rest of `src/debug.js`.
