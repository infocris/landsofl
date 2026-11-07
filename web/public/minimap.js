// Mini-carte en direct à côté du jeu : lit la position du groupe dans la RAM du PC émulé.
// L'émulateur reste dans son worker ; la lecture passe par le canal « lol-mem » ajouté
// à emulators/wdosbox-x.js (quelques Ko toutes les 200 ms).
// Adresses physiques trouvées par recherche mémoire (voir docs/retro-conception.md, § 12).
(() => {
  "use strict";
  const ADDR = {
    block: 0x3E4E0,   // u16 : case du groupe = y*32 + x
    dir: 0x3E4EF,     // u16 : 0 N, 1 E, 2 S, 3 O
    grid: 0x3E713,    // grille vivante du niveau : 1024 cases de 10 octets, octets 0..3 = murs N E S O
    stride: 10,
  };
  const CELL = 9;
  const COLORS = { wall: "#2b2b2b", floor: "#8a7f68", doorOpen: "#d08a4a", doorClosed: "#a0522d",
    special: "#6f8f58", unknown: "#3a3550" };

  const canvas = document.getElementById("mm-canvas");
  const g = canvas.getContext("2d");
  const titleEl = document.getElementById("mm-title");
  const infoEl = document.getElementById("mm-info");
  const labelEl = document.getElementById("mm-label");
  canvas.width = canvas.height = 32 * CELL;

  const mem = new LoLMem.RemoteMemory();
  const levels = [];          // { level, name, faces: Uint8Array(4096), wallTypes, labels }
  let current = null, lastHash = -1, lastIdentify = 0;
  const live = new Uint8Array(4096);

  // Chargement un par un, avec nouvelles tentatives : le petit serveur local
  // (python -m http.server) supporte mal les requêtes simultanées.
  async function getJSON(url) {
    for (let i = 0; ; i++) {
      try { const r = await fetch(url); if (r.ok) return await r.json(); throw new Error(r.status); }
      catch (e) { if (i >= 4) throw e; await new Promise((ok) => setTimeout(ok, 300 * (i + 1))); }
    }
  }
  async function loadLevels() {
    const index = await getJSON("viewer/data/levels.json");
    for (const l of index) {
      const d = await getJSON(`viewer/data/level${String(l.level).padStart(2, "0")}.json`);
      levels.push({ level: l.level, name: l.name, faces: Uint8Array.from(d.faces), wallTypes: d.wallTypes, labels: d.labels });
      infoEl.textContent = `chargement des cartes… ${levels.length}/${index.length}`;
    }
  }

  function readGrid(bytes) {
    let hash = 0;
    for (let i = 0; i < 1024; i++) {
      const a = i * ADDR.stride;
      for (let k = 0; k < 4; k++) { const v = bytes[a + k]; live[i * 4 + k] = v; hash = (hash * 31 + v) | 0; }
    }
    return hash;
  }

  // Le niveau courant est celui dont la grille d'origine ressemble le plus à la grille vivante
  // (les portes ouvertes changent quelques identifiants, d'où un seuil et non une égalité).
  function identify() {
    let best = null, bestScore = 0;
    for (const L of levels) {
      let same = 0;
      for (let i = 0; i < 1024; i++) {
        const o = i * 4;
        if (L.faces[o] === live[o] && L.faces[o + 1] === live[o + 1] && L.faces[o + 2] === live[o + 2] && L.faces[o + 3] === live[o + 3]) same++;
      }
      if (same > bestScore) { bestScore = same; best = L; }
    }
    return bestScore > 900 ? best : null;
  }

  function cellClass(L, i) {
    let cls = "floor", allZero = true;
    for (let k = 0; k < 4; k++) {
      const id = live[i * 4 + k];
      if (id === 0) continue;
      allZero = false;
      const t = L.wallTypes[id];
      if (!t) { cls = cls === "floor" ? "unknown" : cls; continue; }
      const [flags, special, automap] = t;
      if (special === 5 || automap === 13) return flags & 1 ? "doorClosed" : "doorOpen";
      if (flags & 1) cls = "wall";
      else if (cls === "floor" && flags !== 0x80) cls = "special";
    }
    return allZero ? "floor" : cls;
  }

  function draw(block, dir) {
    const L = current;
    g.fillStyle = "#000"; g.fillRect(0, 0, canvas.width, canvas.height);
    if (!L) return;
    for (let i = 0; i < 1024; i++) {
      g.fillStyle = COLORS[cellClass(L, i)];
      g.fillRect((i % 32) * CELL, Math.floor(i / 32) * CELL, CELL - 1, CELL - 1);
    }
    g.fillStyle = "#d22";
    for (const l of L.labels) g.fillRect(l.x * CELL + 2, l.y * CELL + 2, CELL - 5, CELL - 5);
    // groupe : flèche orientée
    const cx = (block % 32) * CELL + CELL / 2, cy = Math.floor(block / 32) * CELL + CELL / 2;
    const a = [-Math.PI / 2, 0, Math.PI / 2, Math.PI][dir & 3];
    g.fillStyle = "#fff"; g.strokeStyle = "#000"; g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * 7, cy + Math.sin(a) * 7);
    g.lineTo(cx + Math.cos(a + 2.4) * 5, cy + Math.sin(a + 2.4) * 5);
    g.lineTo(cx + Math.cos(a - 2.4) * 5, cy + Math.sin(a - 2.4) * 5);
    g.closePath(); g.stroke(); g.fill();
  }

  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try { await update(); } finally { busy = false; }
  }
  async function update() {
    const r = await mem.read([[ADDR.block, 2], [ADDR.dir, 2], [ADDR.grid, 1024 * ADDR.stride]]);
    if (!r) { titleEl.textContent = "Mini-carte"; infoEl.textContent = "en attente du jeu…"; return; }
    const block = r[0][0] | r[0][1] << 8, dir = r[1][0] | r[1][1] << 8;
    const hash = readGrid(r[2]);
    const now = performance.now();
    if (hash !== lastHash && now - lastIdentify > 500) { current = identify(); lastHash = hash; lastIdentify = now; }
    if (!current || block > 1023 || dir > 3) {
      titleEl.textContent = "Mini-carte";
      infoEl.textContent = "hors exploration (menu, intro, dialogue…)";
      labelEl.textContent = "";
      draw(0, 0);
      return;
    }
    const x = block % 32, y = Math.floor(block / 32);
    titleEl.textContent = `Niveau ${current.level}`;
    infoEl.textContent = `${current.name.split(" — ")[0]} · case ${x},${y} · ${["Nord", "Est", "Sud", "Ouest"][dir]}`;
    let near = null, bd = 2.5;
    for (const l of current.labels) {
      if (!l.text || l.text === "ENDROIT INVALIDE") continue;
      const d = Math.hypot(l.x - x, l.y - y);
      if (d < bd) { bd = d; near = l; }
    }
    labelEl.textContent = near ? near.text : "";
    draw(block, dir);
  }

  window.LoLMinimap = { attach() {} };   // conservé pour la page ; plus rien à faire ici

  loadLevels().then(() => setInterval(tick, 200),
    (e) => { infoEl.textContent = "cartes introuvables (viewer/data) : " + e.message; });
})();
