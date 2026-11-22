// Visualiseur 3D libre des niveaux de Lands of Lore.
// Moteur de lancer de rayons écrit pour l'occasion : seules les images viennent du jeu
// (face de chaque mur, fond plafond/sol, sprites de monstres), exportées par
// tools/export_viewer.py dans data/.
(() => {
  "use strict";

  const WALL_H = 0.75;          // texture 128x96 sur une face de 1 case de large
  // Champ de vision : 80° en déplacement libre. En vue intégrée sous le jeu, perspective
  // d'origine : un mur proche (1 case à 0,5 case) occupe 128 px sur 176 -> tan(FOV/2) = 1,375,
  // soit environ 108°, dans une image au format 176x120 (voir docs/reverse-engineering.md, § 9.3a).
  let FOV = 80 * Math.PI / 180;
  const MAX_STEPS = 48;
  const RADIUS = 0.22;
  const FACE_N = 0, FACE_E = 1, FACE_S = 2, FACE_W = 3;
  const DIR_ANGLE = [-Math.PI / 2, 0, Math.PI / 2, Math.PI]; // N, E, S, O (y vers le sud)
  const DIR_INDEX = { N: 0, E: 1, S: 2, O: 3 };

  // ?embed=1 : intégré sous la fenêtre du jeu (index.html). Position reçue de la page
  // parente (postMessage « lol-pos »), pas de commandes, rendu seulement si elle change.
  const DATA_V = "20261122a";                      // version des données exportées (cache du navigateur)
  const EMBED = new URLSearchParams(location.search).get("embed") === "1";
  if (EMBED) FOV = 2 * Math.atan(1.375);
  let dirty = true;
  // Vue libre (mode intégré) : clic gauche maintenu + glisser = tourner la tête ; relâcher =
  // retour au point de vue du jeu. pitch = décalage vertical de l'horizon, en pixels du rendu.
  let looking = false, lookYaw = 0, pitch = 0, gameA = 0;
  // Transitions douces (mode intégré) : un pas ou un quart de tour du jeu est animé.
  let anim = null, turning = false;                     // {x0, y0, a0, x1, y1, a1, t0, dur}
  const ANIM_MOVE = 220, ANIM_TURN = 200;               // durées en ms
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
  window.lolPlayer = player;                          // débogage (console de la vue 3D)
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
  // Extérieurs : ciel (couleur des lignes hautes du fond d'origine) au lieu du plafond, et
  // façades de plusieurs étages (murs hauts de la ville d'Yvel). storeys = hauteur en étages.
  const OUTDOOR = { YVEL1: { storeys: 3 } };
  const FOOT = 12;              // lignes du bas de la face (soubassement) non répétées aux étages
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

  // Ciel : couleur moyenne de chaque ligne du fond d'origine au-dessus de l'horizon (ligne 47).
  // Étages : pour chaque face, la texture unie (mur le plus fréquent du niveau) dont le haut
  // ressemble le plus au haut de la face, pour ne pas répéter portes et enseignes en hauteur.
  const BG_HORIZON = 47;
  function setupOutdoor(L, walls, bg) {
    L.sky = [];
    if (bg) {
      const b = pixels(bg);
      for (let y = 0; y < BG_HORIZON; y++) {
        let r = 0, g = 0, bl = 0;
        for (let x = 0; x < b.w; x++) { const c = b.px[y * b.w + x]; r += c & 255; g += (c >> 8) & 255; bl += (c >> 16) & 255; }
        r = Math.round(r / b.w); g = Math.round(g / b.w); bl = Math.round(bl / b.w);
        L.sky.push(0xff000000 | (bl << 16) | (g << 8) | r);
      }
    }
    if (!L.sky.length) L.sky.push(0xff9a9090);
    const W2 = walls.width, px = pixels(walls).px, fw = L.faceW, fh = L.faceH, cols = L.atlasCols;
    const freq = new Map();
    for (const id of L.faces) { const w = L.wallInfo[id]; if (w && w.opaque && !w.door && w.tex >= 0) freq.set(w.tex, (freq.get(w.tex) || 0) + 1); }
    const plain = [...freq].sort((a, b) => b[1] - a[1]).slice(0, 4).map((e) => e[0]);
    const top = (tex) => {                          // lignes 2 à 13 de la face, sous-échantillonnées
      const out = [], x0 = (tex % cols) * fw, y0 = Math.floor(tex / cols) * fh;
      for (let y = 2; y < 14; y += 2) for (let x = 0; x < fw; x += 4) out.push(px[(y0 + y) * W2 + x0 + x]);
      return out;
    };
    const ptop = plain.map(top);
    L.upper = new Map();
    const dist = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) { const p = a[i], q = b[i];
      d += Math.abs((p & 255) - (q & 255)) + Math.abs(((p >> 8) & 255) - ((q >> 8) & 255)) + Math.abs(((p >> 16) & 255) - ((q >> 16) & 255)); } return d; };
    L.upperOf = (tex) => {
      if (!L.upper.has(tex)) {
        let best = plain.includes(tex) ? tex : plain[0] ?? tex;
        if (!plain.includes(tex) && plain.length) {
          const t = top(tex); let bd = Infinity;
          plain.forEach((p, k) => { const d = dist(t, ptop[k]); if (d < bd) { bd = d; best = p; } });
        }
        L.upper.set(tex, best);
      }
      return L.upper.get(tex);
    };
  }
  const skyAt = (y, hz) => L.sky[Math.max(0, Math.min(L.sky.length - 1, Math.floor(BG_HORIZON - (hz - y) / Math.max(1, hz) * BG_HORIZON)))];
  // étages au-dessus d'une colonne de mur (de bas en haut), même assombrissement que la face
  function drawUpper(tex, u, dist, x, top, colH) {
    const S = L.outdoor.storeys, fw = L.faceW, fh = L.faceH, cols = L.atlasCols;
    const ut = L.upperOf(tex), sh = fh - FOOT, h = colH * sh / fh;
    const tx = (ut % cols) * fw + Math.min(fw - 1, Math.floor(u * fw)), ty = Math.floor(ut / cols) * fh;
    const img = L.wallImgs[shadeFor(dist)];
    for (let k = 1; k < S && top - (k - 1) * h > 0; k++) ctx.drawImage(img, tx, ty, 1, sh, x, top - k * h, 1, h + 0.5);
  }

  async function loadLevel(n, keepPos) {
    const nn = String(n).padStart(2, "0");
    const [data, walls, spr, floor, ceil, bg] = await Promise.all([
      fetch(`data/level${nn}.json?v=${DATA_V}`).then((r) => r.json()),
      loadImage(`data/level${nn}_walls.png?v=${DATA_V}`),
      loadImage(`data/level${nn}_spr.png?v=${DATA_V}`),
      loadImage(`data/level${nn}_floor.png?v=${DATA_V}`),
      loadImage(`data/level${nn}_ceil.png?v=${DATA_V}`),
      loadImage(`data/level${nn}_bg.png?v=${DATA_V}`).catch(() => null),
    ]);
    L = data;
    L.wallImgs = darken(walls, SHADES);
    L.floorTex = pixels(floor);
    L.ceilTex = pixels(ceil);
    L.sprImgs = darken(spr, SHADES);
    L.sprSrc = spr; L.compCache = new Map();
    L.wallInfo = [];
    for (const [id, w] of Object.entries(L.walls)) L.wallInfo[+id] = w;
    L.outdoor = OUTDOOR[L.tileset] || null;
    if (L.outdoor) setupOutdoor(L, walls, bg);
    buildDoorPanels(walls);
    doorShown.clear();
    openDoors = new Set();
    const saved = store.get("pos");
    if (keepPos && saved && saved.level === n) Object.assign(player, saved);
    else { player.x = L.start.x; player.y = L.start.y; player.a = DIR_ANGLE[L.start.dir]; }
    levelSel.value = n;
    if (!EMBED) store.set("level", n);
    dirty = true;
    drawMapBase();
    // planche translucide (monstres à drapeau 0x800), assombrie par la distance comme les autres
    // sprites ; chargée après le niveau, sans bloquer le rendu (version opaque en attendant)
    L.ghostImgs = null;
    if (L.ghostRects && L.ghostRects.length) {
      loadImage(`data/level${nn}_ghost.png?v=${DATA_V}`).then((gimg) => {
        if (L !== data) return;
        data.ghostImgs = darken(gimg, SHADES); dirty = true;
      }, () => {});
    }
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

  // --- Portes animées ---------------------------------------------------------
  // Le jeu ouvre une porte par étapes : types de mur consécutifs, du fermé (bloquant, avec
  // texture ouverte) à l'ouvert (non bloquant). Les textures exportées des étapes montrent
  // toutes la porte fermée : on isole le panneau (pixels qui diffèrent entre la texture
  // fermée et la texture ouverte) et on le fait monter dans l'encadrement.
  const DOOR_SPEED = 1.6;                                 // ouverture complète en ~0,6 s
  const doorShown = new Map();                            // face (case*4+f) -> {q affiché, cible}
  window.lolDoors = doorShown;                            // débogage
  function doorSeries(id) {                               // -> {start, end} ou null
    const w = info(id);
    if (!w || !w.door) return null;
    let a = id, b = id;
    while (info(a - 1) && info(a - 1).door && info(a - 1).block && id - a < 6) a--;
    while (info(b) && info(b).block && info(b + 1) && info(b + 1).door && b - id < 6) b++;
    return info(b) && !info(b).block && b > a ? { start: a, end: b } : null;
  }
  function openness(id) {
    const s = doorSeries(id);
    return s ? (id - s.start) / (s.end - s.start) : null;
  }
  function buildDoorPanels(img) {
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const src = g.getImageData(0, 0, c.width, c.height), out = g.createImageData(c.width, c.height);
    const fw = L.faceW, fh = L.faceH, cols = L.atlasCols;
    for (const w of L.wallInfo) {
      if (!w || !w.door || w.openTex === undefined || w.tex < 0) continue;
      const cx0 = (w.tex % cols) * fw, cy0 = Math.floor(w.tex / cols) * fh;
      const ox0 = (w.openTex % cols) * fw, oy0 = Math.floor(w.openTex / cols) * fh;
      let y0 = fh, y1 = -1;
      for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
        const a = ((cy0 + y) * c.width + cx0 + x) * 4, b = ((oy0 + y) * c.width + ox0 + x) * 4;
        const d = Math.abs(src.data[a] - src.data[b]) + Math.abs(src.data[a + 1] - src.data[b + 1]) + Math.abs(src.data[a + 2] - src.data[b + 2])
          + Math.abs(src.data[a + 3] - src.data[b + 3]);
        if (d > 24) {
          out.data.set(src.data.subarray(a, a + 4), a);
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      w.panel = y1 >= y0 ? { y0, y1: y1 + 1 } : null;
    }
    g.clearRect(0, 0, c.width, c.height);
    g.putImageData(out, 0, 0);
    L.panelImgs = darken(c, SHADES);
  }
  // Nouvelle grille vivante : les portes dont l'ouverture change sont animées vers leur cible.
  function retargetDoors(oldFaces, newFaces) {
    for (let k = 0; k < newFaces.length; k++) {
      if (oldFaces[k] === newFaces[k]) continue;
      const qNew = openness(newFaces[k]);
      if (qNew === null) { doorShown.delete(k); continue; }
      const cur = doorShown.get(k);
      const qOld = cur ? cur.q : openness(oldFaces[k]);
      doorShown.set(k, { q: qOld === null ? qNew : qOld, target: qNew });
    }
  }
  function stepDoors(dt) {
    let moving = false;
    for (const [k, d] of doorShown) {
      if (d.q === d.target) continue;
      const step = DOOR_SPEED * dt;
      d.q = d.q < d.target ? Math.min(d.target, d.q + step) : Math.max(d.target, d.q - step);
      moving = true;
    }
    return moving;
  }

  function texFor(cx, cy, f) {
    const id = face(cx, cy, f), w = info(id);
    if (!w) return null;
    const shown = doorShown.get((cy * 32 + cx) * 4 + f);
    if (shown && w.door) {
      const s = doorSeries(id), closed = s && info(s.start);
      if (closed && closed.panel && closed.openTex !== undefined) {
        if (shown.q >= 0.999) return { tex: closed.openTex, opaque: false, block: false };
        return { tex: closed.openTex, opaque: false, block: shown.q < 0.001, panel: closed.panel, panelTex: closed.tex, q: shown.q };
      }
    }
    if (w.door && openDoors.has(cy * 32 + cx)) return w.openTex !== undefined ? { tex: w.openTex, opaque: false, block: false } : null;
    if (w.tex < 0) return w.block ? { tex: -1, opaque: false, block: true } : null;
    return { tex: w.tex, opaque: w.opaque, block: w.block };
  }

  // --- Rendu ------------------------------------------------------------------
  // Deux perspectives (vue intégrée) : « réelle » (taille ∝ 1/distance) et « jeu »,
  // qui imite le moteur d'origine : la taille ne diminue que d'environ 0,615 par case
  // (mur de face : 128, 80, 48 px pour 0,5, 1,5, 2,5 cases ; voir docs/reverse-engineering.md, § 9.3a).
  let persp = "reelle";
  try { if (EMBED && localStorage.getItem("lol3d:persp") === "jeu") persp = "jeu"; } catch (e) {}
  let smooth = true;
  try { smooth = localStorage.getItem("lol3d:smooth") !== "off"; } catch (e) {}
  const KSTEP = 1 / 0.615;
  const deff = (z) => (z <= 0.5 ? z : 0.5 * Math.pow(KSTEP, z - 0.5));      // « distance » apparente
  const zOfDeff = (d) => (d <= 0.5 ? d : 0.5 + Math.log(d / 0.5) / Math.log(KSTEP));

  function render() {
    // pendant une rotation, la perspective du jeu (4 directions seulement) cède la place à la réelle
    if (EMBED && persp === "jeu" && !looking && !turning) { renderGamePerspective(); return; }
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
        if (t.tex >= 0) items.push({ d: dist, tex: t.tex, u, door: t.panel ? t : null });
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
          ctx.drawImage((sp.imgs || L.sprImgs)[shadeFor(dist)], sp.rx + Math.floor(it.u * sp.rw), sp.ry, 1, sp.rh,
            x, sp.top, 1, sp.sh);
          ctx.globalAlpha = 1;
        } else {
          const colH = WALL_H / dist * proj;
          const top = H / 2 + pitch - colH / 2;
          const tx = (it.tex % cols) * fw + Math.min(fw - 1, Math.floor(it.u * fw));
          const ty = Math.floor(it.tex / cols) * fh;
          if (L.outdoor) drawUpper(it.tex, it.u, dist, x, top, colH);
          ctx.drawImage(L.wallImgs[shadeFor(dist)], tx, ty, 1, fh, x, top, 1, colH);
          if (it.door) drawPanel(it, dist, x, top, colH);
        }
      }
    }
    drawHealthBars(sprites);
  }
  // Barre de vie au-dessus de chaque monstre visible (version ScummVM : points de vie actuels du
  // monstre / maximum de son type, publiés par le moteur). Masquée si le centre du monstre est
  // derrière un mur (zbuf) ou s'il est mourant (mode >= 13).
  function drawHealthBars(sprites) {
    for (const sp of sprites) {
      if (!sp.hpMax || sp.hp === undefined || sp.hp <= 0 || sp.mode >= 13) continue;
      const cx = Math.round(sp.left + sp.sw / 2);
      if (cx < 0 || cx >= W || zbuf[cx] <= sp.tz) continue;
      const q = Math.max(0, Math.min(1, sp.hp / sp.hpMax));
      const w = Math.max(18, Math.min(90, sp.sw * 0.55)), h = Math.max(3, Math.min(7, w / 12));
      const x = cx - w / 2, y = Math.max(2, sp.top - h - Math.max(3, h));
      ctx.fillStyle = "rgba(0,0,0,.75)"; ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
      ctx.fillStyle = q > 0.6 ? "#3fbf4a" : q > 0.3 ? "#e0b52a" : "#e0442a";
      ctx.fillRect(x, y, w * q, h);
    }
  }

  // Panneau d'une porte en cours d'ouverture : remonté de q × hauteur de l'ouverture.
  function drawPanel(it, dist, x, top, colH) {
    const { panel, panelTex, q } = it.door, fw = L.faceW, fh = L.faceH, cols = L.atlasCols;
    const h = panel.y1 - panel.y0, sh = q * h, vis = h - sh;
    if (vis <= 0.5) return;
    const tx = (panelTex % cols) * fw + Math.min(fw - 1, Math.floor(it.u * fw)), ty = Math.floor(panelTex / cols) * fh;
    const k = colH / fh;
    ctx.drawImage(L.panelImgs[shadeFor(dist)], tx, ty + panel.y0 + sh, 1, vis, x, top + panel.y0 * k, 1, vis * k);
  }

  // Sol et plafond projetés ligne par ligne, en coordonnées du monde : la texture
  // d'une case (reconstituée depuis le fond d'origine) reste fixée au décor ;
  // miroir une case sur deux, comme le fond d'origine qui s'inverse à chaque pas, sauf
  // pour un sol pavé d'un motif (floorMirror false : texture déjà sans raccord).
  function castFloorCeiling(dirX, dirY, planeX, planeY) {
    const F = L.floorTex, C = L.ceilTex, mirF = L.floorMirror !== false;
    const lx = dirX - planeX, ly = dirY - planeY;          // rayon de gauche
    const stepX = (2 * planeX) / W, stepY = (2 * planeY) / W;
    const hz = H / 2 + pitch;                              // ligne d'horizon (décalée en vue libre)
    for (let y = 0; y < H; y++) {
      const dy = y + 0.5 - hz, fRow = y * W;
      if (Math.abs(dy) < 1) { frame32.fill(L.outdoor ? skyAt(y, hz) : 0xff000000, fRow, fRow + W); continue; }
      if (dy < 0 && L.outdoor) { frame32.fill(skyAt(y, hz), fRow, fRow + W); continue; }
      const T = dy > 0 ? F : C, tw = T.w, th = T.h;        // sous l'horizon : sol, au-dessus : plafond
      const mir = dy > 0 ? mirF : true;
      const rowDist = (WALL_H / 2) * proj / Math.abs(dy);
      const level = shadeFor(rowDist);
      const k = Math.round((1 - level / SHADES * 0.85) * 256);
      let wx = player.x + rowDist * lx, wy = player.y + rowDist * ly;
      const dx = rowDist * stepX, dyw = rowDist * stepY;
      for (let x = 0; x < W; x++, wx += dx, wy += dyw) {
        const cx = Math.floor(wx), cy = Math.floor(wy);
        let tx = ((wx - cx) * tw) | 0, ty = ((wy - cy) * th) | 0;
        if (mir && (cx + cy) & 1) tx = tw - 1 - tx;
        frame32[fRow + x] = shade(T.px[ty * tw + tx], k);
      }
    }
    ctx.putImageData(frameImg, 0, 0);
  }
  function shade(c, k) {
    const r = ((c & 0xff) * k) >> 8, g = (((c >> 8) & 0xff) * k) >> 8, b = (((c >> 16) & 0xff) * k) >> 8;
    return 0xff000000 | (b << 16) | (g << 8) | r;
  }

  // Perspective du jeu. Le groupe regarde toujours vers N, E, S ou O : on travaille en
  // profondeur z (vers l'avant) et en écart latéral. À la colonne u (pixels depuis le
  // centre), le point vu à la profondeur z est à l'écart u·deff(z)/proj : les rayons sont
  // des courbes, qu'on suit par petits pas en relevant les faces de mur traversées.
  function renderGamePerspective() {
    const fx = Math.round(Math.cos(player.a)), fy = Math.round(Math.sin(player.a));
    const rx = -fy, ry = fx;                                  // vers la droite de l'écran
    const half = H / 2;
    // sol et plafond
    const F = L.floorTex, C = L.ceilTex, mirF = L.floorMirror !== false;
    for (let y = Math.floor(half) + 1; y < H; y++) {
      const d = (WALL_H / 2) * proj / (y - half), z = zOfDeff(d);
      const k = Math.round((1 - shadeFor(z) / SHADES * 0.85) * 256);
      const fRow = y * W, cRow = (H - 1 - y) * W;
      for (let x = 0; x < W; x++) {
        const lat = (x + 0.5 - W / 2) * d / proj;
        const wx = player.x + fx * z + rx * lat, wy = player.y + fy * z + ry * lat;
        const cx = Math.floor(wx), cy = Math.floor(wy), odd = (cx + cy) & 1;
        const fu = wx - cx, fv = wy - cy;
        let tx = (fu * F.w) | 0;
        if (mirF && odd) tx = F.w - 1 - tx;
        frame32[fRow + x] = shade(F.px[((fv * F.h) | 0) * F.w + tx], k);
        if (!L.outdoor) {
          let cxx = (fu * C.w) | 0;
          if (odd) cxx = C.w - 1 - cxx;
          frame32[cRow + x] = shade(C.px[((fv * C.h) | 0) * C.w + cxx], k);
        }
      }
      if (L.outdoor) frame32.fill(skyAt(H - 1 - y, half), cRow, cRow + W);
    }
    if (H % 2 === 0) frame32.fill(L.outdoor ? skyAt(half, half) : 0xff000000, half * W, (half + 1) * W);
    ctx.putImageData(frameImg, 0, 0);

    // monstres
    const sprites = [];
    for (const it of floorItems()) {                    // objets au sol : même échelle que les monstres
      const dx = it.x - player.x, dy = it.y - player.y;
      const z = dx * fx + dy * fy, lat = dx * rx + dy * ry;
      if (z < 0.15) continue;
      const [srx, sry, rw, rh] = it.rect, d = deff(z);
      const scale = (WALL_H / 96) * proj / d, sw = rw * scale, sh = rh * scale;
      const left = W / 2 + lat * proj / d - sw / 2, top = half + (WALL_H / 2) * proj / d - sh;
      sprites.push({ tz: z, rx: srx, ry: sry, rw, rh, sw, sh, left, top, mirror: false, imgs: FLOOR.imgs,
        x0: Math.max(0, Math.floor(left)), x1: Math.min(W - 1, Math.ceil(left + sw)) });
    }
    for (const m of (EMBED ? liveMonsters.filter((q) => q.level === L.level) : [])) {
      const ids = L.sprites[m.sprite];
      if (!ids) continue;
      const dx = m.x - player.x, dy = m.y - player.y;
      const z = dx * fx + dy * fy, lat = dx * rx + dy * ry;
      if (z < 0.15) continue;
      let rel = Math.atan2(-dy, -dx) - DIR_ANGLE[m.dir & 3];
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      let pose = 1, mirror = rel < 0;
      if (Math.abs(rel) < Math.PI / 4) { pose = 0; mirror = false; }
      else if (Math.abs(rel) > 3 * Math.PI / 4) { pose = 2; mirror = false; }
      if (m.frame !== undefined && m.frame !== 255) mirror = !!m.flip;
      const look = monsterLook(m.sprite, ids, pose, m);
      if (!look) continue;
      const { rx: srx, ry: sry, rw, rh, imgs } = look, d = deff(z);
      const scale = (WALL_H / 96) * proj / d, sw = rw * scale, sh = rh * scale;
      const left = W / 2 + lat * proj / d - sw / 2, top = half + (WALL_H / 2) * proj / d - sh;
      sprites.push({ tz: z, rx: srx, ry: sry, rw, rh, sw, sh, left, top, mirror, imgs, hp: m.hp, hpMax: m.hpMax, mode: m.mode,
        x0: Math.max(0, Math.floor(left)), x1: Math.min(W - 1, Math.ceil(left + sw)) });
      const blood = bloodSprite(m, z, left, top, sw, sh, scale);
      if (blood) sprites.push(blood);
    }

    // murs : rayons courbes
    const cols = L.atlasCols, fw = L.faceW, fh = L.faceH, DZ = 0.02, ZMAX = 9;
    const items = [];
    for (let x = 0; x < W; x++) {
      const u = x + 0.5 - W / 2;
      let cx = Math.floor(player.x), cy = Math.floor(player.y);
      let pwx = player.x, pwy = player.y, pz = 0, nearest = 1e9, done = false;
      items.length = 0;
      for (let z = DZ; z < ZMAX && !done; z += DZ) {
        const lat = u * deff(z) / proj;
        const wx = player.x + fx * z + rx * lat, wy = player.y + fy * z + ry * lat;
        let ncx = Math.floor(wx), ncy = Math.floor(wy);
        // franchissements de bord de case dans ce pas (x et/ou y), dans l'ordre où ils arrivent
        const cross = [];
        if (ncx !== cx) { const bx = ncx > cx ? ncx : cx; cross.push({ t: (bx - pwx) / (wx - pwx), axis: 0 }); }
        if (ncy !== cy) { const by = ncy > cy ? ncy : cy; cross.push({ t: (by - pwy) / (wy - pwy), axis: 1 }); }
        cross.sort((a, b) => a.t - b.t);
        for (const c of cross) {
          const hx = pwx + (wx - pwx) * c.t, hy = pwy + (wy - pwy) * c.t, hz = pz + DZ * c.t;
          let f, uu;
          if (c.axis === 0) { const nx = ncx > cx ? cx + 1 : cx - 1; f = nx > cx ? FACE_W : FACE_E; cx = nx; uu = hy - Math.floor(hy); }
          else { const ny = ncy > cy ? cy + 1 : cy - 1; f = ny > cy ? FACE_N : FACE_S; cy = ny; uu = hx - Math.floor(hx); }
          if (!inside(cx, cy)) { done = true; break; }
          const t = texFor(cx, cy, f);
          if (!t) continue;
          if (f === FACE_E || f === FACE_N) uu = 1 - uu;
          if (t.tex >= 0) items.push({ d: hz, tex: t.tex, u: uu, door: t.panel ? t : null });
          if (t.block && (t.opaque || t.tex < 0)) { nearest = hz; done = true; break; }
        }
        pwx = wx; pwy = wy; pz = z;
      }
      zbuf[x] = nearest;
      for (const sp of sprites) {
        if (x < sp.x0 || x > sp.x1 || sp.tz >= nearest) continue;
        let uu = (x - sp.left) / sp.sw;
        if (uu < 0 || uu >= 1) continue;
        items.push({ d: sp.tz, sp, u: sp.mirror ? 1 - uu : uu });
      }
      items.sort((a, b) => b.d - a.d);
      for (const it of items) {
        const dist = Math.max(0.05, it.d);
        if (it.sp) {
          const sp = it.sp;
          ctx.drawImage((sp.imgs || L.sprImgs)[shadeFor(dist)], sp.rx + Math.floor(it.u * sp.rw), sp.ry, 1, sp.rh, x, sp.top, 1, sp.sh);
        } else {
          const colH = WALL_H * proj / deff(dist), top = half - colH / 2;
          const tx = (it.tex % cols) * fw + Math.min(fw - 1, Math.floor(it.u * fw));
          const ty = Math.floor(it.tex / cols) * fh;
          if (L.outdoor) drawUpper(it.tex, it.u, dist, x, top, colH);
          ctx.drawImage(L.wallImgs[shadeFor(dist)], tx, ty, 1, fh, x, top, 1, colH);
          if (it.door) drawPanel(it, dist, x, top, colH);
        }
      }
    }
    drawHealthBars(sprites);
  }

  // Animation des monstres : 16 images par sprite (0-3 face, 4-7 profil, 8-11 dos ; 12-15
  // attaque). Un monstre qui vient de bouger joue son cycle de marche (8 images/s) ; sinon,
  // image d'animation lue en mémoire (sf), ou la première du groupe.
  const WALK_MS = 700, WALK_FPS = 8;
  const monTrack = new Map();                             // slot -> {x, y, until}
  function trackMonsters(list) {
    const now = performance.now();
    for (const m of list) {
      const t = monTrack.get(m.slot);
      if (t && (Math.abs(t.x - m.x) > 1e-3 || Math.abs(t.y - m.y) > 1e-3)) t.until = now + WALK_MS;
      monTrack.set(m.slot, { x: m.x, y: m.y, until: t ? t.until : 0 });
    }
  }
  function monsterStep(m) {
    const t = m && m.slot !== undefined ? monTrack.get(m.slot) : null;
    const now = performance.now();
    if (t && now < t.until) return Math.floor(now / (1000 / WALK_FPS)) % 4;
    return m && m.sf ? m.sf & 3 : 0;
  }
  window.lolMonStep = (slot) => monsterStep(liveMonsters.find((m) => m.slot === slot));   // débogage
  // débogage : apparence d'un monstre -> canvas (ex. lolMonsterLook("BANDIT", 0, { variant: 2, equip: [] }))
  window.lolMonsterLook = (name, pose, m) => {
    const look = L && L.sprites[name] ? monsterLook(name, L.sprites[name], pose, { sf: 0, ...m }) : null;
    if (!look) return null;
    const c = document.createElement("canvas"); c.width = look.rw; c.height = look.rh;
    c.getContext("2d").drawImage(look.imgs[0], look.rx, look.ry, look.rw, look.rh, 0, 0, look.rw, look.rh);
    return c;
  };
  function animating() {
    const now = performance.now();
    for (const t of monTrack.values()) if (now < t.until) return true;
    return false;
  }
  function spriteFrame(ids, pose, m) {
    if (ids.length >= 12) return ids[pose * 4 + monsterStep(m)] ?? ids[pose * 4] ?? ids[0];
    return ids[pose] ?? ids[0];                           // anciennes données : 3 poses
  }

  // Apparence propre à chaque monstre (LoLEngine::drawMonster) : variante de couleurs (drapeaux & 7,
  // table de l'image 16 du sprite) et jusqu'à 4 pièces d'équipement dessinées par-dessus le corps
  // (images 17 + jeu * 16 + image). L'image composée et ses niveaux d'ombre sont gardés en cache.
  // -> { imgs, rx, ry, rw, rh } (planche commune quand le monstre n'a ni variante ni équipement).
  // Monstres translucides (drapeau 0x800 du type, publié par le moteur ScummVM ; sous DOSBox, liste
  // de l'export) : planche translucide (export : tables LEVELnn.TLC, indices de transparence en
  // teinte + opacité), sans variantes de couleurs ni équipement.
  function ghostIds(name, m) {
    const g = L.spriteGhost && L.spriteGhost[name];
    if (!g) return null;
    const on = m.translucent !== undefined ? m.translucent : (L.spriteGhostAuto || []).includes(name);
    return on ? g : null;
  }
  function monsterLook(name, ids, pose, m) {
    const gh = L.ghostImgs ? ghostIds(name, m) : null;
    if (gh) {
      const engineFrame0 = m.frame !== undefined && m.frame !== 255 && gh.length >= 16;
      const gid = engineFrame0 ? gh[m.frame] ?? gh[0] : spriteFrame(gh, pose, m), gr = L.ghostRects[gid];
      if (gr) return { imgs: L.ghostImgs, rx: gr[0], ry: gr[1], rw: gr[2], rh: gr[3] };
    }
    // image dessinée par le jeu (version ScummVM : attaques, coups, marche), sinon choisie ici
    const engineFrame = m.frame !== undefined && m.frame !== 255 && ids.length >= 16;
    const id = engineFrame ? ids[m.frame] ?? ids[0] : spriteFrame(ids, pose, m), rect = L.spriteRects[id];
    if (!rect) return null;
    const [rx, ry, rw, rh] = rect;
    const pairs = m.variant && L.spriteVariants && L.spriteVariants[name] ? L.spriteVariants[name][m.variant] : null;
    const sets = L.spriteEquip && L.spriteEquip[name] && m.equip ? m.equip.filter((e) => e > 0 && e <= 4) : [];
    if (!pairs && !sets.length) return { imgs: L.sprImgs, rx, ry, rw, rh };
    const fi = engineFrame ? m.frame : ids.indexOf(id) >= 0 ? (ids.length >= 12 ? ids.indexOf(id, pose * 4) : ids.indexOf(id)) : 0;
    const key = `${id}|${fi}|${m.variant || 0}|${sets.join(",")}`;
    let imgs = L.compCache.get(key);
    if (!imgs) {
      const c = document.createElement("canvas");
      c.width = rw; c.height = rh;
      const g = c.getContext("2d");
      g.drawImage(L.sprSrc, rx, ry, rw, rh, 0, 0, rw, rh);
      if (pairs) {
        const map = new Map(pairs.map((p) => [p[0] << 16 | p[1] << 8 | p[2], p.slice(3)]));
        const d = g.getImageData(0, 0, rw, rh), px = d.data;
        for (let i = 0; i < px.length; i += 4) {
          if (!px[i + 3]) continue;
          const to = map.get(px[i] << 16 | px[i + 1] << 8 | px[i + 2]);
          if (to) { px[i] = to[0]; px[i + 1] = to[1]; px[i + 2] = to[2]; }
        }
        g.putImageData(d, 0, 0);
      }
      for (const e of sets) {
        const di = L.spriteEquip[name][e - 1][fi >= 0 ? fi : 0], r2 = di != null ? L.spriteRects[di] : null;
        if (r2) g.drawImage(L.sprSrc, r2[0], r2[1], r2[2], r2[3], 0, 0, r2[2], r2[3]);
      }
      imgs = darken(c, SHADES);
      L.compCache.set(key, imgs);
    }
    return { imgs, rx: 0, ry: 0, rw, rh };
  }

  // Projection des monstres à l'écran (choix face / profil / dos selon l'angle de vue).
  function projectSprites(dirX, dirY, planeX, planeY) {
    const out = [];
    const inv = 1 / (planeX * dirY - dirX * planeY);
    for (const it of floorItems()) {                    // objets au sol
      const dx = it.x - player.x, dy = it.y - player.y;
      const tx = inv * (dirY * dx - dirX * dy), tz = inv * (-planeY * dx + planeX * dy);
      if (tz < 0.15) continue;
      const [rx, ry, rw, rh] = it.rect;
      const scale = (WALL_H / 96) / tz * proj, sw = rw * scale, sh = rh * scale;
      const left = W / 2 * (1 + tx / tz) - sw / 2, top = H / 2 + pitch + (WALL_H / 2) / tz * proj - sh;
      out.push({ tz, rx, ry, rw, rh, sw, sh, left, top, mirror: false, imgs: FLOOR.imgs,
        x0: Math.max(0, Math.floor(left)), x1: Math.min(W - 1, Math.ceil(left + sw)) });
    }
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
      if (EMBED && m.frame !== undefined && m.frame !== 255) mirror = !!m.flip;
      const look = monsterLook(EMBED ? m.sprite : m.sprites[0], ids, pose, m);
      if (!look) continue;
      const { rx, ry, rw, rh, imgs } = look;
      const scale = (WALL_H / 96) / tz * proj;      // même échelle que les murs (96 px = hauteur)
      const sw = rw * scale, sh = rh * scale;
      const left = W / 2 * (1 + tx / tz) - sw / 2;
      const top = H / 2 + pitch + (WALL_H / 2) / tz * proj - sh;
      out.push({ tz, rx, ry, rw, rh, sw, sh, left, top, mirror, imgs, ghost: m.spawn === "event", hp: m.hp, hpMax: m.hpMax, mode: m.mode,
        x0: Math.max(0, Math.floor(left)), x1: Math.min(W - 1, Math.ceil(left + sw)) });
      const blood = EMBED ? bloodSprite(m, tz, left, top, sw, sh, scale) : null;
      if (blood) out.push(blood);
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
  if (EMBED) {
    view.addEventListener("pointerdown", (e) => {
      if (anim) { player.x = anim.x1; player.y = anim.y1; anim = null; turning = false; }
      if (e.button !== 0 || !L) return;
      looking = true; view.setPointerCapture(e.pointerId); view.style.cursor = "grabbing"; e.preventDefault();
    });
    view.addEventListener("pointermove", (e) => {
      if (!looking) return;
      const r = view.getBoundingClientRect();
      const s = Math.min(r.width / W, r.height / H);       // pixels écran par pixel du rendu
      lookYaw += e.movementX / s * (FOV / W);
      pitch = Math.max(-H * 0.6, Math.min(H * 0.6, pitch - e.movementY / s));
      player.a = gameA + lookYaw;
      dirty = true;
    });
    const endLook = () => {
      if (!looking) return;
      looking = false; lookYaw = 0; pitch = 0; player.a = gameA; view.style.cursor = "grab"; dirty = true;
    };
    view.addEventListener("pointerup", endLook);
    view.addEventListener("pointercancel", endLook);
    view.addEventListener("lostpointercapture", endLook);
  }
  levelSel.addEventListener("change", () => { loadLevel(+levelSel.value, false); levelSel.blur(); });
  addEventListener("resize", () => { resize(); dirty = true; });

  // Mode intégré : image fixe d'un lieu (auberge, échoppe…) à la place du rendu 3D.
  const sceneEl = document.getElementById("scene");
  addEventListener("message", (e) => {
    if (!EMBED || e.origin !== location.origin || !e.data || e.data.type !== "lol-scene") return;
    const { image, label } = e.data;
    if (image === null) { sceneEl.hidden = true; dirty = true; return; }
    const img = sceneEl.querySelector("img");
    if (image) { img.src = "data/scenes/" + image; img.hidden = false; } else img.hidden = true;
    document.getElementById("scene-label").textContent = label || (image ? "" : "Lieu");
    sceneEl.hidden = false;
  });

  // Mode intégré : choix de la perspective (bouton de la page du jeu).
  addEventListener("message", (e) => {
    if (!EMBED || e.origin !== location.origin || !e.data || e.data.type !== "lol-persp") return;
    persp = e.data.mode === "jeu" ? "jeu" : "reelle";
    try { localStorage.setItem("lol3d:persp", persp); } catch (err) {}
    dirty = true;
  });

  // Mode intégré : objets posés au sol (images du jeu : item_floor.png, tools/export_viewer.py)
  let liveItems = [];
  addEventListener("message", (e) => {
    if (!EMBED || e.origin !== location.origin || !e.data || e.data.type !== "lol-items") return;
    liveItems = e.data.list.map((i) => ({ ...i, level: e.data.level }));
    dirty = true;
  });
  const FLOOR = { rects: null, types: null, imgs: null, blood: null };
  // giclée d'un coup reçu, dessinée au centre du monstre décalé de hitOffsX/Y (drawMonster) ;
  // plus le coup est fort, moins elle est réduite (m.blood = 1 à 4)
  function bloodSprite(m, tz, left, top, sw, sh, scale) {
    if (!m.blood || !FLOOR.blood) return null;
    const r = FLOOR.rects[FLOOR.blood[m.bloodType & 3]];
    if (!r) return null;
    const k = scale / m.blood, bw = r[2] * k, bh = r[3] * k;
    const cx = left + sw / 2 + (m.hitX || 0) * scale, cy = top + sh / 2 + (m.hitY || 0) * scale;
    const l = cx - bw / 2;
    return { tz: tz - 0.01, rx: r[0], ry: r[1], rw: r[2], rh: r[3], sw: bw, sh: bh, left: l, top: cy - bh / 2, mirror: false,
      imgs: FLOOR.imgs, x0: Math.max(0, Math.floor(l)), x1: Math.min(W - 1, Math.ceil(l + bw)) };
  }
  Promise.all([fetch(`data/item_floor.json?v=${DATA_V}`).then((r) => r.json()), loadImage(`data/item_floor.png?v=${DATA_V}`)])
    .then(([d, img]) => { FLOOR.rects = d.rects; FLOOR.types = d.types; FLOOR.blood = d.blood || null; FLOOR.imgs = darken(img, SHADES); dirty = true; }, () => {});
  window.lolFloorItems = () => liveItems;   // débogage
  // objets visibles du niveau affiché -> [{ x, y, rect }]
  function floorItems() {
    if (!EMBED || !FLOOR.imgs || !L) return [];
    const out = [];
    for (const it of liveItems) {
      if (it.level !== L.level) continue;
      const k = FLOOR.types[it.type], rect = k >= 0 ? FLOOR.rects[k] : null;
      if (rect) out.push({ x: it.x, y: it.y, rect });
    }
    return out;
  }

  // Mode intégré : monstres à leurs positions réelles.
  let liveMonsters = [];
  addEventListener("message", (e) => {
    if (!EMBED || e.origin !== location.origin || !e.data || e.data.type !== "lol-monsters") return;
    liveMonsters = e.data.list.map((m) => ({ ...m, level: e.data.level }));
    trackMonsters(liveMonsters);
    dirty = true;
  });

  // Mode intégré : grille vivante du jeu (portes ouvertes ou fermées…), par niveau.
  const liveGrids = new Map();
  function applyLiveGrid() {
    const g = L && liveGrids.get(L.level);
    if (g && g.length === L.faces.length) {
      if (L.liveApplied && g !== L.faces) retargetDoors(L.faces, g);   // pas d'animation au premier état reçu
      L.faces = g; L.liveApplied = true; dirty = true;
    }
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
    let freshLevel = false;
    if (!L || L.level !== level) {
      freshLevel = true;
      if (loadingLevel === level) return;
      loadingLevel = level;
      try { await loadLevel(level, false); applyLiveGrid(); } finally { loadingLevel = null; }
    }
    const tx = x + 0.5, ty = y + 0.5, ta = DIR_ANGLE[dir & 3];
    const same = Math.abs(tx - (anim ? anim.x1 : player.x)) < 1e-6 && Math.abs(ty - (anim ? anim.y1 : player.y)) < 1e-6 && ta === gameA;
    if (same) return;
    let da = ta - (player.a - lookYaw);                 // plus court chemin angulaire
    da = Math.atan2(Math.sin(da), Math.cos(da));
    const step = Math.hypot(tx - player.x, ty - player.y);
    if (smooth && !freshLevel && step <= 1.5 && (step > 0.01 || Math.abs(da) > 0.01)) {
      anim = { x0: player.x, y0: player.y, a0: player.a - lookYaw, x1: tx, y1: ty, a1: player.a - lookYaw + da,
        t0: performance.now(), dur: Math.abs(da) > 0.01 ? ANIM_TURN : ANIM_MOVE };
    } else {
      anim = null; turning = false;
      player.x = tx; player.y = ty; player.a = ta + lookYaw;
    }
    gameA = ta;
    dirty = true;
  });

  // Mode intégré : capture de la vue depuis une case (illustration d'un lieu de la mini-carte).
  // Rendu synchrone à la position demandée puis retour à la position du groupe : rien ne s'affiche.
  addEventListener("message", (e) => {
    if (!EMBED || e.origin !== location.origin || !e.data || e.data.type !== "lol-snap") return;
    const { id, level, x, y, dir } = e.data;
    let url = null;
    if (L && L.level === level) {
      const saved = { x: player.x, y: player.y, a: player.a }, st = [turning, looking, pitch];
      player.x = x + 0.5; player.y = y + 0.5; player.a = DIR_ANGLE[dir & 3]; turning = false; looking = false; pitch = 0;
      try { render(); url = view.toDataURL("image/png"); } catch (err) { url = null; }
      Object.assign(player, saved); [turning, looking, pitch] = st;
      render();
    }
    e.source.postMessage({ type: "lol-snap", id, url }, location.origin);
  });

  let last = performance.now(), saveAt = 0, lastAnimFrame = -1;
  function frame(t) {
    const dt = Math.min(0.05, (t - last) / 1000); last = t;
    if (L && EMBED) {
      if (stepDoors(dt)) dirty = true;
      if (anim) {
        const k = Math.min(1, (t - anim.t0) / anim.dur), e = k * k * (3 - 2 * k);   // départ et arrivée en douceur
        player.x = anim.x0 + (anim.x1 - anim.x0) * e;
        player.y = anim.y0 + (anim.y1 - anim.y0) * e;
        player.a = anim.a0 + (anim.a1 - anim.a0) * e + lookYaw;
        turning = Math.abs(anim.a1 - anim.a0) > 0.01 && k < 1;
        if (k >= 1) { anim = null; turning = false; player.a = gameA + lookYaw; }
        dirty = true;
      }
      if (animating()) {                                  // cycle de marche : rendu à chaque nouvelle image
        const f = Math.floor(t / (1000 / WALK_FPS));
        if (f !== lastAnimFrame) { lastAnimFrame = f; dirty = true; }
      }
      if (dirty) { render(); updateHud(); dirty = false; }
    } else if (L) {
      update(dt); render(); drawMap(); updateHud();
      if (t > saveAt) { store.set("pos", { level: L.level, x: player.x, y: player.y, a: player.a }); saveAt = t + 1000; }
    }
    requestAnimationFrame(frame);
  }

  (async () => {
    resize();
    const levels = await fetch(`data/levels.json?v=${DATA_V}`).then((r) => r.json());
    for (const l of levels) {
      const o = document.createElement("option");
      o.value = l.level; o.textContent = `${l.level}. ${l.frName ? l.frName + " (" + l.name + ")" : l.name}`;
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
      view.style.cursor = "grab";
      view.title = "Maintenir le clic gauche et glisser pour regarder autour";
    }
    requestAnimationFrame(frame);
  })();
})();
