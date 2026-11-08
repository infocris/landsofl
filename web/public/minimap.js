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
    sceneFlag: 0x5D6B5,  // u8 : 5 en exploration, 1 pendant l'image fixe d'un lieu (observé)
  };
  // Caractéristiques (§ 12.2) : fiche de personnage, champs relatifs au nom ; argent du groupe
  const STATS = { money: 0x3E6F0 };   // couronnes d'argent (u16, vérifié : le jeu annonce la valeur écrite)
  // Inventaire (§ 12.2 bis de la documentation)
  const INV = {
    bar: 0x3E4F6, barSlots: 48,      // u16 : n° d'objet du jeu (0 = vide), barre commune
    hand: 0x3E558,                   // u16 : objet tenu en main
    items: 0x31F79, itemSize: 16, maxItems: 400,   // u16 au début de chaque entrée : type d'objet
    char0: 0x3389F, charSize: 130, chars: 4,   // groupe : 4 fiches de 130 octets (nom de la 1re en 0x3389F)
    nameLen: 11, equipOffset: 78, equipSlots: 11,   // équipement : 11 × u16 à +78
  };
  // Monstres du niveau courant (§ 12.2) : table de 30 entrées de 46 octets ; positions
  // relatives au champ x : case u16 à -2, x/y u16 (case*256 + décalage), direction à +17, type à +25
  const MON = { x0: 0x31871, size: 46, count: 30 };
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
        labels: d.labels, groups: groupItems(d.items || []), monsterTypes: d.monsterTypes || {},
        spriteSigs: d.spriteSigs || {}, spriteOf: null, scenes: d.scenes || {} });
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
    // monstres : position réelle et direction
    for (const m of monsters) {
      const mx = m.x * CELL, my = m.y * CELL, a = [-Math.PI / 2, 0, Math.PI / 2, Math.PI][m.dir];
      g.fillStyle = "#ff8c00"; g.strokeStyle = "#000"; g.lineWidth = 1;
      g.beginPath(); g.arc(mx, my, 3.2, 0, 2 * Math.PI); g.fill(); g.stroke();
      g.strokeStyle = "#ff8c00"; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(mx, my); g.lineTo(mx + Math.cos(a) * 5.5, my + Math.sin(a) * 5.5); g.stroke();
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
  let monsters = [];
  function readMonsters(bytes) {
    const out = [];
    for (let i = 0; i < MON.count; i++) {
      const a = i * MON.size + 2;                 // bytes commence à x0 - 2
      const block = bytes[a - 2] | bytes[a - 1] << 8, x = bytes[a] | bytes[a + 1] << 8, y = bytes[a + 2] | bytes[a + 3] << 8;
      if (!block || block > 1023 || (x >> 8) !== (block & 31) || (y >> 8) !== (block >> 5)) continue;
      out.push({ x: x / 256, y: y / 256, dir: bytes[a + 17] & 3, type: bytes[a + 25] });
    }
    return out;
  }

  async function update() {
    const r = await mem.read([[ADDR.block, 2], [ADDR.dir, 2], [ADDR.grid, 1024 * ADDR.stride],
      [MON.x0 - 2, MON.size * MON.count], [ADDR.sceneFlag, 1]]);
    if (!r) { titleEl.textContent = "Mini-carte"; infoEl.textContent = "en attente du jeu…"; return; }
    const block = r[0][0] | r[0][1] << 8, dir = r[1][0] | r[1][1] << 8;
    const hash = readGrid(r[2]);
    monsters = readMonsters(r[3]);
    const inScene = r[4][0] === 1;
    const now = performance.now();
    if (hash !== lastHash && now - lastIdentify > 500) {
      const found = identify();
      if (found !== current) { renderItemList(found); if (found) found.spriteOf = null; }
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
    sendSceneTo3d(inScene ? current.scenes[block] || "" : null, near ? near.text : "");
    sendGridTo3d(current.level, hash);
    sendMonstersTo3d(current);
    sendTo3d(current.level, x, y, dir);
  }

  // Sprite de chaque type : quand un type a plusieurs sprites possibles (ex. ORC ou THUG
  // selon l'histoire), on cherche en mémoire lequel le jeu a chargé (une fois par niveau).
  let resolving = false;
  async function resolveSprites(L) {
    if (L.spriteOf || resolving) return;
    resolving = true;
    try {
      const spriteOf = {}, ambiguous = [];
      for (const [t, names] of Object.entries(L.monsterTypes)) {
        if (names.length === 1) spriteOf[t] = names[0]; else ambiguous.push([t, names]);
      }
      for (const [t, names] of ambiguous) {
        const sigs = names.map((n) => L.spriteSigs[n]).map((h) => (h ? Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16)) : null));
        const found = await mem.find(sigs.map((x) => x || new Uint8Array([0, 0, 0, 0])));
        if (!found) return;                       // jeu indisponible : on réessaiera
        const k = found.findIndex((a, i) => sigs[i] && a >= 0);
        spriteOf[t] = names[k >= 0 ? k : 0];
      }
      L.spriteOf = spriteOf;
    } finally { resolving = false; }
  }

  // Image fixe d'un lieu : null = exploration ; "" = scène sans image connue.
  let lastSceneSent;
  function sendSceneTo3d(image, label) {
    const key = `${image}|${label}`;
    if (key === lastSceneSent || !frame3d || !frame3d.contentWindow) return;
    lastSceneSent = key;
    frame3d.contentWindow.postMessage({ type: "lol-scene", image, label }, location.origin);
  }

  let lastMonSent = "";
  function sendMonstersTo3d(L) {
    resolveSprites(L);
    const list = monsters.map((m) => ({ ...m, sprite: (L.spriteOf || {})[m.type] || null }));
    const key = L.level + JSON.stringify(list);
    if (key === lastMonSent || !frame3d || !frame3d.contentWindow) return;
    lastMonSent = key;
    frame3d.contentWindow.postMessage({ type: "lol-monsters", level: L.level, list }, location.origin);
  }

  // État des murs et des portes : la grille vivante est envoyée à la vue 3D quand elle change.
  let lastGridSent = "";
  function sendGridTo3d(level, hash) {
    const key = `${level}:${hash}`;
    if (key === lastGridSent || !frame3d || !frame3d.contentWindow) return;
    lastGridSent = key;
    frame3d.contentWindow.postMessage({ type: "lol-grid", level, faces: live.slice() }, location.origin);
  }

  // Vue 3D sous le jeu : on ne lui envoie la position que lorsqu'elle change.
  let lastSent = "";
  function sendTo3d(level, x, y, dir) {
    const key = `${level}:${x}:${y}:${dir}`;
    if (key === lastSent || !frame3d || !frame3d.contentWindow) return;
    lastSent = key;
    frame3d.contentWindow.postMessage({ type: "lol-pos", level, x, y, dir }, location.origin);
  }
  if (frame3d) frame3d.addEventListener("load", () => { lastSent = ""; lastGridSent = ""; lastMonSent = ""; lastSceneSent = undefined; });

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

  // Fiches du groupe lues d'un bloc [char0 - 2, 4 × 130] : personnages actifs (drapeau 1, nom valide)
  function partyChars(block) {
    const out = [];
    for (let i = 0; i < INV.chars; i++) {
      const o = i * INV.charSize;                       // block[o] = drapeaux, block[o + 2] = nom
      let name = ""; for (let k = 0; k < INV.nameLen && block[o + 2 + k]; k++) name += String.fromCharCode(block[o + 2 + k]);
      if ((block[o] & 1) && /^[A-Za-z' -]{2,}$/.test(name)) out.push({ slot: i, name, at: (k) => block[o + 2 + k] });
    }
    return out;
  }
  const PARTY_RANGE = () => [INV.char0 - 2, INV.chars * INV.charSize];

  let lastInv = "";
  async function updateInventory() {
    if (!itemInfo || previewing) return;
    const r = await mem.read([[INV.bar, INV.barSlots * 2], [INV.hand, 2], [INV.items, INV.itemSize * INV.maxItems],
      PARTY_RANGE()]);
    if (!r) return;
    const [bar, hand, table, ch] = r;
    const typeOf = (id) => (id > 0 && id < INV.maxItems ? table[id * INV.itemSize] | table[id * INV.itemSize + 1] << 8 : -1);
    const barTypes = [];
    for (let k = 0; k < INV.barSlots; k++) barTypes.push(typeOf(bar[k * 2] | bar[k * 2 + 1] << 8));
    const handType = typeOf(hand[0] | hand[1] << 8);
    const party = partyChars(ch).map((c) => ({ name: c.name,
      eq: Array.from({ length: INV.equipSlots }, (_, k) => typeOf(c.at(INV.equipOffset + 2 * k) | c.at(INV.equipOffset + 2 * k + 1) << 8)) }));
    const key = JSON.stringify([barTypes, handType, party]);
    if (key === lastInv) return;          // on ne reconstruit la grille que si elle a changé
    lastInv = key;

    invBar.replaceChildren(...barTypes.map((t, k) => slot(t, `case ${k + 1}`)));
    invCount.textContent = `${barTypes.filter((t) => t >= 0).length} / ${INV.barSlots} cases occupées`;
    invHand.replaceChildren(slot(handType, "en main"));
    invChars.replaceChildren();
    for (const c of party) {
      const b = document.createElement("div"); b.className = "inv-sub"; b.textContent = `${c.name} — équipement`;
      const row = document.createElement("div"); row.className = "inv-grid";
      row.append(...c.eq.map((t, k) => slot(t, `emplacement ${k + 1}`)));
      invChars.append(b, row);
    }
  }

  // Débogage depuis la console : LoLMinimap.monsters() -> case, direction, type, sprite choisi
  function debugMonsters() {
    const L = current;
    return monsters.map((m) => ({ case: `${Math.floor(m.x)},${Math.floor(m.y)}`, dir: m.dir, type: m.type,
      sprite: L && L.spriteOf ? L.spriteOf[m.type] || "(aucun : type inconnu du niveau)" : "(en cours)",
      possibles: L ? (L.monsterTypes[m.type] || []).join("/") : "" }));
  }
  // --- Caractéristiques --------------------------------------------------------
  const stMoney = document.getElementById("st-money"), stChars = document.getElementById("st-chars");
  let lastStats = "";
  async function updateStats() {
    if (previewing) return;
    const r = await mem.read([PARTY_RANGE(), [STATS.money, 2]]);
    if (!r) return;
    const money = r[1][0] | r[1][1] << 8;
    const chars = partyChars(r[0]).map((c) => {
      const u16 = (k) => c.at(k) | c.at(k + 1) << 8, s16 = (k) => (u16(k) << 16) >> 16;
      const u32 = (k) => (u16(k) | u16(k + 2) << 16) >>> 0;
      let itemsMight = 0; for (let k = 0; k < 8; k++) itemsMight += u16(21 + 2 * k);
      return {
        name: c.name, hp: [s16(55), u16(57)], mp: [s16(59), u16(61)],
        force: Math.floor((u16(72) + itemsMight) * u16(68) / 256),
        prot: Math.floor((u16(74) + u16(53)) * u16(70) / 256),
        lv: [c.at(100), c.at(101), c.at(102)], xp: [u32(106), u32(110), u32(114)],
      };
    });
    if (!chars.length) return;
    const st = { money, chars };
    const key = JSON.stringify(st);
    if (key === lastStats) return;
    lastStats = key;
    stMoney.textContent = `${money} couronnes`;
    const bar = (cls, label, [cur, max]) => {
      const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
      return `<span>${label}</span><div class="bar ${cls}"><i style="width:${pct}%"></i><span>${cur} / ${max}</span></div>`;
    };
    stChars.innerHTML = st.chars.map((c) => {
      const cls = ["Guerrier", "Voleur", "Mage"].map((n, k) => `${n} ${c.lv[k]} (${c.xp[k]} xp)`).join(" · ");
      return `<div class="st-char"><div class="nm"></div>${bar("hp", "Vie", c.hp)}${bar("mp", "Magie", c.mp)}
        <span>Force</span><span>${c.force}</span><span>Protection</span><span>${c.prot}</span>
        <div class="st-skills">${cls}</div></div>`;
    }).join("");
    stChars.querySelectorAll(".nm").forEach((el, i) => { el.textContent = st.chars[i].name; });
  }
  setInterval(() => { updateStats().catch(() => {}); }, 1000);

  // --- Triches : vie / magie infinies ------------------------------------------
  // Toutes les 100 ms, vie (+55) et magie (+59) actuelles de chaque personnage du groupe sont remises
  // à leur maximum (+57, +61). Un coup qui ferait passer la vie sous zéro entre deux
  // écritures resterait mortel : c'est une vie « quasi » infinie.
  const cheatHp = document.getElementById("cheat-hp"), cheatMp = document.getElementById("cheat-mp");
  for (const [box, key] of [[cheatHp, "cheatHp"], [cheatMp, "cheatMp"]]) {
    try { box.checked = localStorage.getItem(key) === "on"; } catch (e) {}
    box.addEventListener("change", () => { try { localStorage.setItem(key, box.checked ? "on" : "off"); } catch (e) {} box.blur(); });
  }
  // +100 couronnes : le jeu relit la valeur (« Vous avez … couronnes »), mais ne redessine le
  // chiffre du tas de pièces qu'à sa prochaine transaction.
  document.getElementById("cheat-money").addEventListener("click", async (e) => {
    e.currentTarget.blur();
    const r = await mem.read([[STATS.money, 2]]);
    if (!r) return;
    const v = Math.min(65535, (r[0][0] | r[0][1] << 8) + 100);
    await mem.write([[STATS.money, new Uint8Array([v & 255, v >> 8])]]);
    lastStats = "";                      // rafraîchir l'affichage du panneau
    updateStats().catch(() => {});
  });

  let cheating = false;
  setInterval(async () => {
    if (cheating || previewing || !(cheatHp.checked || cheatMp.checked)) return;
    cheating = true;
    try {
      const r = await mem.read([PARTY_RANGE()]);
      if (!r) return;
      const writes = [];
      for (const c of partyChars(r[0])) {
        const base = INV.char0 + c.slot * INV.charSize;       // adresse du nom de ce personnage
        const at = (k) => c.at(k) | c.at(k + 1) << 8;
        const fill = (cur, max) => { const m = at(max); if (m > 0 && m < 1000 && at(cur) !== m) writes.push([base + cur, new Uint8Array([m & 255, m >> 8])]); };
        if (cheatHp.checked) fill(55, 57);
        if (cheatMp.checked) fill(59, 61);
      }
      if (writes.length) await mem.write(writes);
    } finally { cheating = false; }
  }, 100);

  window.LoLMinimap = { attach() {}, preview, monsters: debugMonsters };

  setInterval(() => { updateInventory().catch(() => {}); }, 1000);
  loadLevels().then(() => setInterval(tick, 200),
    (e) => { infoEl.textContent = "cartes introuvables (viewer/data) : " + e.message; });
})();
