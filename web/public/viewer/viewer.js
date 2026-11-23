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
  const DATA_V = "20261124c";                      // version des données exportées (cache du navigateur)
  const EMBED = new URLSearchParams(location.search).get("embed") === "1";
  if (EMBED) { FOV = 2 * Math.atan(1.375); document.documentElement.classList.add("embed"); }
  let dirty = true;
  // Vue libre (mode intégré) : clic gauche maintenu + glisser = tourner la tête ; relâcher =
  // retour au point de vue du jeu. pitch = décalage vertical de l'horizon, en pixels du rendu.
  let looking = false, lookYaw = 0, pitch = 0, gameA = 0;
  // Transitions douces (mode intégré) : un pas ou un quart de tour du jeu est animé.
  let anim = null, turning = false;                     // {x0, y0, a0, x1, y1, a1, t0, dur}
  const ANIM_MOVE = 220, ANIM_TURN = 200;               // durées en ms
  const view = document.getElementById("view");
  let ctx = view.getContext("2d");      // remplacé le temps du rendu d'un portail (renderPortal)
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
  // façades de plusieurs étages (murs hauts de la ville d'Yvel, arbres de la forêt : le fond
  // d'origine les montre plus hauts que la vue). storeys = hauteur en étages.
  // crown : sommet des arbres repris du fond d'origine (voir setupOutdoor).
  // fogCeil : plafond de brume, en hauteurs de mur depuis le sol (Yvel : le jeu ne montre jamais
  // les façades au-delà du haut connu du premier étage, docs/reverse-engineering.md § 9.3g) ;
  // au-dessus, tout se fond dans la brume, sur FOG_FADE hauteur de mur.
  const OUTDOOR = { YVEL1: { storeys: 3, fogCeil: 1 + 65 / 96 }, FOREST1: { storeys: 2, crown: true } };
  const FOG_FADE = 0.3;
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
    // Cimes (forêt) : dans le jeu, le mur de face à 3 cases (6 × 5 tuiles, x 64-112, lignes
    // 24-64) se prolonge vers le haut dans le fond d'origine, jusqu'au ciel (couleur unie de
    // la ligne 0). Ce bandeau (lignes 0-23 au-dessus de ce mur), ciel rendu transparent, sert de
    // sommet aux arbres : il mesure 24/40 de la hauteur d'un mur.
    L.crownImgs = null;
    if (L.outdoor.crown && bg) {
      const b = pixels(bg), cnt = new Map();
      for (let x = 0; x < b.w; x++) cnt.set(b.px[x], (cnt.get(b.px[x]) || 0) + 1);
      const sky = [...cnt].sort((a, c) => c[1] - a[1])[0][0];
      L.sky = [sky];
      const c = document.createElement("canvas");
      c.width = b.w; c.height = CROWN.h;
      const g = c.getContext("2d"), id = g.createImageData(b.w, CROWN.h), out = new Uint32Array(id.data.buffer);
      for (let y = 0; y < CROWN.h; y++) for (let x = 0; x < b.w; x++) {
        const v = b.px[y * b.w + x];
        out[y * b.w + x] = v === sky ? 0 : v;
      }
      L.crownW = b.w;
      g.putImageData(id, 0, 0);
      L.crownImgs = darken(c, SHADES);
    }
    // brume : couleur moyenne du ciel, et un dégradé (opaque en haut, transparent en bas)
    L.fogFade = null;
    if (L.outdoor.fogCeil) {
      let r = 0, g = 0, bl = 0;
      for (const c of L.sky) { r += c & 255; g += (c >> 8) & 255; bl += (c >> 16) & 255; }
      const n = L.sky.length, c = document.createElement("canvas");
      c.width = 1; c.height = 32;
      const gx = c.getContext("2d"), gr = gx.createLinearGradient(0, 0, 0, 32);
      const rgb = `${Math.round(r / n)},${Math.round(g / n)},${Math.round(bl / n)}`;
      gr.addColorStop(0, `rgba(${rgb},1)`); gr.addColorStop(1, `rgba(${rgb},0)`);
      gx.fillStyle = gr; gx.fillRect(0, 0, 1, 32);
      L.fogFade = c;
    }
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
    L.canopy = L.outdoor.crown ? buildForest(px, W2, plain) : null;
  }

  // Forêt : arbres au-dessus du mur générés de façon fractale, dans une bande de FOREST.faces
  // cases de large (raccordée bout à bout), à l'échelle des pixels du mur :
  // - couleurs : écorces (r > g, r > b) et feuillages (le reste, hors noirs) du haut de la texture ;
  // - fond : masse de feuillage sombre, sommet en bruit fractal (fbm périodique, 5 octaves) ;
  // - troncs : partent des pieds de troncs repérés dans les lignes 0-3 de la texture (raccord au
  //   mur), puis se ramifient récursivement (2 ou 3 branches, angle ±0,25-0,6 rad, longueur
  //   × 0,7-0,85, largeur × 0,65), chaque arbre de chaque case avec son propre tirage ;
  // - touffes de feuillage irrégulières au bout des branches et le long des plus fines.
  // Les 3 lignes du bas reprennent les lignes 0-2 du mur (en miroir) pour le raccord.
  const FOREST = { faces: 16, h: 150, depth: 5 };
  function buildForest(px, W2, texs) {
    const fw = L.faceW, fh = L.faceH, cols = L.atlasCols, NF = FOREST.faces, SW = fw * NF, HT = FOREST.h;
    if (!texs.length) return null;
    const c = document.createElement("canvas");
    c.width = SW; c.height = HT * texs.length;
    const g = c.getContext("2d"), id = g.createImageData(SW, c.height), out = new Uint32Array(id.data.buffer);
    const lum = (p) => (p & 255) * 0.3 + ((p >> 8) & 255) * 0.59 + ((p >> 16) & 255) * 0.11;
    texs.forEach((tex, ti) => {
      const x0 = (tex % cols) * fw, y0 = Math.floor(tex / cols) * fh, at = (x, y) => px[(y0 + y) * W2 + x0 + x];
      const isBark = (p) => { const r = p & 255, gg = (p >> 8) & 255, bb = (p >> 16) & 255; return r > gg + 15 && r > bb + 15; };
      const bark = new Map(), leaf = new Map(), dark = new Map();
      for (let y = 0; y < 48; y++) for (let x = 0; x < fw; x++) {
        const p = at(x, y), m = lum(p) < 14 ? dark : isBark(p) ? bark : leaf;
        m.set(p, (m.get(p) || 0) + 1);
      }
      const pal = (m) => [...m].filter((e) => e[1] > 4).map((e) => e[0]).sort((p, q) => lum(p) - lum(q));
      const B = pal(bark), Lf = pal(leaf), D = pal(dark);
      if (!B.length || !Lf.length) return;
      if (!D.length) D.push(0xff000000);
      let seed = (tex * 2654435761 + 12345) >>> 0;
      const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const o = ti * HT * SW;
      const put = (x, y, p) => { y = Math.round(y); if (y < 0 || y >= HT) return; x = ((Math.round(x) % SW) + SW) % SW; out[o + y * SW + x] = p; };
      const pick = (P, t) => P[Math.max(0, Math.min(P.length - 1, Math.round(t * (P.length - 1))))];
      // fbm périodique sur la bande
      const lat = (i, oc) => hash01(((i % (NF * (2 << oc))) + NF * (2 << oc)) % (NF * (2 << oc)), tex * 31 + oc);
      const fbm = (x) => {
        let v = 0, amp = 0.5, norm = 0;
        for (let oc = 0; oc < 5; oc++) {
          const f = x / SW * NF * (2 << oc), i = Math.floor(f), t = f - i, k = t * t * (3 - 2 * t);
          v += amp * (lat(i, oc) * (1 - k) + lat(i + 1, oc) * k); norm += amp; amp *= 0.5;
        }
        return v / norm;
      };
      // 1. fond : feuillage sombre
      for (let x = 0; x < SW; x++) {
        const top = Math.round(HT * (1 - (0.35 + 0.45 * fbm(x))));
        for (let y = top; y < HT; y++) {
          const r = rnd(), edge = y - top < 4;
          if (edge && r < 0.35) continue;
          put(x, y, r < 0.55 ? pick(D, rnd()) : r < 0.9 || !edge ? pick(Lf, rnd() * 0.3) : pick(Lf, 0.3 + rnd() * 0.4));
        }
      }
      // 2. touffe de feuillage
      const tuft = (cx, cy, rad) => {
        const lob = [rnd(), rnd(), rnd(), rnd()].map((v) => 0.7 + 0.5 * v), ph = rnd() * 6.3;
        for (let dy = -rad * 1.3; dy <= rad; dy++) for (let dx = -rad * 1.5; dx <= rad * 1.5; dx++) {
          const ang = Math.atan2(dy, dx), rr = rad * lob[Math.floor(((ang + ph + 12.6) % 6.283) / 1.571) % 4];
          const d = Math.hypot(dx / 1.2, dy) / rr;
          if (d > 1 || (d > 0.75 && rnd() < 0.5)) continue;
          const light = Math.max(0, Math.min(1, 0.75 - (dy / rad) * 0.35 - d * 0.35 + (rnd() - 0.5) * 0.5));
          put(cx + dx, cy + dy, rnd() < 0.12 ? pick(D, rnd()) : pick(Lf, light));
        }
      };
      // 3. branches récursives
      const branch = (x, y, a, len, w, depth) => {
        let px2 = x, py = y;
        for (let t = 0; t < len; t++) {
          a += (rnd() - 0.5) * 0.12;
          px2 += Math.sin(a); py -= Math.cos(a);
          const hw = w / 2;
          for (let k = -hw; k <= hw; k++) {
            const r = (k + hw) / Math.max(1, w), light = Math.max(0, 1 - Math.abs(r - 0.35) * 2.2) * 0.85 + (rnd() - 0.5) * 0.25;
            put(px2 + k, py, pick(B, light));
          }
          if (depth <= 2 && w < 4 && rnd() < 0.05) tuft(px2 + (rnd() - 0.5) * 6, py, 3 + rnd() * 3);
        }
        if (depth === 0 || w < 1.5) { tuft(px2, py, 5 + rnd() * 6); return; }
        const n = rnd() < 0.3 ? 3 : 2;
        for (let i = 0; i < n; i++) {
          const da = (0.25 + rnd() * 0.35) * (n === 2 ? (i ? 1 : -1) : i - 1);
          branch(px2, py, a + da, len * (0.7 + rnd() * 0.15), Math.max(1, w * 0.65), depth - 1);
        }
      };
      // pieds de troncs : suites d'écorce d'au moins 3 px, en majorité sur les lignes 0-3
      const bases = [];
      for (let x = 0, run = 0; x <= fw; x++) {
        const bk = x < fw && [0, 1, 2, 3].filter((y) => isBark(at(x, y))).length >= 3;
        if (bk) run++;
        else { if (run >= 3) bases.push([x - run / 2, run]); run = 0; }
      }
      for (let f = 0; f < NF; f++) for (const [bx, bw] of bases)
        branch(f * fw + bx, HT, (rnd() - 0.5) * 0.15, 18 + rnd() * 18, Math.min(14, bw), FOREST.depth - (rnd() < 0.3 ? 1 : 0));
      // 4. raccord au mur : lignes 0-2 de la texture, en miroir
      for (let k = 0; k < 3; k++) for (let x = 0; x < SW; x++) out[o + (HT - 1 - k) * SW + x] = at(x % fw, k);
    });
    g.putImageData(id, 0, 0);
    return { imgs: darken(c, SHADES), index: new Map(texs.map((t, i) => [t, i])), SW, HT };
  }
  // bandeau du fond (toute la largeur) : 48 px pour une face, 24 px de haut pour un mur de 40
  const CROWN = { w: 48, h: 24, wall: 40 };
  // Forêt : étage tiré au hasard, mais toujours le même au même endroit. Le long d'une rangée
  // de faces (pos = coordonnée du monde le long du mur, line = la rangée), un bruit continu
  // donne la hauteur des troncs au-dessus du mur (TRUNK, en étages) et celle de la cime
  // (CROWN_K) ; la cime est lue en continu dans le bandeau, en aller-retour (pas de raccord),
  // à partir d'un point propre à la rangée. Lisière irrégulière, sans marche entre deux faces.
  const TRUNK = [0.3, 1.5], CROWN_K = [0.8, 1.35];   // sans arbre synthétisé (bandeau du fond)
  const hash01 = (i, seed) => {
    let h = Math.imul(i ^ Math.imul(seed, 0x27d4eb2d), 0x9e3779b1);
    h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
  };
  const vnoise = (x, seed) => {                    // bruit de valeurs lissé, 1 valeur par unité
    const i = Math.floor(x), t = x - i, k = t * t * (3 - 2 * t);
    return hash01(i, seed) * (1 - k) + hash01(i + 1, seed) * k;
  };
  const forestNoise = (pos, line, o) => 0.65 * vnoise(pos * 0.9 + o, line) + 0.35 * vnoise(pos * 2.3 + o, line + 7919);
  const skyAt = (y, hz) => L.sky[Math.max(0, Math.min(L.sky.length - 1, Math.floor(BG_HORIZON - (hz - y) / Math.max(1, hz) * BG_HORIZON)))];
  // étages au-dessus d'une colonne de mur (de bas en haut), même assombrissement que la face
  function drawUpper(tex, u, dist, x, top, colH, pos, line) {
    const S = L.outdoor.storeys, fw = L.faceW, fh = L.faceH, cols = L.atlasCols;
    const ut = L.upperOf(tex), sh = fh - FOOT, h = colH * sh / fh;
    const tx = (ut % cols) * fw + Math.min(fw - 1, Math.floor(u * fw)), ty = Math.floor(ut / cols) * fh;
    const img = L.wallImgs[shadeFor(dist)];
    // plafond de brume : rien n'est dessiné au-dessus (le ciel y est la brume)
    const fogY = L.fogFade ? top - colH * (L.outdoor.fogCeil - 1) : -Infinity;
    const part = (im, sx, sy, sh2, y, h2) => {          // image coupée à la ligne fogY
      if (y + h2 <= fogY || y + h2 <= 0) return;
      if (y < fogY) { const cut = (fogY - y) / h2; sy += cut * sh2; sh2 -= cut * sh2; h2 -= fogY - y; y = fogY; }
      ctx.drawImage(im, sx, sy, 1, sh2, x, y, 1, h2 + 0.5);
    };
    if (L.crownImgs && pos !== undefined) {         // forêt : hauteurs tirées au hasard
      const tr = TRUNK[0] + (TRUNK[1] - TRUNK[0]) * forestNoise(pos, line, 0);
      const ck = CROWN_K[0] + (CROWN_K[1] - CROWN_K[0]) * forestNoise(pos, line, 101.5);
      const cp = L.canopy, ti = cp && cp.index.get(ut);
      if (ti !== undefined) {                         // arbres fractals (buildForest)
        // colonne de la bande : position le long du mur (pixels du mur), décalée d'un nombre entier
        // de cases propre à la rangée ; bande lue à l'envers quand la face l'est (u = 1 − frac)
        const NF = FOREST.faces, SW = cp.SW, HT = cp.HT;
        const flip = (line & 7) === FACE_E || (line & 7) === FACE_N;   // line = (case << 3) | face
        let col = ((Math.floor(pos * fw) + Math.floor(hash01(line, 5) * NF) * fw) % SW + SW) % SW;
        if (flip) col = SW - 1 - col;
        const hh = HT / sh * h;
        part(cp.imgs[shadeFor(dist)], col, ti * HT, HT, top - hh, hh);
        return;
      } else for (let k = 0, rest = tr; rest > 0 && top - k * h > 0; k++, rest--) {
        const f = Math.min(1, rest);
        part(img, tx, ty + sh * (1 - f), sh * f, top - k * h - f * h, f * h);
      }
      const ch = colH * CROWN.h / CROWN.wall * ck, y0 = top - tr * h - ch;
      if (y0 + ch > 0) {
        const n = L.crownW, m = (((pos * CROWN.w + hash01(line, 3) * 2 * n) % (2 * n)) + 2 * n) % (2 * n);
        const cx = Math.min(n - 1, Math.floor(m < n ? m : 2 * n - 1 - m));
        ctx.drawImage(L.crownImgs[shadeFor(dist)], cx, 0, 1, CROWN.h, x, y0, 1, ch + 0.5);
      }
      return;
    }
    for (let k = 1; k < S && top - (k - 1) * h > Math.max(0, fogY); k++) part(img, tx, ty, sh, top - k * h, h);
    // premier étage vu dans le jeu (décorations au-dessus du mur) : par-dessus l'étage répété,
    // transparent là où le jeu ne le montre jamais (haut de l'étage)
    const up = L.upperImgs ? L.upperByTex.get(tex) : undefined;
    if (up !== undefined) {
      const ux = (up % cols) * fw + Math.min(fw - 1, Math.floor(u * fw)), uy = Math.floor(up / cols) * fh;
      if (top > 0) part(L.upperImgs[shadeFor(dist)], ux, uy, fh, top - colH, colH);
    }
    if (L.fogFade && fogY + colH * FOG_FADE > 0) ctx.drawImage(L.fogFade, 0, 0, 1, 32, x, fogY, 1, colH * FOG_FADE);
    if (L.crownImgs) {                              // cime au-dessus du dernier étage
      const ch = colH * CROWN.h / CROWN.wall, y0 = top - (S - 1) * h - ch;
      if (y0 + ch > 0) ctx.drawImage(L.crownImgs[shadeFor(dist)], Math.min(L.crownW - 1, Math.floor(u * CROWN.w)), 0, 1, CROWN.h, x, y0, 1, ch + 0.5);
    }
  }

  // Données et images d'un niveau, sans en faire le niveau affiché (aussi pour les portails)
  async function fetchLevel(n) {
    const nn = String(n).padStart(2, "0");
    const [data, walls, spr, floor, ceil, bg, wang, upper] = await Promise.all([
      fetch(`data/level${nn}.json?v=${DATA_V}`).then((r) => r.json()),
      loadImage(`data/level${nn}_walls.png?v=${DATA_V}`),
      loadImage(`data/level${nn}_spr.png?v=${DATA_V}`),
      loadImage(`data/level${nn}_floor.png?v=${DATA_V}`),
      loadImage(`data/level${nn}_ceil.png?v=${DATA_V}`),
      loadImage(`data/level${nn}_bg.png?v=${DATA_V}`).catch(() => null),
      loadImage(`data/level${nn}_floor_wang.png?v=${DATA_V}`).catch(() => null),
      loadImage(`data/level${nn}_upper.png?v=${DATA_V}`).catch(() => null),
    ]);
    const V = data;
    V.wallImgs = darken(walls, SHADES);
    V.floorTex = pixels(floor);
    V.ceilTex = pixels(ceil);
    V.wangTex = data.floorWang && wang ? pixels(wang) : null;
    V.sprImgs = darken(spr, SHADES);
    V.sprSrc = spr; V.compCache = new Map();
    V.wallInfo = [];
    for (const [id, w] of Object.entries(V.walls)) V.wallInfo[+id] = w;
    V.outdoor = OUTDOOR[V.tileset] || null;
    if (V.outdoor) {                                     // buildForest lit le niveau dans L (appel synchrone)
      const prevL = L; L = V;
      try { setupOutdoor(V, walls, bg); } finally { L = prevL; }
    }
    // étage reconstitué des vues lointaines (docs/reverse-engineering.md § 9.3g), par texture
    V.upperImgs = upper && V.outdoor ? darken(upper, SHADES) : null;
    V.upperByTex = new Map();
    for (const w of Object.values(V.walls)) if (w.upper !== undefined && w.tex >= 0) V.upperByTex.set(w.tex, w.upper);
    V.wallsSrc = walls;
    return V;
  }
  async function loadLevel(n, keepPos) {
    const data = await fetchLevel(n), nn = String(n).padStart(2, "0");
    L = data;
    setupPortals(L);
    buildDoorPanels(L.wallsSrc);
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
  // Objet posé au centre d'une case (fontaine, statue…) : même décor seul sur ses 4 faces (walls[id].free).
  // Le jeu le peint sur la face tournée vers le groupe ; la perspective réelle le dessine au centre
  // de la case, toujours de face, pour ne pas le voir deux fois en diagonale ni trop près.
  function freeAt(cx, cy) {
    if (!inside(cx, cy)) return null;
    const i = (cy * 32 + cx) * 4, id = L.faces[i];
    if (L.faces[i + 1] !== id || L.faces[i + 2] !== id || L.faces[i + 3] !== id) return null;
    const w = info(id);
    return w && w.free ? w : null;
  }
  let freeCache = { faces: null, list: [] };
  function freeObjects() {
    if (freeCache.faces !== L.faces) {
      const list = [];
      for (let cy = 0; cy < 32; cy++) for (let cx = 0; cx < 32; cx++) if (freeAt(cx, cy)) list.push([cx, cy]);
      freeCache = { faces: L.faces, list };
    }
    return freeCache.list;
  }

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
    const shown = inPortal ? null : doorShown.get((cy * 32 + cx) * 4 + f);
    if (shown && w.door) {
      const s = doorSeries(id), closed = s && info(s.start);
      if (closed && closed.panel && closed.openTex !== undefined) {
        if (shown.q >= 0.999) return { tex: closed.openTex, opaque: false, block: false };
        return { tex: closed.openTex, opaque: false, block: shown.q < 0.001, panel: closed.panel, panelTex: closed.tex, q: shown.q };
      }
    }
    if (w.door && !inPortal && openDoors.has(cy * 32 + cx)) return w.openTex !== undefined ? { tex: w.openTex, opaque: false, block: false } : null;
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
  // sol peint du jeu (docs/reverse-engineering.md § 9.3c, KEEP) : point de fuite latéral hx,
  // horizon de profondeur hk, K = ak / (y − hk) unités, 0,75 px par unité et par ligne, 3,1 unités par case
  const GAME_FLOOR = { hx: 39, hk: 34.5, ak: 354.25, px: 0.75, upc: 3.1 };
  const zOfDeff = (d) => (d <= 0.5 ? d : 0.5 + Math.log(d / 0.5) / Math.log(KSTEP));

  // --- Portails : passages vers un autre niveau et lieux en image -----------------------------
  // Sortie vers un autre niveau (L.exits : case de sortie -> case d'arrivée) : derrière la porte, la
  // vue montre le niveau d'arrivée. Rendu en deux passes : le niveau d'arrivée est d'abord dessiné
  // (même perspective, position du groupe décalée de la sortie à l'arrivée) sur un canevas à part,
  // puis la passe normale, arrivée à la case de sortie, y recopie la colonne de l'ouverture. Dans
  // la passe du portail, les faces sont ignorées jusqu'à la case d'arrivée (porte et décor de l'autre
  // côté). Lieu en image (boutique, bureau : case de la scène et case du lieu) : obscurité derrière
  // la porte au lieu du bout de couloir vide de la carte. Rien de tout cela quand le groupe est dedans.
  let inPortal = false, portalSkip = null, portalDrawn = null;
  const portalCanvas = document.createElement("canvas"), portalLevels = new Map();
  function setupPortals(V) {
    V.portalCells = new Map();
    for (const e of V.exits || []) {
      const i = e.y * 32 + e.x;
      V.portalCells.set(i, { kind: "level", level: e.level, ex: e.x, ey: e.y, tx: e.tx, ty: e.ty, region: new Set([i]) });
    }
    const scenes = V.scenes || {};
    for (const l of V.labels || []) {
      if (l.x2 == null) continue;
      const a = l.y * 32 + l.x, b = l.y2 * 32 + l.x2;
      if (!scenes[a] && !scenes[b]) continue;
      const P = { kind: "void", region: new Set([a, b]), image: scenes[b] || scenes[a] };
      for (const i of P.region) if (!V.portalCells.has(i)) V.portalCells.set(i, P);
    }
  }
  function portalAt(cx, cy, pcx, pcy) {
    if (inPortal || !L.portalCells) return null;
    const P = L.portalCells.get(cy * 32 + cx);
    if (!P || P.region.has(pcy * 32 + pcx) || P.region.has(Math.floor(player.y) * 32 + Math.floor(player.x))) return null;
    return P;
  }
  function renderPortal() {
    portalDrawn = null;
    if (!L.portalCells) return;
    let P = null, best = 1e9;
    for (const q of L.portalCells.values()) {
      if (q.kind !== "level") continue;
      const d = Math.hypot(q.ex + 0.5 - player.x, q.ey + 0.5 - player.y);
      if (d < best && d < 12) { best = d; P = q; }
    }
    if (!P || P.region.has(Math.floor(player.y) * 32 + Math.floor(player.x))) return;
    const V = portalLevels.get(P.level);
    if (!V) {
      portalLevels.set(P.level, "loading");
      fetchLevel(P.level).then((lv) => { portalLevels.set(P.level, lv); dirty = true; }, () => portalLevels.delete(P.level));
      return;
    }
    if (V === "loading") return;
    if (portalCanvas.width !== W || portalCanvas.height !== H) { portalCanvas.width = W; portalCanvas.height = H; }
    const saved = { L, x: player.x, y: player.y, ctx, openDoors };
    L = V; player.x += P.tx - P.ex; player.y += P.ty - P.ey; ctx = portalCanvas.getContext("2d"); openDoors = new Set();
    inPortal = true; portalSkip = { x: P.tx, y: P.ty };
    try { render(); portalDrawn = P; }
    finally { L = saved.L; player.x = saved.x; player.y = saved.y; ctx = saved.ctx; openDoors = saved.openDoors; inPortal = false; portalSkip = null; }
  }
  // colonne x de l'ouverture d'un portail (top, hauteur colH à l'écran, u : position dans la face).
  // Lieu en image : l'image du lieu (celle que le jeu montre en y entrant), assombrie, dans l'ouverture.
  const sceneImgs = new Map();
  function sceneImg(name) {
    let im = sceneImgs.get(name);
    if (!im) { im = new Image(); im.onload = () => { dirty = true; }; im.src = "data/scenes/" + name; sceneImgs.set(name, im); }
    return im.complete && im.naturalWidth ? im : null;
  }
  function drawPortalColumn(P, x, top, colH, u) {
    if (P.kind === "level" && portalDrawn === P) { ctx.drawImage(portalCanvas, x, top, 1, colH, x, top, 1, colH); return; }
    ctx.fillStyle = "#050403"; ctx.fillRect(x, top, 1, colH);
    const im = P.image && sceneImg(P.image);
    if (!im || u === undefined) return;
    ctx.globalAlpha = 0.8;
    ctx.drawImage(im, Math.min(im.naturalWidth - 1, Math.floor(u * im.naturalWidth)), 0, 1, im.naturalHeight, x, top, 1, colH);
    ctx.globalAlpha = 1;
  }

  function render() {
    if (!inPortal) renderPortal();
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
      let nearestOpaque = 1e9, skipping = !!portalSkip;
      for (let s = 0; s < MAX_STEPS; s++) {
        let side;
        const pcx = cx, pcy = cy;
        if (sdx < sdy) { sdx += ddx; cx += sx; side = 0; } else { sdy += ddy; cy += sy; side = 1; }
        if (!inside(cx, cy)) break;
        if (skipping) { if (cx === portalSkip.x && cy === portalSkip.y) skipping = false; continue; }   // passe du portail
        const f = side === 0 ? (sx > 0 ? FACE_W : FACE_E) : (sy > 0 ? FACE_N : FACE_S);
        if (freeAt(cx, cy)) continue;                       // dessiné comme un sprite (projectSprites)
        const P = portalAt(cx, cy, pcx, pcy);
        const t = texFor(cx, cy, f);
        if (!t && !P) continue;
        const dist = side === 0 ? sdx - ddx : sdy - ddy;
        if (P && !(t && t.block && (t.opaque || t.tex < 0))) {   // porte ouverte d'une sortie ou d'un lieu en image
          let u = side === 0 ? player.y + dist * ry : player.x + dist * rx;
          u -= Math.floor(u);
          if (f === FACE_E || f === FACE_N) u = 1 - u;
          if (t && t.tex >= 0) items.push({ d: dist, tex: t.tex, u, pos: 0, line: 0, door: t.panel ? t : null });
          items.push({ d: dist + 1e-3, portal: P, u });
          nearestOpaque = dist; break;
        }
        if (!t) continue;
        let u = side === 0 ? player.y + dist * ry : player.x + dist * rx;
        const pos = u, line = side === 0 ? (cx << 3) | f : (cy << 3) | f;   // rangée de faces
        u -= Math.floor(u);
        // sens de lecture de la texture vu depuis l'extérieur de la face
        if (f === FACE_E || f === FACE_N) u = 1 - u;
        if (t.tex >= 0) items.push({ d: dist, tex: t.tex, u, pos, line, door: t.panel ? t : null });
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
        if (it.portal) { const colH = WALL_H / dist * proj; drawPortalColumn(it.portal, x, H / 2 + pitch - colH / 2, colH, it.u); continue; }
        if (it.sp) {
          const sp = it.sp;
          if (sp.ghost) ctx.globalAlpha = sp.ghost === true ? 0.55 : sp.ghost;   // apparition sur événement, flaque
          ctx.drawImage((sp.imgs || L.sprImgs)[shadeFor(dist)], sp.rx + Math.floor(it.u * sp.rw), sp.ry, 1, sp.rh,
            x, sp.top, 1, sp.sh);
          ctx.globalAlpha = 1;
        } else {
          const colH = WALL_H / dist * proj;
          const top = H / 2 + pitch - colH / 2;
          const tx = (it.tex % cols) * fw + Math.min(fw - 1, Math.floor(it.u * fw));
          const ty = Math.floor(it.tex / cols) * fh;
          if (L.outdoor) drawUpper(it.tex, it.u, dist, x, top, colH, it.pos, it.line);
          ctx.drawImage(L.wallImgs[shadeFor(dist)], tx, ty, 1, fh, x, top, 1, colH);
          if (it.door) drawPanel(it, dist, x, top, colH);
        }
      }
    }
    if (inPortal) return;
    drawHealthBars(sprites);
    drawSwitch();
    pickables = sprites.filter((sp) => sp.item);
  }
  // Barre de vie au-dessus de chaque monstre visible (version ScummVM : points de vie actuels du
  // monstre / maximum de son type, publiés par le moteur). Seulement pour les monstres proches
  // (à moins de HP_BAR_DIST cases devant le groupe : la case voisine et la suivante). Masquée
  // si le centre du monstre est derrière un mur (zbuf) ou s'il est mourant (mode >= 13).
  const HP_BAR_DIST = 2.5;
  // Interrupteurs (docs/reverse-engineering.md § 9.6) : le jeu n'actionne que le mur juste devant
  // le groupe (clickedWall), selon son type spécial (1 décor à script, 2/3 levier, 4 script seul,
  // 5 porte). La zone cliquable de ce mur (walls[id].hot, pixels de la face) est surlignée ; un
  // clic dessus demande à la page de cliquer le mur dans le jeu (message « lol-clickwall »).
  let switchHover = false;
  // Objets au sol dessinés à la dernière image (vue intégrée) : un clic dessus les ramasse dans le
  // sac (commande « pickup » du moteur : case du groupe ou case devant lui, comme dans le jeu)
  let pickables = [], hoverType = -1;
  window.lolPickables = () => pickables.map((sp) => ({ type: sp.item.type, x: sp.item.x, y: sp.item.y, left: sp.left, top: sp.top, sw: sp.sw, sh: sp.sh }));   // débogage
  function itemAt(e) {
    const r = view.getBoundingClientRect();
    const px = (e.clientX - r.left) * W / r.width, py = (e.clientY - r.top) * H / r.height;
    let best = null;
    for (const sp of pickables) {
      if (px < sp.left || px > sp.left + sp.sw || py < sp.top - 2 || py > sp.top + sp.sh + 2) continue;
      const col = Math.max(0, Math.min(W - 1, Math.floor(px)));
      if (zbuf[col] <= sp.tz) continue;                 // derrière un mur
      if (!best || sp.tz < best.tz) best = sp;
    }
    return best;
  }
  // seule la page ScummVM peut faire cliquer le jeu (commande du moteur modifié)
  const canClickWalls = () => { try { return parent.LOL_ENGINE === "scummvm"; } catch (e) { return false; } };
  function facingSwitch() {
    if (!EMBED || !L || anim || looking || !canClickWalls()) return null;
    const d = ((Math.round((gameA + Math.PI / 2) / (Math.PI / 2)) % 4) + 4) % 4;   // 0 N, 1 E, 2 S, 3 O
    const ax = Math.floor(player.x) + [0, 1, 0, -1][d], ay = Math.floor(player.y) + [-1, 0, 1, 0][d];
    if (ax < 0 || ay < 0 || ax > 31 || ay > 31) return null;
    const w = info(face(ax, ay, (d + 2) % 4));
    if (!w || !w.special || !w.hot) return null;
    // mur à 0,5 case : même échelle dans les deux perspectives (deff(0,5) = 0,5), centré
    const z = persp !== "jeu" && freeAt(ax, ay) ? 1 : 0.5;     // objet au centre de la case (perspective réelle)
    const fw = L.faceW, fh = L.faceH, cw = proj / z, colH = WALL_H / z * proj;
    const left = W / 2 - cw / 2, top = H / 2 + pitch - colH / 2;
    const [x0, y0, x1, y1] = w.hot;
    return { special: w.special, x: left + x0 / fw * cw, y: top + y0 / fh * colH, w: (x1 - x0) / fw * cw, h: (y1 - y0) / fh * colH };
  }
  // La page du jeu actionne l'interrupteur devant le groupe avec Espace : elle apprend d'ici s'il y en a un.
  let switchAheadSent = false;
  function drawSwitch() {
    const sw = facingSwitch();
    const ahead = !!sw || (looking && switchAheadSent);       // regarder autour ne le fait pas oublier
    if (EMBED && ahead !== switchAheadSent) {
      switchAheadSent = ahead;
      try { parent.postMessage({ type: "lol-switch-ahead", on: ahead }, location.origin); } catch (e) {}
    }
    if (!sw) return;
    ctx.save();
    ctx.strokeStyle = switchHover ? "rgba(255, 214, 64, 0.95)" : "rgba(255, 214, 64, 0.4)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 2]);
    ctx.strokeRect(Math.round(sw.x) + 0.5, Math.round(sw.y) + 0.5, Math.round(sw.w) - 1, Math.round(sw.h) - 1);
    ctx.restore();
  }
  function switchAt(e) {
    const sw = facingSwitch();
    if (!sw) return null;
    const r = view.getBoundingClientRect();
    const px = (e.clientX - r.left) * W / r.width, py = (e.clientY - r.top) * H / r.height;
    return px >= sw.x && px <= sw.x + sw.w && py >= sw.y && py <= sw.y + sw.h ? sw : null;
  }

  function drawHealthBars(sprites) {
    for (const sp of sprites) {
      if (!sp.hpMax || sp.hp === undefined || sp.hp <= 0 || sp.mode >= 13 || sp.tz > HP_BAR_DIST) continue;
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
  // Sol peint en tuiles de Wang (docs/reverse-engineering.md § 9.3e) : une tuile par demi-case ;
  // la couleur (0/1) de chaque bord est tirée d'un hachage de ses coordonnées et de la graine
  // FLOOR_SEED : déterministe (même sol à chaque visite), ou aléatoire avec ?floorSeed=random.
  // Les deux tuiles qui partagent un bord en ont la même couleur, donc le même raccord.
  const FLOOR_SEED = (() => {
    const q = new URLSearchParams(location.search).get("floorSeed");
    if (q === "random") return (Math.random() * 0x7fffffff) | 0;
    return q ? (+q | 0) : 1;
  })();
  function edgeBit(i, j, o) {
    let h = (Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(o + 1, 0x9e3779b1) ^ Math.imul(FLOOR_SEED + L.level, 0x85ebca6b)) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
    return (h >>> 7) & 1;
  }
  function wangPx(wx, wy) {
    const T = L.wangTex, t = L.floorWang.tile, k = L.floorWang.perCell;
    const fx = wx * k, fy = wy * k, i = Math.floor(fx), j = Math.floor(fy);
    const idx = edgeBit(i, j, 0) | edgeBit(i + 1, j, 1) << 1 | edgeBit(i, j + 1, 0) << 2 | edgeBit(i, j, 1) << 3;
    const tx = ((fx - i) * t) | 0, ty = ((fy - j) * t) | 0;
    return T.px[((idx >> 2) * t + ty) * T.w + (idx & 3) * t + tx];
  }

  // Plafond (docs/reverse-engineering.md § 9.3f) : le jeu redessine le même fond dans les quatre
  // directions, donc la case de plafond (un caisson vu en regardant vers le nord) est tournée
  // selon la direction cardinale la plus proche du regard ; elle reste calée sur les cases.
  // Renvoie (fu, fv) dans la case -> indice du texel.
  function ceilTexel(a) {
    const d = ((Math.round(a / (Math.PI / 2)) % 4) + 4) % 4;
    const fx = [1, 0, -1, 0][d], fy = [0, 1, 0, -1][d], rx = -fy, ry = fx;
    const swap = rx === 0, flipU = rx < 0 || ry < 0, flipV = fx > 0 || fy > 0;
    const C = L.ceilTex, cw = C.w, ch = C.h;
    return (fu, fv, odd) => {
      let u = swap ? fv : fu, v = swap ? fu : fv;
      if (flipU !== !!odd) u = 1 - u;                    // miroir une case sur deux
      if (flipV) v = 1 - v;
      return Math.min(ch - 1, (v * ch) | 0) * cw + Math.min(cw - 1, (u * cw) | 0);
    };
  }

  function castFloorCeiling(dirX, dirY, planeX, planeY) {
    const F = L.floorTex, C = L.ceilTex, mirF = L.floorMirror !== false, cTex = ceilTexel(player.a);
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
        if (dy < 0) { frame32[fRow + x] = shade(C.px[cTex(wx - cx, wy - cy, (cx + cy) & 1)], k); continue; }
        let tx = ((wx - cx) * tw) | 0, ty = ((wy - cy) * th) | 0;
        if (mir && (cx + cy) & 1) tx = tw - 1 - tx;
        frame32[fRow + x] = shade(L.wangTex ? wangPx(wx, wy) : T.px[ty * tw + tx], k);
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
    // sol et plafond. Le sol suit la perspective du sol peint du jeu (§ 9.3c, GAME_FLOOR) et non
    // celle des murs : en lignes du jeu (120 de haut), profondeur K = ak / (y − hk) unités, écart
    // x − 88 = 0,75 · X · (y − hx), 3,1 unités par case ; décalage c0 choisi pour que le bord de la
    // case suivante (z = 0,5) tombe au pied du mur proche de la vue 3D.
    const F = L.floorTex, mirF = L.floorMirror !== false, cTex = L.outdoor ? null : ceilTexel(player.a);
    const G = GAME_FLOOR, gs = 120 / H, xs = 176 / W;
    const c0 = G.ak / ((half + (WALL_H / 2) * proj / 0.5) * gs - G.hk) / G.upc - 0.5;
    for (let y = Math.floor(half) + 1; y < H; y++) {
      const d = (WALL_H / 2) * proj / (y - half), z = zOfDeff(d);
      const yg = (y + 0.5) * gs, zf = G.ak / (yg - G.hk) / G.upc - c0, lf = xs / (G.px * G.upc * (yg - G.hx));
      const k = Math.round((1 - shadeFor(z) / SHADES * 0.85) * 256);
      const kf = Math.round((1 - shadeFor(Math.max(0, zf)) / SHADES * 0.85) * 256);
      const fRow = y * W, cRow = (H - 1 - y) * W;
      for (let x = 0; x < W; x++) {
        const u = x + 0.5 - W / 2;
        let lat = u * lf, wx = player.x + fx * zf + rx * lat, wy = player.y + fy * zf + ry * lat;
        let cx = Math.floor(wx), cy = Math.floor(wy), odd = (cx + cy) & 1, fu = wx - cx, fv = wy - cy;
        let tx = (fu * F.w) | 0;
        if (mirF && odd) tx = F.w - 1 - tx;
        frame32[fRow + x] = shade(L.wangTex ? wangPx(wx, wy) : F.px[((fv * F.h) | 0) * F.w + tx], kf);
        if (L.outdoor) continue;
        lat = u * d / proj; wx = player.x + fx * z + rx * lat; wy = player.y + fy * z + ry * lat;
        cx = Math.floor(wx); cy = Math.floor(wy); odd = (cx + cy) & 1;
        frame32[cRow + x] = shade(L.ceilTex.px[cTex(wx - cx, wy - cy, odd)], k);
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
      if (z < 0) continue;
      const [srx, sry, rw, rh] = it.rect, d = deff(z);
      const near = z < 0.5 ? nearItem(z, lat, rw, rh, 0, it.dy) : null;
      const scale = (WALL_H / 96) * proj / d, sw = near ? near.sw : rw * scale, sh = near ? near.sh : rh * scale;
      const left = near ? near.left : W / 2 + lat * proj / d - sw / 2, top = near ? near.top : half + (WALL_H / 2) * proj / d - sh + it.dy * scale;
      sprites.push({ tz: z + it.dz, rx: srx, ry: sry, rw, rh, sw, sh, left, top, mirror: false, imgs: FLOOR.imgs, alpha: it.alpha, item: it.item,
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
      let pwx = player.x, pwy = player.y, pz = 0, nearest = 1e9, done = false, skipping = !!portalSkip;
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
          let pos, line;
          if (c.axis === 0) { const nx = ncx > cx ? cx + 1 : cx - 1; f = nx > cx ? FACE_W : FACE_E; cx = nx; uu = hy - Math.floor(hy); pos = hy; line = (cx << 3) | f; }
          else { const ny = ncy > cy ? cy + 1 : cy - 1; f = ny > cy ? FACE_N : FACE_S; cy = ny; uu = hx - Math.floor(hx); pos = hx; line = (cy << 3) | f; }
          if (!inside(cx, cy)) { done = true; break; }
          if (skipping) { if (cx === portalSkip.x && cy === portalSkip.y) skipping = false; continue; }   // passe du portail
          if ((fx === 0 ? c.axis === 0 : c.axis === 1) && freeAt(cx, cy)) continue;   // objet : vu de face seulement
          const P = portalAt(cx, cy, c.axis === 0 ? cx - (f === FACE_W ? 1 : -1) : cx, c.axis === 1 ? cy - (f === FACE_N ? 1 : -1) : cy);
          const t = texFor(cx, cy, f);
          if (!t && !P) continue;
          if (f === FACE_E || f === FACE_N) uu = 1 - uu;
          if (P && !(t && t.block && (t.opaque || t.tex < 0))) {   // porte ouverte d'une sortie ou d'un lieu en image
            if (t && t.tex >= 0) items.push({ d: hz, tex: t.tex, u: uu, pos, line, door: t.panel ? t : null });
            items.push({ d: hz + 1e-3, portal: P, u: uu });
            nearest = hz; done = true; break;
          }
          if (!t) continue;
          if (t.tex >= 0) items.push({ d: hz, tex: t.tex, u: uu, pos, line, door: t.panel ? t : null });
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
        if (it.portal) { const colH = WALL_H * proj / deff(dist); drawPortalColumn(it.portal, x, half - colH / 2, colH, it.u); continue; }
        if (it.sp) {
          const sp = it.sp;
          if (sp.alpha) ctx.globalAlpha = sp.alpha;
          ctx.drawImage((sp.imgs || L.sprImgs)[shadeFor(dist)], sp.rx + Math.floor(it.u * sp.rw), sp.ry, 1, sp.rh, x, sp.top, 1, sp.sh);
          ctx.globalAlpha = 1;
        } else {
          const colH = WALL_H * proj / deff(dist), top = half - colH / 2;
          const tx = (it.tex % cols) * fw + Math.min(fw - 1, Math.floor(it.u * fw));
          const ty = Math.floor(it.tex / cols) * fh;
          if (L.outdoor) drawUpper(it.tex, it.u, dist, x, top, colH, it.pos, it.line);
          ctx.drawImage(L.wallImgs[shadeFor(dist)], tx, ty, 1, fh, x, top, 1, colH);
          if (it.door) drawPanel(it, dist, x, top, colH);
        }
      }
    }
    if (inPortal) return;
    drawHealthBars(sprites);
    drawSwitch();
    pickables = sprites.filter((sp) => sp.item);
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
    for (const a of itemMoves.values()) if (a.t0 && now - a.t0 < ITEM_MOVE_MS) return true;
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
      if (tz < 0) continue;
      const [rx, ry, rw, rh] = it.rect;
      if (tz < 0.5) {                                   // case du groupe : règle du jeu (nearItem)
        const t = Math.hypot(planeX, planeY), n = nearItem(tz, (dx * planeX + dy * planeY) / t, rw, rh, pitch, it.dy);
        out.push({ tz: tz + it.dz, rx, ry, rw, rh, ...n, mirror: false, imgs: FLOOR.imgs, ghost: it.alpha, item: it.item,
          x0: Math.max(0, Math.floor(n.left)), x1: Math.min(W - 1, Math.ceil(n.left + n.sw)) });
        continue;
      }
      const scale = (WALL_H / 96) / tz * proj, sw = rw * scale, sh = rh * scale;
      const left = W / 2 * (1 + tx / tz) - sw / 2, top = H / 2 + pitch + (WALL_H / 2) / tz * proj - sh + it.dy * scale;
      out.push({ tz: tz + it.dz, rx, ry, rw, rh, sw, sh, left, top, mirror: false, imgs: FLOOR.imgs, ghost: it.alpha, item: it.item,
        x0: Math.max(0, Math.floor(left)), x1: Math.min(W - 1, Math.ceil(left + sw)) });
    }
    const cols = L.atlasCols, fw = L.faceW, fh = L.faceH, unit = W / 2 / Math.hypot(planeX, planeY);
    for (const [cx, cy] of freeObjects()) {             // objets au centre d'une case : face entière, de face
      if (portalSkip && cx === portalSkip.x && cy === portalSkip.y) continue;   // décor de la porte, de l'autre côté
      const dx = cx + 0.5 - player.x, dy = cy + 0.5 - player.y;
      const tx = inv * (dirY * dx - dirX * dy), tz = inv * (-planeY * dx + planeX * dy);
      if (tz < 0.2) continue;
      const tex = info(face(cx, cy, 0)).tex;
      const sw = unit / tz, sh = WALL_H / tz * proj;
      const left = W / 2 * (1 + tx / tz) - sw / 2, top = H / 2 + pitch - sh / 2;
      out.push({ tz, rx: (tex % cols) * fw, ry: Math.floor(tex / cols) * fh, rw: fw, rh: fh, sw, sh, left, top, mirror: false,
        imgs: L.wallImgs, x0: Math.max(0, Math.floor(left)), x1: Math.min(W - 1, Math.ceil(left + sw)) });
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
    let downAt = null, pressAt = null;
    view.addEventListener("pointerdown", (e) => {
      pressAt = { x: e.clientX, y: e.clientY };
      if (anim) { player.x = anim.x1; player.y = anim.y1; anim = null; turning = false; }
      if (e.button !== 0 || !L) return;
      // appui sur l'interrupteur devant le groupe : actionné dans le jeu au relâchement, sauf si la
      // souris bouge de plus de DRAG_PX pixels avant : on regarde alors autour, comme ailleurs
      view.setPointerCapture(e.pointerId); e.preventDefault();
      window.focus();       // le clavier vient ici pendant qu'on regarde : Q / D deviennent des pas de côté
      const sw = switchAt(e);
      if (sw) { downAt = { ...sw, x0: e.clientX, y0: e.clientY }; return; }
      looking = true; view.style.cursor = "grabbing";
    });
    const DRAG_PX = 5;
    view.addEventListener("pointermove", (e) => {
      if (downAt && !looking && Math.hypot(e.clientX - downAt.x0, e.clientY - downAt.y0) > DRAG_PX) {
        downAt = null; looking = true; view.style.cursor = "grabbing";
      }
      if (!looking) {
        if (downAt) return;
        const over = !!switchAt(e);
        if (over !== switchHover) { switchHover = over; dirty = true; }
        const hov = !handCursor ? itemAt(e) : null;
        view.style.cursor = over || hov ? "pointer" : baseCursor();
        // infobulle de l'objet au sol survolé (page : « lol-itemhover »)
        const ht = hov ? hov.item.type : -1;
        if (ht !== hoverType || ht >= 0) { hoverType = ht; parent.postMessage({ type: "lol-itemhover", t: ht, x: e.clientX, y: e.clientY }, location.origin); }
        return;
      }
      const r = view.getBoundingClientRect();
      const s = Math.min(r.width / W, r.height / H);       // pixels écran par pixel du rendu
      lookYaw += e.movementX / s * (FOV / W);
      pitch = Math.max(-H * 0.6, Math.min(H * 0.6, pitch - e.movementY / s));
      player.a = gameA + lookYaw;
      dirty = true;
    });
    view.addEventListener("pointerleave", () => { if (hoverType >= 0) { hoverType = -1; parent.postMessage({ type: "lol-itemhover", t: -1 }, location.origin); } });
    // clic droit, objet en main : rangé dans le sac (il reste dans l'inventaire)
    view.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (handCursor) parent.postMessage({ type: "lol-handstore" }, location.origin);
      giveKeysToGame();
    });
    // Objet en main (message « lol-hand » de la page) : il sert de curseur dans la vue. Clic sur le
    // sol de la case du groupe : posé à gauche / à droite (mode 1 / 2) ; sur le sol de la case de
    // devant : mode 3 / 4 ; plus haut : lancé devant le groupe (mode 0), sur un monstre s'il y en a un
    // (clickedSceneDropItem / clickedSceneThrowItem du jeu).
    function handClickMode(e) {
      const r = view.getBoundingClientRect();
      const px = (e.clientX - r.left) * W / r.width, py = (e.clientY - r.top) * H / r.height;
      const foot = (z) => H / 2 + pitch + (WALL_H / 2) * proj / (persp === "jeu" ? deff(z) : z);
      const right = px > W / 2 ? 1 : 0;
      if (py > foot(0.5)) return 1 + right;
      if (py > foot(1.5)) return 3 + right;
      return 0;
    }
    // Relâcher après avoir regardé de côté fait tourner le groupe de ce côté dans le jeu :
    // un quart de tour au-delà de 30°, un demi-tour au-delà de 135°. La vue garde son angle
    // et rejoint en douceur la direction que le jeu renvoie.
    const LOOK_TURN = Math.PI / 6;
    const endLook = (turn) => {
      if (!looking) return;
      looking = false; pitch = 0; view.style.cursor = baseCursor(); dirty = true;
      releaseStrafe();
      const yaw = lookYaw; lookYaw = 0;
      const n = turn && Math.abs(yaw) > LOOK_TURN ? Math.min(2, Math.max(1, Math.round(Math.abs(yaw) / (Math.PI / 2)))) : 0;
      if (!n) { player.a = gameA; return; }
      const code = yaw > 0 ? "PageUp" : "Home";
      for (let i = 0; i < n; i++) setTimeout(() => pressGameKey(code), i * 350);
      const a0 = gameA;     // le jeu n'a pas tourné (menu ouvert…) : la vue revient à sa direction
      setTimeout(() => { if (gameA === a0 && !looking && !anim) { player.a = gameA; dirty = true; } }, n * 350 + 1200);
    };
    view.addEventListener("pointerup", (e) => {
      giveKeysToGame();
      if (downAt) {
        if (switchAt(e)) parent.postMessage({ type: "lol-clickwall", special: downAt.special }, location.origin);
        downAt = null;
        return;
      }
      // clic sans glisser sur un objet au sol, main vide : ramassé dans le sac
      const tapped = pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) <= DRAG_PX;
      const hit = tapped && !handCursor ? itemAt(e) : null;
      if (hit) {
        endLook(false);
        parent.postMessage({ type: "lol-pickup", block: Math.floor(hit.item.y) * 32 + Math.floor(hit.item.x), itemType: hit.item.type }, location.origin);
        return;
      }
      // objet en main (curseur) : un clic sans glisser fait comme un clic dans la vue du jeu
      if (handCursor && pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) <= DRAG_PX) {
        endLook(false);
        parent.postMessage({ type: "lol-handclick", mode: handClickMode(e) }, location.origin);
        return;
      }
      endLook(true);
    });
    // Clavier : la vue 3D n'a pas de commandes ; un clic lui donne le clavier, qu'on rend au jeu
    // (ScummVM : son cadre #dos ; DOSBox : la page, dont les écouteurs envoient les touches à
    // js-dos). Une touche reçue malgré tout est rejouée dans le jeu, pour ne perdre aucun appui.
    const gameTarget = () => {
      try {
        const d = parent.document.getElementById("dos");
        if (!d) return null;
        if (d.tagName === "IFRAME") return { focus: () => d.focus(), el: d.contentWindow.document.body || d.contentWindow.document };
        const c = d.querySelector("canvas");
        return { focus: () => { parent.focus(); if (c) { if (!c.hasAttribute("tabindex")) c.tabIndex = -1; c.focus(); } }, el: c || parent.document.body };
      } catch (err) { return null; }
    };
    function giveKeysToGame() { const t = gameTarget(); if (t) t.focus(); }
    // touches fixes du jeu, envoyées telles quelles (lolMapped : la page ne les retraduit pas, keys.js)
    const KEY_CODES = { Home: 36, PageUp: 33, ArrowLeft: 37, ArrowRight: 39 };
    function sendFixed(type, code) {
      const t = gameTarget();
      if (!t) return;
      const View = t.el.ownerDocument ? t.el.ownerDocument.defaultView : parent;
      const ev = new View.KeyboardEvent(type, { key: code, code, keyCode: KEY_CODES[code], which: KEY_CODES[code], bubbles: true, cancelable: true });
      ev.lolMapped = true;
      t.el.dispatchEvent(ev);
    }
    function pressGameKey(code) {
      const t = gameTarget();
      if (!t) return;
      t.focus();
      sendFixed("keydown", code);
      setTimeout(() => sendFixed("keyup", code), 60);
    }
    // Bouton de la souris tenu (on regarde autour) : les touches qui tournent le groupe (réglables,
    // keys.js de la page ; Q / D par défaut) font un pas de côté, envoyées au jeu comme les flèches
    // gauche / droite.
    const strafeSide = (code) => {
      let K = null; try { K = parent.LoLKeys; } catch (e) {}
      const tl = K ? K.codeOf("TL") : "KeyA", tr = K ? K.codeOf("TR") : "KeyD";
      return code && code === tl ? "ArrowLeft" : code && code === tr ? "ArrowRight" : null;
    };
    const strafeHeld = new Map();                       // code physique -> flèche envoyée
    function releaseStrafe() { for (const a of strafeHeld.values()) sendFixed("keyup", a); strafeHeld.clear(); }
    for (const type of ["keydown", "keyup"]) addEventListener(type, (e) => {
      if (type === "keyup" && strafeHeld.has(e.code)) {
        sendFixed("keyup", strafeHeld.get(e.code)); strafeHeld.delete(e.code);
        e.preventDefault(); return;
      }
      const side = type === "keydown" && looking ? strafeSide(e.code) : null;
      if (side) {
        if (!strafeHeld.has(e.code)) { strafeHeld.set(e.code, side); sendFixed("keydown", side); }
        e.preventDefault(); return;
      }
      const t = gameTarget();
      if (!t) return;
      if (!looking) t.focus();
      const init = { key: e.key, code: e.code, keyCode: e.keyCode, which: e.which, location: e.location, repeat: e.repeat,
        shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, bubbles: true, cancelable: true };
      const View = t.el.ownerDocument ? t.el.ownerDocument.defaultView : parent;
      t.el.dispatchEvent(new View.KeyboardEvent(type, init));
      e.preventDefault();
    });
    view.addEventListener("pointercancel", () => endLook(false));
    view.addEventListener("lostpointercapture", () => endLook(false));
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

  // Mode intégré : objet en main dans le jeu (icône d'ITEMICN.SHP), montré en curseur
  let handCursor = null;
  const baseCursor = () => handCursor || "grab";
  const handIcons = new Image();
  handIcons.src = "data/item_icons.png?v=" + DATA_V;
  addEventListener("message", (e) => {
    if (!EMBED || e.origin !== location.origin || !e.data || e.data.type !== "lol-hand") return;
    const icon = e.data.icon;
    const apply = () => {
      if (icon < 0) handCursor = null;
      else {
        const c = document.createElement("canvas"); c.width = c.height = 40;
        const g = c.getContext("2d"); g.imageSmoothingEnabled = false;
        g.drawImage(handIcons, (icon % 16) * 20, Math.floor(icon / 16) * 20, 20, 20, 0, 0, 40, 40);
        handCursor = `url(${c.toDataURL()}) 20 20, auto`;
      }
      if (!looking) view.style.cursor = baseCursor();
      view.title = handCursor ? "Objet en main : clic sur le sol pour le poser, plus haut pour le lancer, clic droit pour le ranger dans le sac ; glisser pour regarder autour"
        : "Maintenir le clic gauche et glisser pour regarder autour";
    };
    if (handIcons.complete && handIcons.naturalWidth) apply(); else handIcons.onload = apply;
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
  window.lolLiveItems = () => liveItems;   // débogage
  addEventListener("message", (e) => {
    if (!EMBED || e.origin !== location.origin || !e.data || e.data.type !== "lol-items") return;
    // un objet dont la position change (lancé, puis retombé) glisse de l'ancienne à la nouvelle en
    // ITEM_MOVE_MS, hauteur comprise : la page ne relit la mémoire que toutes les 200 ms
    const now = performance.now(), seen = new Set();
    liveItems = e.data.list.map((i) => {
      const it = { ...i, level: e.data.level };
      if (it.id) {
        seen.add(it.id);
        const a = itemMoves.get(it.id);
        if (a && (a.x1 !== it.x || a.y1 !== it.y || a.h1 !== it.h) && a.level === it.level) {
          const p = itemPos(a, now);
          itemMoves.set(it.id, { x0: p.x, y0: p.y, h0: p.h, x1: it.x, y1: it.y, h1: it.h, t0: now, level: it.level });
        } else if (!a || a.level !== it.level) itemMoves.set(it.id, { x0: it.x, y0: it.y, h0: it.h, x1: it.x, y1: it.y, h1: it.h, t0: 0, level: it.level });
      }
      return it;
    });
    for (const id of [...itemMoves.keys()]) if (!seen.has(id)) itemMoves.delete(id);
    dirty = true;
  });
  const ITEM_MOVE_MS = 200, itemMoves = new Map();
  function itemPos(a, now) {
    const k = a.t0 ? Math.min(1, (now - a.t0) / ITEM_MOVE_MS) : 1;
    return { x: a.x0 + (a.x1 - a.x0) * k, y: a.y0 + (a.y1 - a.y0) * k, h: a.h0 + (a.h1 - a.h0) * k, moving: k < 1 };
  }
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
    .then(([d, img]) => { FLOOR.rects = d.rects; FLOOR.types = d.types; FLOOR.blood = d.blood || null; FLOOR.bloodPool = d.bloodPool ?? -1; FLOOR.imgs = darken(img, SHADES); dirty = true; }, () => {});
  window.lolFloorItems = () => liveItems;   // débogage
  // Objet à moins d'une demi-case devant le groupe (sa propre case) : le jeu ne le projette
  // pas, il le dessine en taille réelle, pieds sur la ligne _monsterScaleY[z·8] (124, 120,
  // 116, 112 sur 120, horizon à 60) et écart latéral _monsterScaleX[z·8]/256 px par 1/256 case
  // (calcDrawingLayerParameters, tables du .EXE ; docs/reverse-engineering.md, § 9.3h).
  // En projection, il tomberait sous le bas de l'image dès 0,4 case.
  // ITEM_DY : drawBlockObjects descend chaque objet de 5 px (à l'échelle), plus un petit écart
  // propre à son numéro (_sceneItemOffs) qu'on ignore.
  const NEAR_ROW = [124, 120, 116, 112], NEAR_LAT = [152, 152, 144, 136], ITEM_DY = 5;
  function nearItem(z, lat, rw, rh, dy, itemDy = ITEM_DY) {
    const l = Math.max(0, Math.min(3, Math.floor(z * 8))), s = H / 120;
    const sw = rw * W / 176, sh = rh * s;
    return { sw, sh, left: W / 2 + lat * NEAR_LAT[l] * W / 176 - sw / 2, top: H / 2 + dy + (NEAR_ROW[l] - 60 + itemDy) * s - sh };
  }
  // Flaques de sang (drapeau 0x80 de la case, LoLEngine::drawBlockEffects) : au centre de la
  // case, sans décalage de 5 px, dessinées avant les objets de la case (dz), à 50 % : le jeu
  // remplace le sol par sa moitié + du rouge (_grayOverlay, docs/reverse-engineering.md § 9.3i).
  let liveBlood = { level: -1, cells: [] };
  addEventListener("message", (e) => {
    if (!EMBED || e.origin !== location.origin || !e.data || e.data.type !== "lol-blood") return;
    liveBlood = { level: e.data.level, cells: e.data.cells };
    dirty = true;
  });
  // objets visibles du niveau affiché -> [{ x, y, rect, dy, dz, alpha }]
  function floorItems() {
    if (!EMBED || !FLOOR.imgs || !L) return [];
    const out = [];
    const pool = FLOOR.bloodPool >= 0 ? FLOOR.rects[FLOOR.bloodPool] : null;
    if (pool && liveBlood.level === L.level)
      for (const c of liveBlood.cells) out.push({ x: (c & 31) + 0.5, y: (c >> 5) + 0.5, rect: pool, dy: 0, dz: 0.001, alpha: 0.5 });
    for (const it of liveItems) {
      if (it.level !== L.level) continue;
      const k = FLOOR.types[it.type], rect = k >= 0 ? FLOOR.rects[k] : null;
      // objet en vol (lancé) : relevé de (hauteur − 1) × 6 pixels, comme drawBlockObjects ; pas ramassable
      const a = it.id ? itemMoves.get(it.id) : null, p = a ? itemPos(a, performance.now()) : { x: it.x, y: it.y, h: it.h || 0 };
      const fly = p.h > 1 ? (p.h - 1) * 6 : 0;
      if (rect) out.push({ x: p.x, y: p.y, rect, dy: ITEM_DY - fly, dz: 0, item: fly || p.moving ? null : it });
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
  // Une position reçue pendant le chargement d'un niveau n'est pas perdue : la dernière est
  // appliquée à la fin du chargement (la page ne renvoie une position que si elle change).
  let loadingLevel = null, pendingPos = null;
  addEventListener("message", async (e) => {
    if (!EMBED || e.origin !== location.origin || !e.data || e.data.type !== "lol-pos") return;
    let { level, x, y, dir } = e.data;
    let freshLevel = false;
    if (loadingLevel !== null) { pendingPos = e.data; return; }
    if (!L || L.level !== level) {
      freshLevel = true;
      loadingLevel = level; pendingPos = null;
      try { await loadLevel(level, false); applyLiveGrid(); } finally { loadingLevel = null; }
      if (pendingPos) {
        ({ level, x, y, dir } = pendingPos); pendingPos = null;
        if (L.level !== level) { window.postMessage({ type: "lol-pos", level, x, y, dir }, location.origin); return; }
      }
    }
    const tx = x + 0.5, ty = y + 0.5, ta = DIR_ANGLE[dir & 3];
    const same = Math.abs(tx - (anim ? anim.x1 : player.x)) < 1e-6 && Math.abs(ty - (anim ? anim.y1 : player.y)) < 1e-6 && ta === gameA;
    if (same && !freshLevel) return;          // niveau rechargé : loadLevel a remis sa case de départ
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
    if (q.has("p")) pitch = +q.get("p");                       // horizon décalé (px), > 0 = regard vers le haut
    if (q.has("hud")) { helpEl.classList.add("hidden"); }
    if (EMBED) {
      for (const id of ["top", "help", "map"]) document.getElementById(id).style.display = "none";
      view.style.cursor = baseCursor();
      view.title = "Maintenir le clic gauche et glisser pour regarder autour";
    }
    requestAnimationFrame(frame);
  })();
})();
