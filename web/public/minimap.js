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
  // Inventaire (§ 12.2 bis de la documentation)
  const INV = {
    bar: 0x3E4F6, barSlots: 48,      // u16 : n° d'objet du jeu (0 = vide), barre commune
    hand: 0x3E558,                   // u16 : objet tenu en main
    items: 0x31F79, itemSize: 16, maxItems: 400,   // u16 au début de chaque entrée : type d'objet
    char0: 0x3389F, nameLen: 11, equipOffset: 78, equipSlots: 11,   // équipement : 11 × u16 à +78
  };
  const CELL = 12;
  const COLORS = { wall: "#2b2b2b", floor: "#8a7f68", doorOpen: "#d08a4a", doorClosed: "#a0522d",
    special: "#6f8f58", unknown: "#3a3550" };

  const canvas = document.getElementById("mm-canvas");
  const g = canvas.getContext("2d");
  const titleEl = document.getElementById("mm-title");
  const infoEl = document.getElementById("mm-info");
  const labelEl = document.getElementById("mm-label");
  const itemsEl = document.getElementById("mm-items");
  const frame3d = document.getElementById("v3d-frame");
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
      levels.push({ level: l.level, name: l.name, faces: Uint8Array.from(d.faces), wallTypes: d.wallTypes,
        labels: d.labels, groups: groupItems(d.items || []) });
      infoEl.textContent = `chargement des cartes… ${levels.length}/${index.length}`;
    }
  }

  // Objets regroupés par case, numérotés dans l'ordre de lecture de la carte (haut → bas).
  const DIRS = { N: "nord", E: "est", S: "sud", O: "ouest" };
  function groupItems(items) {
    const byCell = new Map();
    for (const it of items) {
      const k = it.y * 32 + it.x;
      if (!byCell.has(k)) byCell.set(k, { x: it.x, y: it.y, items: [] });
      byCell.get(k).items.push(it);
    }
    return [...byCell.values()].sort((a, b) => a.y - b.y || a.x - b.x).map((g, i) => ({ ...g, n: i + 1 }));
  }

  function renderItemList(L) {
    itemsEl.textContent = "";
    if (!L || !L.groups.length) {
      const li = document.createElement("li"); li.textContent = "aucun objet placé sur ce niveau"; itemsEl.appendChild(li);
      return;
    }
    for (const g of L.groups) {
      const li = document.createElement("li");
      li.dataset.cell = g.y * 32 + g.x;
      const b = document.createElement("b"); b.textContent = g.n + ".";
      const names = new Map();
      for (const it of g.items) {
        const label = (it.name || `objet ${it.type}`) + (it.spawn === "event" ? " (événement)" : "");
        names.set(label, (names.get(label) || 0) + 1);
      }
      const t = document.createElement("span");
      t.textContent = [...names].map(([k, c]) => (c > 1 ? `${c} × ` : "") + k).join(", ")
        + (g.items[0].container === "niche"
          ? (DIRS[g.items[0].face] ? ` — niche, face ${DIRS[g.items[0].face]}` : " — dans un mur") : "");
      const pos = document.createElement("span"); pos.className = "pos"; pos.textContent = `${g.x},${g.y}`;
      li.append(b, t, pos);
      itemsEl.appendChild(li);
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
    for (const l of L.labels) g.fillRect(l.x * CELL + 3, l.y * CELL + 3, CELL - 7, CELL - 7);
    // objets : numéro du groupe sur sa case
    g.font = "bold 9px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.lineWidth = 3; g.strokeStyle = "#000";
    for (const it of L.groups) {
      const tx = it.x * CELL + CELL / 2, ty = it.y * CELL + CELL / 2 + 0.5;
      g.fillStyle = "#28dce6";
      g.strokeText(String(it.n), tx, ty); g.fillText(String(it.n), tx, ty);
    }
    // groupe : flèche orientée
    const cx = (block % 32) * CELL + CELL / 2, cy = Math.floor(block / 32) * CELL + CELL / 2;
    const a = [-Math.PI / 2, 0, Math.PI / 2, Math.PI][dir & 3];
    g.fillStyle = "#fff"; g.strokeStyle = "#000"; g.lineWidth = 1.5;
    g.beginPath();
    g.lineWidth = 1.5;
    g.moveTo(cx + Math.cos(a) * 9, cy + Math.sin(a) * 9);
    g.lineTo(cx + Math.cos(a + 2.4) * 6, cy + Math.sin(a + 2.4) * 6);
    g.lineTo(cx + Math.cos(a - 2.4) * 6, cy + Math.sin(a - 2.4) * 6);
    g.closePath(); g.stroke(); g.fill();
  }

  let busy = false;
  async function tick() {
    if (busy || previewing) return;
    busy = true;
    try { await update(); } finally { busy = false; }
  }
  async function update() {
    const r = await mem.read([[ADDR.block, 2], [ADDR.dir, 2], [ADDR.grid, 1024 * ADDR.stride]]);
    if (!r) { titleEl.textContent = "Mini-carte"; infoEl.textContent = "en attente du jeu…"; return; }
    const block = r[0][0] | r[0][1] << 8, dir = r[1][0] | r[1][1] << 8;
    const hash = readGrid(r[2]);
    const now = performance.now();
    if (hash !== lastHash && now - lastIdentify > 500) {
      const found = identify();
      if (found !== current) renderItemList(found);
      current = found; lastHash = hash; lastIdentify = now;
    }
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
    // objets à portée (case du groupe et cases voisines)
    for (const li of itemsEl.children) {
      const c = +li.dataset.cell;
      li.classList.toggle("near", Number.isFinite(c) && Math.abs((c % 32) - x) <= 1 && Math.abs(Math.floor(c / 32) - y) <= 1);
    }
    draw(block, dir);
    sendTo3d(current.level, x, y, dir);
  }

  // Vue 3D sous le jeu : on ne lui envoie la position que lorsqu'elle change.
  let lastSent = "";
  function sendTo3d(level, x, y, dir) {
    const key = `${level}:${x}:${y}:${dir}`;
    if (key === lastSent || !frame3d || !frame3d.contentWindow) return;
    lastSent = key;
    frame3d.contentWindow.postMessage({ type: "lol-pos", level, x, y, dir }, location.origin);
  }
  if (frame3d) frame3d.addEventListener("load", () => { lastSent = ""; });

  // Aperçu d'un niveau sans le jeu (tests, console) : LoLMinimap.preview(2, 5, 2, 1)
  let previewing = false;
  function preview(level, x = 0, y = 0, dir = 0) {
    previewing = true;
    current = levels.find((l) => l.level === level) || null;
    renderItemList(current);
    if (current) {
      for (let i = 0; i < 4096; i++) live[i] = current.faces[i];
      titleEl.textContent = `Niveau ${current.level} (aperçu)`;
      draw(y * 32 + x, dir);
    }
  }
  // --- Inventaire (grille d'icônes du jeu) ------------------------------------
  let itemInfo = null;                  // [{name, icon}] par type d'objet
  const ICON = 20, ICON_COLS = 16, SCALE = 1.5;
  const invBar = document.getElementById("inv-bar"), invHand = document.getElementById("inv-hand"),
    invChars = document.getElementById("inv-chars"), invCount = document.getElementById("inv-count");
  getJSON("viewer/data/items.json").then((d) => { itemInfo = d; }, () => {});

  function slot(type, label) {
    const d = document.createElement("div");
    d.className = "slot";
    if (type >= 0 && itemInfo) {
      const it = itemInfo[type] || { name: `objet ${type}`, icon: -1 };
      d.classList.add("full");
      d.title = label ? `${label} : ${it.name}` : it.name;
      if (it.icon >= 0) {
        const s = ICON * SCALE;
        d.style.backgroundPosition = `-${(it.icon % ICON_COLS) * s}px -${Math.floor(it.icon / ICON_COLS) * s}px`;
      }
    } else if (label) d.title = `${label} : vide`;
    return d;
  }

  let lastInv = "";
  async function updateInventory() {
    if (!itemInfo || previewing) return;
    const r = await mem.read([[INV.bar, INV.barSlots * 2], [INV.hand, 2], [INV.items, INV.itemSize * INV.maxItems],
      [INV.char0, INV.equipOffset + INV.equipSlots * 2]]);
    if (!r) return;
    const [bar, hand, table, ch] = r;
    const typeOf = (id) => (id > 0 && id < INV.maxItems ? table[id * INV.itemSize] | table[id * INV.itemSize + 1] << 8 : -1);
    const barTypes = [];
    for (let k = 0; k < INV.barSlots; k++) barTypes.push(typeOf(bar[k * 2] | bar[k * 2 + 1] << 8));
    const handType = typeOf(hand[0] | hand[1] << 8);
    let name = "";
    for (let k = 0; k < INV.nameLen && ch[k]; k++) name += String.fromCharCode(ch[k]);
    const eqTypes = [];
    for (let k = 0; k < INV.equipSlots; k++) { const o = INV.equipOffset + k * 2; eqTypes.push(typeOf(ch[o] | ch[o + 1] << 8)); }
    const key = JSON.stringify([barTypes, handType, name, eqTypes]);
    if (key === lastInv) return;          // on ne reconstruit la grille que si elle a changé
    lastInv = key;

    invBar.replaceChildren(...barTypes.map((t, k) => slot(t, `case ${k + 1}`)));
    invCount.textContent = `${barTypes.filter((t) => t >= 0).length} / ${INV.barSlots} cases occupées`;
    invHand.replaceChildren(slot(handType, "en main"));
    invChars.replaceChildren();
    if (/^[A-Za-z' -]{2,}$/.test(name)) {
      const b = document.createElement("div"); b.className = "inv-sub"; b.textContent = `${name} — équipement`;
      const row = document.createElement("div"); row.className = "inv-grid";
      row.append(...eqTypes.map((t, k) => slot(t, `emplacement ${k + 1}`)));
      invChars.append(b, row);
    }
  }

  window.LoLMinimap = { attach() {}, preview };

  setInterval(() => { updateInventory().catch(() => {}); }, 1000);
  loadLevels().then(() => setInterval(tick, 200),
    (e) => { infoEl.textContent = "cartes introuvables (viewer/data) : " + e.message; });
})();
