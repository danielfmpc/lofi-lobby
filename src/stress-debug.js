// Dev-only stress test module: spawns fake animated trainers (and optional chat bubbles)
// inside the Debug Hub (src/debug.js) so production builds contain zero stress-test code.

const COUNTS = [0, 10, 25, 50, 80];
const PHRASES = [
  "testing 60 fps!",
  "lofi beats to study to",
  "so cozy here",
  "bench check",
  "look at all these trainers",
  "smooth as butter",
];

/** Creates the dev-only stress test module for the modular Debug Hub (src/debug.js). */
export function createStressDebugModule({
  renderer,
  others,
  createOther,
  removeOther,
  showBubble,
  getCatNav,
  getPlayerCount,
  getPos,
  keepAwake,
  NAME_COLORS,
  CAPS,
}) {
  const colorKeys = Object.keys(NAME_COLORS);
  const bots = []; // { id, wx, wz, pauseUntil, nextBubbleAt, stepPhase, run }
  let targetCount = 0;
  let walkEnabled = true;
  let bubblesEnabled = false;
  let els = null;
  let lastTickMs = 0;
  let lastUiMs = 0;
  let lastBubbleAt = 0;
  let avgFps = 60;
  let avgMs = 16.7;

  function pickWaypoint() {
    const nodes = getCatNav()?.nodes;
    if (nodes && nodes.length) {
      const n = nodes[Math.floor(Math.random() * nodes.length)];
      return { x: n.x, z: n.z };
    }
    const p = getPos();
    const a = Math.random() * Math.PI * 2;
    const r = 3 + Math.random() * 16;
    return { x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r };
  }

  function setBotCount(n) {
    targetCount = n;
    while (bots.length > n) {
      const b = bots.pop();
      removeOther(b.id);
    }
    while (bots.length < n) {
      const i = bots.length;
      const id = `__stress_${i}`;
      const start = pickWaypoint();
      const dest = pickWaypoint();
      createOther({
        id,
        name: `bot${i + 1}`,
        gender: i % 2 ? "female" : "male",
        cap: i % CAPS.length,
        color: colorKeys[i % colorKeys.length],
        x: start.x,
        z: start.z,
        dir: "down",
        step: 0,
        seat: -1,
        hold: i % 6 === 0 ? 2 : 0,
      });
      bots.push({
        id,
        wx: dest.x,
        wz: dest.z,
        pauseUntil: 0,
        nextBubbleAt: 0,
        stepPhase: Math.random() * 4,
        run: i % 4 === 0,
      });
    }
    syncButtons();
  }

  function syncButtons() {
    if (!els) return;
    for (const b of els.counts) b.classList.toggle("on", Number(b.dataset.n) === targetCount);
    els.walk.classList.toggle("on", walkEnabled);
    els.bubbles.classList.toggle("on", bubblesEnabled);
  }

  return {
    id: "stress",
    title: "stress test",
    desc: "fake trainers, chat bubbles & live perf",
    mount(container) {
      container.innerHTML = `
        <dl>
          <dt>fps / frame</dt><dd data-s="fps">—</dd>
          <dt>draw calls</dt><dd data-s="calls">—</dd>
          <dt>triangles</dt><dd data-s="tris">—</dd>
          <dt>gpu mem</dt><dd data-s="mem">—</dd>
          <dt>trainers</dt><dd data-s="bots">0 / 1</dd>
        </dl>
        <div class="dbg-controls">
          <span>bots:</span>
          ${COUNTS.map((n) => `<button type="button" data-n="${n}">${n}</button>`).join("")}
          <button type="button" data-act="walk">walk</button>
          <button type="button" data-act="bubbles">bubbles</button>
        </div>
      `;
      els = {
        fps: container.querySelector('[data-s="fps"]'),
        calls: container.querySelector('[data-s="calls"]'),
        tris: container.querySelector('[data-s="tris"]'),
        mem: container.querySelector('[data-s="mem"]'),
        bots: container.querySelector('[data-s="bots"]'),
        counts: [...container.querySelectorAll("button[data-n]")],
        walk: container.querySelector('button[data-act="walk"]'),
        bubbles: container.querySelector('button[data-act="bubbles"]'),
      };
      for (const b of els.counts) {
        b.addEventListener("click", (e) => {
          setBotCount(Number(b.dataset.n));
          lastUiMs = 0;
          e.currentTarget.blur();
        });
      }
      els.walk.addEventListener("click", (e) => {
        walkEnabled = !walkEnabled;
        syncButtons();
        e.currentTarget.blur();
      });
      els.bubbles.addEventListener("click", (e) => {
        bubblesEnabled = !bubblesEnabled;
        syncButtons();
        e.currentTarget.blur();
      });
      syncButtons();
    },
    onOpen() {
      lastUiMs = 0;
      syncButtons();
    },
    update({ frameMs, visible }) {
      const now = performance.now();
      const dt = lastTickMs ? Math.min(0.05, (now - lastTickMs) / 1000) : 0.016;
      lastTickMs = now;

      if (bots.length) {
        keepAwake?.();
        for (let i = 0; i < bots.length; i++) {
          const b = bots[i];
          const o = others.get(b.id);
          if (!o) continue;
          if (!walkEnabled || now < b.pauseUntil) {
            o.step = 0;
            o.run = false;
          } else {
            const dx = b.wx - o.target.x;
            const dz = b.wz - o.target.z;
            const dist = Math.hypot(dx, dz);
            if (dist < 0.4) {
              const next = pickWaypoint();
              b.wx = next.x;
              b.wz = next.z;
              b.run = Math.random() < 0.25;
              if (Math.random() < 0.15) b.pauseUntil = now + 600 + Math.random() * 1200;
            } else {
              const speed = 9 * (b.run ? 1.5 : 1);
              const stepDist = Math.min(dist, speed * dt);
              o.target.x += (dx / dist) * stepDist;
              o.target.z += (dz / dist) * stepDist;
              o.dir = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? "right" : "left") : dz > 0 ? "down" : "up";
              b.stepPhase += dt * 8 * (b.run ? 1.5 : 1);
              o.step = Math.floor(b.stepPhase) % 4;
              o.run = b.run;
              o.movedAt = now;
            }
          }
        }
        if (bubblesEnabled && now - lastBubbleAt > 250) {
          lastBubbleAt = now;
          const b = bots[Math.floor(Math.random() * bots.length)];
          const o = others.get(b.id);
          if (o && now > b.nextBubbleAt) {
            b.nextBubbleAt = now + 4500 + Math.random() * 4000;
            showBubble(o.mesh, PHRASES[Math.floor(Math.random() * PHRASES.length)]);
          }
        }
      }

      if (frameMs > 0 && frameMs < 500) {
        const inst = Math.min(240, 1000 / frameMs);
        avgFps = avgFps * 0.9 + inst * 0.1;
        avgMs = avgMs * 0.9 + frameMs * 0.1;
      }
      if (!visible || !els || now - lastUiMs < 250) return;
      lastUiMs = now;
      const info = renderer.info;
      const fpsVal = Math.round(avgFps);
      els.fps.textContent = `${fpsVal} fps (${avgMs.toFixed(1)} ms)`;
      els.fps.className = fpsVal < 25 ? "bad" : fpsVal < 45 ? "warn" : "";
      els.calls.textContent = String(info.render.calls);
      els.tris.textContent = info.render.triangles.toLocaleString();
      els.mem.textContent = `${info.memory.geometries} geo · ${info.memory.textures} tex`;
      els.bots.textContent = `${bots.length} bots · ${getPlayerCount()} total`;
    },
  };
}
