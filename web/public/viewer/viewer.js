// Visualiseur 3D libre des niveaux de Lands of Lore.
// Moteur de lancer de rayons écrit pour l'occasion : seules les images viennent du jeu
// (face de chaque mur, fond plafond/sol, sprites de monstres), exportées par
// tools/export_viewer.py dans data/.
(() => {
  "use strict";

  const WALL_H = 0.75;          // texture 128x96 sur une face de 1 case de large
  // Champ de vision : 80° en déplacement libre. En vue intégrée sous le jeu, perspective
  // d'origine : un mur proche (1 case à 0,5 case) occupe 128 px sur 176 -> tan(FOV/2) = 1,375,
  // soit environ 108°, dans une image au format 176x120 (voir docs § 9.3 bis).
  let FOV = 80 * Math.PI / 180;
  const MAX_STEPS = 48;
  const RADIUS = 0.22;
  const FACE_N = 0, FACE_E = 1, FACE_S = 2, FACE_W = 3;
  const DIR_ANGLE = [-Math.PI / 2, 0, Math.PI / 2, Math.PI]; // N, E, S, O (y vers le sud)
  const DIR_INDEX = { N: 0, E: 1, S: 2, O: 3 };

  // ?embed=1 : intégré sous la fenêtre du jeu (index.html). Position reçue de la page
  // parente (postMessage « lol-pos »), pas de commandes, rendu seulement si elle change.
  const EMBED = new URLSearchParams(location.search).get("embed") === "1";
  if (EMBED) FOV = 2 * Math.atan(1.375);
  let dirty = true;
  const view = document.getElementById("view");
  const ctx = view.getContext("2d");
  const mapCanvas = document.getElementById("map");
  const mctx = mapCanvas.getContext("2d");
  const levelSel = document.getElementById("level");
  const whereEl = document.getElementById("where");
  const labelEl = document.getElementById("label");
  const helpEl = document.getElementById("help");

  let W = 400, H = 250, proj = 1, zbuf = new Float32Array(W);
  let frameImg = null, frame32 = null;
  let L = null;                 // niveau courant
  const player = { x: 16, y: 16, a: 0 };
  const keys = new Set();
  let noclip = false, showMap = true;
  let openDoors = new Set();    // index de case dont la porte est ouverte

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem("lol3d:" + k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem("lol3d:" + k, JSON.stringify(v)); } catch (e) {} },
  };

  function resize() {
    const aspect = innerWidth / Math.max(1, innerHeight);
    if (EMBED) { W = 352; H = 240; }                                              // format de la vue d'origine
    else if (aspect > 1.6) { H = 250; W = Math.min(900, Math.round(H * aspect)); } // fenêtre large
    else { W = 400; H = Math.max(160, Math.min(400, Math.round(W / aspect))); }
    view.width = W; view.height = H;
    proj = (W / 2) / Math.tan(FOV / 2);
    zbuf = new Float32Array(W);
    frameImg = ctx.createImageData(W, H);
    frame32 = new Uint32Array(frameImg.data.buffer);
    ctx.imageSmoothingEnabled = false;
  }

  function loadImage(src) {
    return new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = src; });
  }

  // Variante assombrie d'une image (brouillard de distance sans repeindre pixel par pixel).
  function darken(img, levels) {
    const out = [img];
    for (let k = 1; k < levels; k++) {
      const c = document.createElement("canvas");
      c.width = img.width; c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      g.globalCompositeOperation = "source-atop";
      g.fillStyle = `rgba(0,0,0,${k / levels * 0.85})`;
      g.fillRect(0, 0, c.width, c.height);
      out.push(c);
    }
    return out;
  }
  const SHADES = 8;
  const shadeFor = (d) => Math.min(SHADES - 1, Math.floor(Math.max(0, d - 0.6) / 1.4));

  // Pixels d'une texture (64x64) en Uint32 little-endian (0xAABBGGRR).
  function pixels(img) {
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    return { w: img.width, h: img.height, px: new Uint32Array(g.getImageData(0, 0, img.width, img.height).data.buffer) };
  }

  async function loadLevel(n, keepPos) {
    const nn = String(n).padStart(2, "0");
    const [data, walls, spr, floor, ceil] = await Promise.all([
      fetch(`data/level${nn}.json`).then((r) => r.json()),
      loadImage(`data/level${nn}_walls.png`),
      loadImage(`data/level${nn}_spr.png`),
      loadImage(`data/level${nn}_floor.png`),
      loadImage(`data/level${nn}_ceil.png`),
    ]);
    L = data;
    L.wallImgs = darken(walls, SHADES);
    L.floorTex = pixels(floor);
    L.ceilTex = pixels(ceil);
    L.sprImgs = darken(spr, SHADES);
    L.wallInfo = [];
    for (const [id, w] of Object.entries(L.walls)) L.wallInfo[+id] = w;
    openDoors = new Set();
    const saved = store.get("pos");
    if (keepPos && saved && saved.level === n) Object.assign(player, saved);
    else { player.x = L.start.x; player.y = L.start.y; player.a = DIR_ANGLE[L.start.dir]; }
    levelSel.value = n;
    if (!EMBED) store.set("level", n);
    dirty = true;
    drawMapBase();
  }

  // --- Grille -----------------------------------------------------------------
  const inside = (cx, cy) => cx >= 0 && cy >= 0 && cx < 32 && cy < 32;
  const face = (cx, cy, f) => L.faces[(cy * 32 + cx) * 4 + f];
  const info = (id) => L.wallInfo[id];

  function cellBlocked(cx, cy) {
    if (!inside(cx, cy)) return true;
    if (openDoors.has(cy * 32 + cx)) return false;
    for (let f = 0; f < 4; f++) {
      const w = info(face(cx, cy, f));
      if (w && w.block) return true;
    }
    return false;
  }

  function texFor(cx, cy, f) {
    const w = info(face(cx, cy, f));
    if (!w) return null;
    if (w.door && openDoors.has(cy * 32 + cx)) return w.openTex !== undefined ? { tex: w.openTex, opaque: false, block: false } : null;
    if (w.tex < 0) return w.block ? { tex: -1, opaque: false, block: true } : null;
    return { tex: w.tex, opaque: w.opaque, block: w.block };
  }

  // --- Rendu ------------------------------------------------------------------
  function render() {
    const dirX = Math.cos(player.a), dirY = Math.sin(player.a);
    const planeX = -dirY * Math.tan(FOV / 2), planeY = dirX * Math.tan(FOV / 2);
    castFloorCeiling(dirX, dirY, planeX, planeY);
    const cols = L.atlasCols, fw = L.faceW, fh = L.faceH;
    // en mode intégré : monstres à leurs positions réelles (envoyées par la page du jeu)
    const sprites = projectSprites(dirX, dirY, planeX, planeY);
    const items = [];   // éléments de la colonne : [distance, type, …]

    for (let x = 0; x < W; x++) {
      const cam = 2 * x / W - 1;
      const rx = dirX + planeX * cam, ry = dirY + planeY * cam;
      let cx = Math.floor(player.x), cy = Math.floor(player.y);
      const ddx = Math.abs(1 / rx), ddy = Math.abs(1 / ry);
      const sx = rx < 0 ? -1 : 1, sy = ry < 0 ? -1 : 1;
      let sdx = (rx < 0 ? player.x - cx : cx + 1 - player.x) * ddx;
      let sdy = (ry < 0 ? player.y - cy : cy + 1 - player.y) * ddy;
      items.length = 0;
      let nearestOpaque = 1e9;
      for (let s = 0; s < MAX_STEPS; s++) {
        let side;
        if (sdx < sdy) { sdx += ddx; cx += sx; side = 0; } else { sdy += ddy; cy += sy; side = 1; }
        if (!inside(cx, cy)) break;
        const f = side === 0 ? (sx > 0 ? FACE_W : FACE_E) : (sy > 0 ? FACE_N : FACE_S);
        const t = texFor(cx, cy, f);
        if (!t) continue;
        const dist = side === 0 ? sdx - ddx : sdy - ddy;
        let u = side === 0 ? player.y + dist * ry : player.x + dist * rx;
        u -= Math.floor(u);
        // sens de lecture de la texture vu depuis l'extérieur de la face
        if (f === FACE_E || f === FACE_N) u = 1 - u;
        if (t.tex >= 0) items.push({ d: dist, tex: t.tex, u });
        if (t.block && (t.opaque || t.tex < 0)) { nearestOpaque = dist; break; }
      }
      zbuf[x] = nearestOpaque;
      for (const sp of sprites) {
        if (x < sp.x0 || x > sp.x1 || sp.tz >= nearestOpaque) continue;
        let u = (x - sp.left) / sp.sw;
        if (u < 0 || u >= 1) continue;
        items.push({ d: sp.tz, sp, u: sp.mirror ? 1 - u : u });
      }
      // du plus loin au plus proche : faces transparentes et sprites s'occultent correctement
      items.sort((a, b) => b.d - a.d);
      for (const it of items) {
        const dist = Math.max(0.05, it.d);
        if (it.sp) {
          const sp = it.sp;
          if (sp.ghost) ctx.globalAlpha = 0.55;          // apparition sur événement
          ctx.drawImage(L.sprImgs[shadeFor(dist)], sp.rx + Math.floor(it.u * sp.rw), sp.ry, 1, sp.rh,
            x, sp.top, 1, sp.sh);
          ctx.globalAlpha = 1;
        } else {
          const colH = WALL_H / dist * proj;
          const top = H / 2 - colH / 2;
          const tx = (it.tex % cols) * fw + Math.min(fw - 1, Math.floor(it.u * fw));
          const ty = Math.floor(it.tex / cols) * fh;
          ctx.drawImage(L.wallImgs[shadeFor(dist)], tx, ty, 1, fh, x, top, 1, colH);
        }
      }
    }
  }

  // Sol et plafond projetés ligne par ligne, en coordonnées du monde : la texture
  // d'une case (reconstituée depuis le fond d'origine) reste fixée au décor ;
  // miroir une case sur deux, comme le fond d'origine qui s'inverse à chaque pas.
  function castFloorCeiling(dirX, dirY, planeX, planeY) {
    const F = L.floorTex, C = L.ceilTex, tw = F.w, th = F.h;
    const lx = dirX - planeX, ly = dirY - planeY;          // rayon de gauche
    const stepX = (2 * planeX) / W, stepY = (2 * planeY) / W;
    const half = H / 2;
    for (let y = Math.floor(half) + 1; y < H; y++) {
      const rowDist = (WALL_H / 2) * proj / (y - half);
      const level = shadeFor(rowDist);
      const k = Math.round((1 - level / SHADES * 0.85) * 256);
      let wx = player.x + rowDist * lx, wy = player.y + rowDist * ly;
      const dx = rowDist * stepX, dy = rowDist * stepY;
      const fRow = y * W, cRow = (H - 1 - y) * W;
      for (let x = 0; x < W; x++, wx += dx, wy += dy) {
        const cx = Math.floor(wx), cy = Math.floor(wy);
        let tx = ((wx - cx) * tw) | 0, ty = ((wy - cy) * th) | 0;
        if ((cx + cy) & 1) tx = tw - 1 - tx;
        const i = ty * tw + tx;
        frame32[fRow + x] = shade(F.px[i], k);
        frame32[cRow + x] = shade(C.px[i], k);
      }
    }
    if (H % 2 === 0) frame32.fill(0xff000000, (H / 2) * W, (H / 2 + 1) * W);
    ctx.putImageData(frameImg, 0, 0);
  }
  function shade(c, k) {
    const r = ((c & 0xff) * k) >> 8, g = (((c >> 8) & 0xff) * k) >> 8, b = (((c >> 16) & 0xff) * k) >> 8;
    return 0xff000000 | (b << 16) | (g << 8) | r;
  }

  // Projection des monstres à l'écran (choix face / profil / dos selon l'angle de vue).
  function projectSprites(dirX, dirY, planeX, planeY) {
    const out = [];
    const inv = 1 / (planeX * dirY - dirX * planeY);
    const source = EMBED ? liveMonsters.filter((m) => m.level === L.level) : L.monsters;
    for (const m of source) {
      const ids = L.sprites[EMBED ? m.sprite : m.sprites[0]];
      if (!ids) continue;
      const mx = EMBED ? m.x : m.x + (m.xOffs ?? 128) / 256, my = EMBED ? m.y : m.y + (m.yOffs ?? 128) / 256;
      const dx = mx - player.x, dy = my - player.y;
      const tx = inv * (dirY * dx - dirX * dy);
      const tz = inv * (-planeY * dx + planeX * dy);
      if (tz < 0.15) continue;
      const facing = EMBED ? DIR_ANGLE[m.dir & 3] : DIR_ANGLE[DIR_INDEX[m.direction] ?? 2];
      let rel = Math.atan2(-dy, -dx) - facing;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      let pose = 1, mirror = rel < 0;
      if (Math.abs(rel) < Math.PI / 4) { pose = 0; mirror = false; }
      else if (Math.abs(rel) > 3 * Math.PI / 4) { pose = 2; mirror = false; }
      const rect = L.spriteRects[ids[pose] ?? ids[0]];
      if (!rect) continue;
      const [rx, ry, rw, rh] = rect;
      const scale = (WALL_H / 96) / tz * proj;      // même échelle que les murs (96 px = hauteur)
      const sw = rw * scale, sh = rh * scale;
      const left = W / 2 * (1 + tx / tz) - sw / 2;
      const top = H / 2 + (WALL_H / 2) / tz * proj - sh;
      out.push({ tz, rx, ry, rw, rh, sw, sh, left, top, mirror, ghost: m.spawn === "event",
        x0: Math.max(0, Math.floor(left)), x1: Math.min(W - 1, Math.ceil(left + sw)) });
    }
    return out;
  }

  // --- Carte ------------------------------------------------------------------
  const CELL_COLORS = { wall: "#2b2b2b", floor: "#8a7f68", door: "#a0522d", wall_special: "#555a80",
    floor_special: "#6f8f58", unknown: "#f0f" };
  let mapBase = null;
  function drawMapBase() {
    mapBase = document.createElement("canvas");
    mapBase.width = mapBase.height = 32 * 5;
    const g = mapBase.getContext("2d");
    for (let i = 0; i < 1024; i++) {
      g.fillStyle = CELL_COLORS[L.cells[i]] || "#000";
      g.fillRect((i % 32) * 5, Math.floor(i / 32) * 5, 5, 5);
    }
    g.fillStyle = "#d22";
    for (const l of L.labels) g.fillRect(l.x * 5 + 1, l.y * 5 + 1, 3, 3);
  }
  function drawMap() {
    mapCanvas.style.display = showMap ? "" : "none";
    if (!showMap) return;
    mctx.drawImage(mapBase, 0, 0);
    for (const m of L.monsters) {
      mctx.fillStyle = m.spawn === "event" ? "#ffe628" : "#ff8c00";
      mctx.fillRect((m.x + (m.xOffs ?? 128) / 256) * 5 - 1, (m.y + (m.yOffs ?? 128) / 256) * 5 - 1, 2, 2);
    }
    const px = player.x * 5, py = player.y * 5;
    mctx.strokeStyle = "#fff"; mctx.lineWidth = 1.5;
    mctx.beginPath();
    mctx.moveTo(px + Math.cos(player.a) * 6, py + Math.sin(player.a) * 6);
    mctx.lineTo(px + Math.cos(player.a + 2.5) * 4, py + Math.sin(player.a + 2.5) * 4);
    mctx.lineTo(px + Math.cos(player.a - 2.5) * 4, py + Math.sin(player.a - 2.5) * 4);
    mctx.closePath(); mctx.stroke();
  }

  // --- Déplacement ------------------------------------------------------------
  function tryMove(nx, ny) {
    if (noclip) { player.x = Math.min(31.99, Math.max(0.01, nx)); player.y = Math.min(31.99, Math.max(0.01, ny)); return; }
    const free = (x, y) => !cellBlocked(Math.floor(x - RADIUS), Math.floor(y - RADIUS)) &&
      !cellBlocked(Math.floor(x + RADIUS), Math.floor(y - RADIUS)) &&
      !cellBlocked(Math.floor(x - RADIUS), Math.floor(y + RADIUS)) &&
      !cellBlocked(Math.floor(x + RADIUS), Math.floor(y + RADIUS));
    if (free(nx, player.y)) player.x = nx;     // glisse le long des murs
    if (free(player.x, ny)) player.y = ny;
  }

  function update(dt) {
    const run = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 2 : 1;
    const speed = 2.2 * run * dt, turn = 2.4 * dt;
    const k = (...c) => c.some((x) => keys.has(x));
    if (k("KeyA", "ArrowLeft")) player.a -= turn;     // Q en AZERTY
    if (k("KeyD", "ArrowRight")) player.a += turn;
    let fwd = 0, strafe = 0;
    if (k("KeyW", "ArrowUp")) fwd += 1;              // Z en AZERTY
    if (k("KeyS", "ArrowDown")) fwd -= 1;
    if (k("KeyQ")) strafe -= 1;                      // A en AZERTY
    if (k("KeyE")) strafe += 1;
    if (fwd || strafe) {
      const c = Math.cos(player.a), s = Math.sin(player.a);
      tryMove(player.x + (c * fwd - s * strafe) * speed, player.y + (s * fwd + c * strafe) * speed);
    }
  }

  function toggleDoor() {
    // case devant le joueur, ou celle où il se trouve
    const cands = [[player.x + Math.cos(player.a) * 0.9, player.y + Math.sin(player.a) * 0.9], [player.x, player.y]];
    for (const [x, y] of cands) {
      const cx = Math.floor(x), cy = Math.floor(y);
      if (!inside(cx, cy)) continue;
      let isDoor = false;
      for (let f = 0; f < 4; f++) { const w = info(face(cx, cy, f)); if (w && w.door) isDoor = true; }
      if (!isDoor) continue;
      const i = cy * 32 + cx;
      if (openDoors.has(i)) {
        if (Math.floor(player.x) === cx && Math.floor(player.y) === cy) return; // pas sur le joueur
        openDoors.delete(i);
      } else openDoors.add(i);
      return;
    }
  }

  function updateHud() {
    const cx = Math.floor(player.x), cy = Math.floor(player.y);
    const deg = ((player.a * 180 / Math.PI) % 360 + 360) % 360;
    const card = ["E", "S", "O", "N"][Math.round(deg / 90) % 4];
    whereEl.textContent = `${L.tileset} · case ${cx},${cy} · ${card}${noclip ? " · traverse les murs" : ""}`;
    let best = null, bd = 2.25;
    for (const l of L.labels) {
      if (!l.text) continue;
      const d = (l.x + 0.5 - player.x) ** 2 + (l.y + 0.5 - player.y) ** 2;
      if (d < bd) { bd = d; best = l; }
    }
    labelEl.style.display = best ? "block" : "none";
    if (best) labelEl.textContent = best.text;
  }

  // --- Entrées ----------------------------------------------------------------
  addEventListener("keydown", (e) => {
    if (EMBED || e.target === levelSel) return;
    keys.add(e.code);
    if (e.code === "Space") { toggleDoor(); e.preventDefault(); }
    if (e.code === "KeyN") noclip = !noclip;
    if (e.code === "KeyM") showMap = !showMap;
    if (e.code === "KeyH") helpEl.classList.toggle("hidden");
    if (e.code === "PageDown" || e.code === "PageUp") {
      const i = levelSel.selectedIndex + (e.code === "PageDown" ? 1 : -1);
      if (i >= 0 && i < levelSel.options.length) loadLevel(+levelSel.options[i].value, false);
    }
    if (e.code.startsWith("Arrow") || e.code === "Space") e.preventDefault();
  });
  addEventListener("keyup", (e) => keys.delete(e.code));
  addEventListener("blur", () => keys.clear());
  view.addEventListener("click", () => { if (!EMBED && view.requestPointerLock) view.requestPointerLock(); });
  addEventListener("mousemove", (e) => {
    if (document.pointerLockElement === view) player.a += e.movementX * 0.0035;
  });
  levelSel.addEventListener("change", () => { loadLevel(+levelSel.value, false); levelSel.blur(); });
  addEventListener("resize", () => { resize(); dirty = true; });

  // Mode intégré : monstres à leurs positions réelles.
  let liveMonsters = [];
  addEventListener("message", (e) => {
    if (!EMBED || e.origin !== location.origin || !e.data || e.data.type !== "lol-monsters") return;
    liveMonsters = e.data.list.map((m) => ({ ...m, level: e.data.level }));
    dirty = true;
  });

  // Mode intégré : grille vivante du jeu (portes ouvertes ou fermées…), par niveau.
  const liveGrids = new Map();
  function applyLiveGrid() {
    const g = L && liveGrids.get(L.level);
    if (g && g.length === L.faces.length) { L.faces = g; dirty = true; }
  }
  addEventListener("message", (e) => {
    if (!EMBED || e.origin !== location.origin || !e.data || e.data.type !== "lol-grid") return;
    liveGrids.set(e.data.level, e.data.faces);
    applyLiveGrid();
  });

  // Mode intégré : position du groupe envoyée par la page du jeu (case entière + direction).
  let loadingLevel = null;
  addEventListener("message", async (e) => {
    if (!EMBED || e.origin !== location.origin || !e.data || e.data.type !== "lol-pos") return;
    const { level, x, y, dir } = e.data;
    if (!L || L.level !== level) {
      if (loadingLevel === level) return;
      loadingLevel = level;
      try { await loadLevel(level, false); applyLiveGrid(); } finally { loadingLevel = null; }
    }
    player.x = x + 0.5; player.y = y + 0.5; player.a = DIR_ANGLE[dir & 3];
    dirty = true;
  });

  let last = performance.now(), saveAt = 0;
  function frame(t) {
    const dt = Math.min(0.05, (t - last) / 1000); last = t;
    if (L && EMBED) {
      if (dirty) { render(); updateHud(); dirty = false; }
    } else if (L) {
      update(dt); render(); drawMap(); updateHud();
      if (t > saveAt) { store.set("pos", { level: L.level, x: player.x, y: player.y, a: player.a }); saveAt = t + 1000; }
    }
    requestAnimationFrame(frame);
  }

  (async () => {
    resize();
    const levels = await fetch("data/levels.json").then((r) => r.json());
    for (const l of levels) {
      const o = document.createElement("option");
      o.value = l.level; o.textContent = `${l.level}. ${l.name}`;
      levelSel.appendChild(o);
    }
    const q = new URLSearchParams(location.search);
    const n = +q.get("level") || store.get("level") || 1;
    await loadLevel(levels.some((l) => l.level === n) ? n : 1, !q.has("level"));
    if (q.has("x")) player.x = +q.get("x");
    if (q.has("y")) player.y = +q.get("y");
    if (q.has("a")) player.a = +q.get("a") * Math.PI / 180;   // degrés, 0 = est, 90 = sud
    if (q.has("hud")) { helpEl.classList.add("hidden"); }
    if (EMBED) {
      for (const id of ["top", "help", "map"]) document.getElementById(id).style.display = "none";
      view.style.cursor = "default";
    }
    requestAnimationFrame(frame);
  })();
})();
