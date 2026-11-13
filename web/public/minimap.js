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
  // Drapeaux d'histoire du jeu : mots de 16 bits en DS:0x804C (adresse physique 0x3E55C) ;
  // drapeau n = bit (n & 15) du mot n >> 4 (fonctions de script 0x07 écrire / 0x08 lire).
  const FLAGS = 0x3E55C;
  let CELL = 12;               // taille d'une case en pixels (réglable : boutons − / + de la mini-carte)
  const COLORS = { wall: "#2b2b2b", floor: "#8a7f68", doorOpen: "#d08a4a", doorClosed: "#a0522d",
    special: "#6f8f58", unknown: "#3a3550", fake: "#2f6b5c" };

  const canvas = document.getElementById("mm-canvas");
  const g = canvas.getContext("2d");
  const titleEl = document.querySelector("#mm-title span");
  const infoEl = document.getElementById("mm-info");
  const labelEl = document.getElementById("mm-label");
  const itemsEl = document.getElementById("mm-items");
  const itemsTitleEl = document.getElementById("mm-items-title");
  const frame3d = document.getElementById("v3d-frame");
  // Taille de la mini-carte : 8 à 24 px par case, mémorisée ; le panneau suit (variables CSS)
  const CELL_MIN = 8, CELL_MAX = 24;
  let lastDraw = [0, 0];
  function setCell(c) {
    CELL = Math.max(CELL_MIN, Math.min(CELL_MAX, c));
    canvas.width = canvas.height = 32 * CELL;
    document.documentElement.style.setProperty("--mm-size", 32 * CELL + "px");
    document.getElementById("mm-smaller").disabled = CELL <= CELL_MIN;
    document.getElementById("mm-bigger").disabled = CELL >= CELL_MAX;
    try { localStorage.setItem("minimapCell", String(CELL)); } catch (e) {}
    draw(lastDraw[0], lastDraw[1]);
    window.dispatchEvent(new Event("resize"));     // js-dos recalcule la taille du jeu
  }
  for (const [id, d] of [["mm-smaller", -2], ["mm-bigger", 2]])
    document.getElementById(id).addEventListener("click", (e) => { setCell(CELL + d); e.currentTarget.blur(); });

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
    const index = await getJSON("viewer/data/levels.json?v=20261109o");
    for (const l of index) {
      const d = await getJSON(`viewer/data/level${String(l.level).padStart(2, "0")}.json?v=20261109p`);
      levels.push({ level: l.level, name: l.name, fr: l.frName || l.name.split(" — ")[0], faces: Uint8Array.from(d.faces), wallTypes: d.wallTypes,
        labels: d.labels, places: numberPlaces(d.labels || []), groups: groupItems(d.items || []), monsterTypes: d.monsterTypes || {},
        spriteSigs: d.spriteSigs || {}, spriteConds: d.spriteConds || {}, spriteOf: null, scenes: d.scenes || {}, locks: d.locks || [],
        scripted: new Set(d.scripted || []), fragile: d.fragile || [], exits: d.exits || [],
        walls: d.walls || {}, chestItems: d.chestItems || {}, secrets: d.secrets || [], atlasCols: d.atlasCols, faceW: d.faceW, faceH: d.faceH });
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

  // Lieux nommés (annotations de la carte du jeu), numérotés dans l'ordre de lecture
  function numberPlaces(labels) {
    return labels.filter((l) => l.text && l.text !== "ENDROIT INVALIDE")
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((l, i) => ({ x: l.x, y: l.y, x2: l.x2, y2: l.y2, text: l.text, n: i + 1 }));
  }
  const placesEl = document.getElementById("mm-places");
  let hoverCell = -1, selKey = -1;             // selKey : clé choisie dans l'inventaire
  const niceName = (t) => t.charAt(0) + t.slice(1).toLowerCase();
  function renderPlaceList(L) {
    placesEl.textContent = "";
    if (!L || !L.places.length) {
      const li = document.createElement("li"); li.textContent = "aucun lieu nommé sur ce niveau"; placesEl.appendChild(li);
      return;
    }
    const shown = L.places.filter((p) => visible(L, p.y * 32 + p.x));
    if (!shown.length) {
      const li = document.createElement("li"); li.textContent = "aucun lieu découvert pour l'instant"; placesEl.appendChild(li);
      return;
    }
    for (const p of shown) {
      const li = document.createElement("li");
      li.dataset.cell = p.y * 32 + p.x;
      const b = document.createElement("b"); b.textContent = p.n;
      const t = document.createElement("span"); t.textContent = niceName(p.text); t.title = `case ${p.x},${p.y}`;
      li.append(b, t);
      li.addEventListener("mouseenter", (e) => {
        hoverCell = p.y * 32 + p.x; draw(lastDraw[0], lastDraw[1]);
        const r = li.getBoundingClientRect();
        showTip(`<b>Lieu ${p.n} : ${escHtml(niceName(p.text))}</b> <span class="t">· case ${p.x},${p.y}</span>` + placeFigure(L, p), r.right, r.top);
      });
      li.addEventListener("mouseleave", () => { hoverCell = -1; draw(lastDraw[0], lastDraw[1]); tipEl.hidden = true; });
      placesEl.appendChild(li);
    }
  }

  // Catégories d'objets (d'après la fiche, tools/item_info.py) et icône du jeu qui les représente
  const iconSheet = new Image();
  iconSheet.src = "viewer/data/item_icons.png";
  iconSheet.onload = () => { draw(lastDraw[0], lastDraw[1]); if (current) renderItemList(current); };
  const CATEGORIES = {
    arme: { label: "arme", icon: 5 }, armure: { label: "armure", icon: 19 }, soin: { label: "soin", icon: 30 },
    cle: { label: "clé", icon: 60 }, parchemin: { label: "parchemin, texte", icon: 34 }, anneau: { label: "anneau", icon: 82 },
    magie: { label: "objet magique", icon: 27 }, divers: { label: "trésor, quête, divers", icon: 103 },
  };
  function itemCategory(type) {
    const k = itemInfo && itemInfo[type] ? itemInfo[type].kind || "" : "";
    if (/^Arme|Munition/.test(k)) return CATEGORIES.arme;
    if (/^(Corps|Tête|Bouclier|Pieds|Poignets|Cou)/.test(k)) return CATEGORIES.armure;
    if (/^Soin/.test(k)) return CATEGORIES.soin;
    if (k === "Clé") return CATEGORIES.cle;
    if (/Parchemin|Texte/.test(k)) return CATEGORIES.parchemin;
    if (/anneau/.test(k)) return CATEGORIES.anneau;
    if (/Baguette|magique/.test(k)) return CATEGORIES.magie;
    return CATEGORIES.divers;
  }
  // icône d'une case d'objets : celle de l'objet lui-même (ITEMICN.SHP) si la case ne contient
  // qu'un seul type d'objet, sinon celle de la catégorie du premier objet
  function groupIcon(grp) {
    const t = grp.items[0].type;
    if (itemInfo && itemInfo[t] && itemInfo[t].icon >= 0 && grp.items.every((it) => it.type === t))
      return { icon: itemInfo[t].icon, label: itemInfo[t].name + (grp.items.length > 1 ? ` (×${grp.items.length})` : ""), own: true };
    return itemCategory(t);
  }

  function renderItemList(L) {
    renderPlaceList(L);
    itemsEl.textContent = "";
    itemsTitleEl.textContent = L && L.live ? "Objets au sol et dans les niches (état réel)" : "Objets du niveau (positions de départ)";
    if (!L || !L.groups.length) {
      const li = document.createElement("li"); li.textContent = "aucun objet placé sur ce niveau"; itemsEl.appendChild(li);
      return;
    }
    const shown = L.groups.filter((gr) => visible(L, gr.y * 32 + gr.x));
    if (!shown.length) {
      const li = document.createElement("li"); li.textContent = "aucun objet découvert pour l'instant"; itemsEl.appendChild(li);
      return;
    }
    for (const g of shown) {
      const li = document.createElement("li");
      li.dataset.cell = g.y * 32 + g.x;
      const b = document.createElement("b"); b.textContent = g.n + ".";
      const ic = document.createElement("i"); ic.className = "cat";
      if (itemInfo) {
        const cat = groupIcon(g);
        ic.style.backgroundPosition = `-${(cat.icon % 16) * 16}px -${Math.floor(cat.icon / 16) * 16}px`;
        ic.title = cat.label;
      }
      const names = new Map();
      for (const it of g.items) {
        const label = (it.name || `objet ${it.type}`) + (it.spawn === "event" ? " (événement)" : "");
        names.set(label, (names.get(label) || 0) + 1);
      }
      const t = document.createElement("span");
      t.textContent = [...names].map(([k, c]) => (c > 1 ? `${c} × ` : "") + k).join(", ")
        + (g.items[0].container === "wall" ? " — dans un mur (niche)" : "")
        + (g.items[0].container === "chest" ? " — dans un coffre" : "")
        + (g.items[0].container === "niche"
          ? (DIRS[g.items[0].face] ? ` — niche, face ${DIRS[g.items[0].face]}` : " — dans un mur") : "");
      const pos = document.createElement("span"); pos.className = "pos"; pos.textContent = `${g.x},${g.y}`;
      li.append(b, ic, t, pos);
      itemsEl.appendChild(li);
    }
  }

  // Objets réellement présents (§ 12.2) : octets 4-5 d'une case de la grille vivante = premier
  // objet posé (n° d'entrée, 0x8000 = monstre), chaîné par le champ « suivant » (+0) de l'entrée.
  // Entrée de 16 octets : +0 suivant, +5 case, +7 x, +9 y (case*256 + décalage), +12 type.
  const ITEMS = { base: INV.items - 12, size: 16 };
  function readLiveItems(grid, table) {
    if (!itemInfo) return null;
    const out = [];
    const w = (o) => table[o] | table[o + 1] << 8;
    for (let c = 0; c < 1024; c++) {
      let id = grid[c * ADDR.stride + 4] | grid[c * ADDR.stride + 5] << 8;
      for (let guard = 0; id && !(id & 0x8000) && id < INV.maxItems && guard < 64; guard++) {
        const o = id * ITEMS.size, type = w(o + 12);
        if (type > 0 && type < itemInfo.length) {
          const wall = cellClass(current, c) === "wall" || cellClass(current, c) === "special";
          const chest = [0, 1, 2, 3].some((f) => chestState(current, c, f) >= 0);
          out.push({ x: c % 32, y: c >> 5, type, name: itemInfo[type].name,
            xOffs: table[o + 7], yOffs: table[o + 9], container: chest ? "chest" : wall ? "wall" : undefined });
        }
        id = w(o);
      }
    }
    return out;
  }

  function readGrid(bytes) {
    let hash = 0;
    for (let i = 0; i < 1024; i++) {
      const a = i * ADDR.stride;
      for (let k = 0; k < 4; k++) { const v = bytes[a + k]; live[i * 4 + k] = v; hash = (hash * 31 + v) | 0; }
      gameSeen[i] = bytes[a + 9] & 7 ? 1 : 0;
    }
    return hash;
  }

  // Le niveau courant est celui dont la grille d'origine ressemble le plus à la grille vivante
  // (les portes ouvertes changent quelques identifiants, d'où un seuil et non une égalité).
  // Seules les cases « parlantes » comptent : la roche pleine, identique d'un niveau à l'autre
  // du même décor, faisait confondre les cavernes (963 cases sur 1024 communes aux niveaux 5 et 25).
  // Score = cases identiques / cases où la carte d'origine OU la grille vivante n'est pas de la roche.
  function fillOf(L) {
    if (L.fill) return L.fill;
    const count = new Map();
    for (let i = 0; i < 1024; i++) { const k = L.faces.slice(i * 4, i * 4 + 4).join(","); count.set(k, (count.get(k) || 0) + 1); }
    L.fill = [...count].sort((a, b) => b[1] - a[1])[0][0].split(",").map(Number);
    return L.fill;
  }
  function identify() {
    let best = null, bestScore = 0;
    for (const L of levels) {
      const f = fillOf(L);
      let same = 0, total = 0;
      for (let i = 0; i < 1024; i++) {
        const o = i * 4;
        let eq = true, lf = true, vf = true;
        for (let k = 0; k < 4; k++) {
          if (L.faces[o + k] !== live[o + k]) eq = false;
          if (L.faces[o + k] !== f[k]) lf = false;
          if (live[o + k] !== f[k]) vf = false;
        }
        if (lf && vf) continue;
        total++; if (eq) same++;
      }
      const score = total ? same / total : 0;
      if (score > bestScore) { bestScore = score; best = L; }
    }
    return bestScore > 0.8 ? best : null;
  }

  // Type spécial d'une face de mur (WLL, champ « special ») : 2/3 = levier (l'état change dans la
  // grille vivante quand on l'actionne), 1/4 = élément cliquable ; gardé seulement si la case a un script.
  function switchKind(L, i, f) {
    const id = live[i * 4 + f], t = id && L.wallTypes[id];
    if (!t) return null;
    if (t[2] === 210) return null;                      // coffre : affiché à part
    if (t[1] === 2 || t[1] === 3) return "lever";
    if ((t[1] === 1 || t[1] === 4) && L.scripted.has(i)) return "button";
    return null;
  }

  // Coffres : types de mur dont le symbole de carte (automap) vaut 210 ; chaque décor en définit 4,
  // dans l'ordre : fermé, ouvert, ouvert (vide ?), cassé (§ 6). -1 = pas de coffre sur cette face.
  const CHEST_FR = ["fermé", "ouvert", "ouvert (vide ?)", "cassé"];
  function chestIds(L) {
    if (!L.chestIds) L.chestIds = Object.entries(L.wallTypes).filter(([, t]) => t && t[2] === 210).map(([k]) => +k).sort((a, b) => a - b);
    return L.chestIds;
  }
  function chestState(L, i, f) {
    const id = live[i * 4 + f];
    return id ? chestIds(L).indexOf(id) : -1;
  }
  // Escaliers et trous : symbole de carte du type de mur posé au sol (automap) : 25 = escalier
  // qui monte, 26 = escalier qui descend (positions qui se répondent d'un niveau à l'autre),
  // 11 = trou ou trappe (chute au niveau inférieur, fonction 0x3C des scripts).
  function floorMark(L, i) {
    let mark = null;
    for (let f = 0; f < 4; f++) {
      const t = L.wallTypes[live[i * 4 + f]];
      if (!t) continue;
      if (t[2] === 25) return "up";
      if (t[2] === 26) return "down";
      if (t[2] === 11) mark = "hole";
      if (t[2] === 17) mark = "teleport";       // téléporteur (symbole 17, sol invisible)
    }
    return mark;
  }
  function isWallCell(L, i) { const c = cellClass(L, i); return c === "wall" || c === "special" || c === "unknown"; }

  // État d'un monstre (octet +13 depuis x, § 12.2) : 1 = paisible (n'attaque pas pour l'instant ;
  // les gardes du château y restent) ; 7 = marche vers le groupe, 8 = l'attaque (vu en attaquant
  // un garde). Les autres valeurs (2, 3, 4… données par les scripts) ne sont pas identifiées.
  function monsterMood(m) {
    if (m.mode === 1) return { color: "#4ade80", label: "paisible (n'attaque pas pour l'instant)" };
    if (m.mode === 7 || m.mode === 8) return { color: "#ff3b30", label: m.mode === 8 ? "attaque le groupe" : "marche vers le groupe (hostile)" };
    return { color: "#ff8c00", label: `autre état (mode ${m.mode})` };
  }

  // Faux murs : face dessinée comme un mur plein (texture opaque) mais qui ne bloque pas le
  // passage (bit 0 des drapeaux à 0) ; escaliers exclus (symboles 25/26). On les traverse.
  function isFakeFace(L, id) {
    const w = id && L.walls[id], t = id && L.wallTypes[id];
    return !!(w && t && w.opaque && !w.block && w.tex >= 0 && t[2] !== 25 && t[2] !== 26);
  }
  function fakeFaces(L, i) {
    const out = [];
    for (let f = 0; f < 4; f++) if (isFakeFace(L, live[i * 4 + f])) out.push(f);
    return out;
  }
  // Passages secrets ouverts par script (tools/hidden_walls.py) : mur effacé par setWall
  function secretAt(L, i) { return L.secrets.find((s) => s.y * 32 + s.x === i); }

  function cellClass(L, i) {
    if (fakeFaces(L, i).length) return "fake";
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

  // --- Exploration progressive (brouillard) -------------------------------------
  // Seules les cases déjà vues sont dessinées, avec leurs repères (lieux, objets, monstres…).
  // Cases vues : celle du groupe, ses 8 voisines (une diagonale si un des deux côtés est ouvert,
  // comme la carte automatique du jeu, updateAutoMap) et jusqu'à 3 cases devant lui avec leurs
  // côtés (profondeur de la vue), arrêt au premier mur ou porte fermée. S'y ajoutent les marques
  // de la carte automatique du jeu (octet 9 de la case, & 7) quand le jeu les pose.
  // Mémorisé par moteur et par niveau (localStorage) ; ↺ oublie le niveau affiché.
  const SEEN_KEY = (level) => `minimapSeen:${window.LOL_ENGINE || "dosbox"}:${level}`;
  const seenOf = new Map();                     // n° de niveau -> Uint8Array(1024)
  const gameSeen = new Uint8Array(1024);        // marques du jeu dans la grille vivante
  let fogOn = true;
  try { fogOn = localStorage.getItem("minimapFog") !== "0"; } catch (e) {}
  function seenFor(L) {
    let s = seenOf.get(L.level);
    if (!s) {
      s = new Uint8Array(1024);
      try { const t = localStorage.getItem(SEEN_KEY(L.level)) || ""; for (let i = 0; i < t.length && i < 1024; i++) s[i] = t[i] === "1" ? 1 : 0; } catch (e) {}
      seenOf.set(L.level, s);
    }
    return s;
  }
  function saveSeen(L) {
    try { localStorage.setItem(SEEN_KEY(L.level), Array.from(seenFor(L), (v) => v ? "1" : "0").join("").replace(/0+$/, "")); } catch (e) {}
  }
  const visible = (L, i) => !fogOn || !L || seenFor(L)[i] === 1;
  function opaque(L, i) { const c = cellClass(L, i); return c === "wall" || c === "special" || c === "unknown" || c === "doorClosed" || c === "fake"; }
  // renvoie true si de nouvelles cases ont été découvertes
  function explore(L, block, dir) {
    const s = seenFor(L);
    let added = 0;
    const mark = (x, y) => { if (x < 0 || y < 0 || x > 31 || y > 31) return; const i = y * 32 + x; if (!s[i]) { s[i] = 1; added++; } };
    for (let i = 0; i < 1024; i++) if (gameSeen[i] && !s[i]) { s[i] = 1; added++; }
    const x = block % 32, y = block >> 5;
    const open = (cx, cy) => cx >= 0 && cy >= 0 && cx <= 31 && cy <= 31 && !opaque(L, cy * 32 + cx);
    mark(x, y);
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) mark(x + dx, y + dy);
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) if (open(x + dx, y) || open(x, y + dy)) mark(x + dx, y + dy);
    const [fx, fy] = [[0, -1], [1, 0], [0, 1], [-1, 0]][dir & 3];
    let px = x, py = y;
    for (let step = 1; step <= 3; step++) {
      px += fx; py += fy;
      if (px < 0 || py < 0 || px > 31 || py > 31) break;
      mark(px, py);
      if (opaque(L, py * 32 + px)) break;
      mark(px + fy, py - fx); mark(px - fy, py + fx);   // côtés gauche et droit
    }
    if (added) saveSeen(L);
    return added > 0;
  }
  const fogBtn = document.getElementById("mm-fog"), forgetBtn = document.getElementById("mm-forget");
  let fogKey = "";
  function refreshFog() {
    fogBtn.classList.toggle("on", fogOn);
    forgetBtn.disabled = !fogOn || !current;
    fogKey = "";
    if (current) renderItemList(current);
    draw(lastDraw[0], lastDraw[1]);
  }
  fogBtn.addEventListener("click", (e) => {
    fogOn = !fogOn;
    try { localStorage.setItem("minimapFog", fogOn ? "1" : "0"); } catch (err) {}
    refreshFog(); e.currentTarget.blur();
  });
  forgetBtn.addEventListener("click", (e) => {
    e.currentTarget.blur();
    if (!current || !confirm(`Oublier l'exploration du niveau ${current.level} (${current.fr}) sur la mini-carte ?`)) return;
    seenFor(current).fill(0); saveSeen(current);
    if (lastDraw[0] < 1024) explore(current, lastDraw[0], lastDraw[1]);
    refreshFog();
  });
  fogBtn.classList.toggle("on", fogOn);
  // clé des lieux et objets visibles : la liste est refaite quand elle change
  const fogListKey = (L) => fogOn ? L.places.filter((p) => visible(L, p.y * 32 + p.x)).length + "/" + L.groups.filter((gr) => visible(L, gr.y * 32 + gr.x)).length : "";

  // --- Cases illustrées avec les graphismes du lieu ----------------------------
  // Textures exportées pour la vue 3D (viewer/data) : sol 64×64 (moitié basse = dalles vues de
  // près) et planche des faces de murs (128×96 par face, n° de face = walls[id].tex).
  let texMode = true;
  try { texMode = localStorage.getItem("minimapTex") !== "0"; } catch (e) {}
  const texBtn = document.getElementById("mm-tex");
  const setTexMode = (on) => {
    texMode = on; texBtn.classList.toggle("on", on);
    try { localStorage.setItem("minimapTex", on ? "1" : "0"); } catch (e) {}
    draw(lastDraw[0], lastDraw[1]);
  };
  texBtn.addEventListener("click", (e) => { setTexMode(!texMode); e.currentTarget.blur(); });
  texBtn.classList.toggle("on", texMode);

  function levelImages(L) {
    if (L.img) return L.img.ready ? L.img : null;
    const nn = String(L.level).padStart(2, "0"), img = { ready: false, tiles: null };
    L.img = img;
    const load = (name) => new Promise((ok, ko) => { const im = new Image(); im.onload = () => ok(im); im.onerror = ko;
      im.src = `viewer/data/level${nn}_${name}.png?v=20261109e`; });
    Promise.all([load("floor"), load("walls")]).then(([floor, walls]) => {
      Object.assign(img, { floor, walls, ready: true });
      if (current === L) draw(lastDraw[0], lastDraw[1]);
    }, () => {});
    return null;
  }
  // texture de mur « de base » du niveau : la face opaque, non porte, la plus fréquente
  function baseWallTex(L) {
    if (L.baseTex != null) return L.baseTex;
    const n = new Map();
    for (const id of L.faces) { const w = L.walls[id]; if (w && w.opaque && !w.door && w.tex >= 0) n.set(w.tex, (n.get(w.tex) || 0) + 1); }
    L.baseTex = n.size ? [...n].sort((a, b) => b[1] - a[1])[0][0] : -1;
    return L.baseTex;
  }
  // tuiles à la taille courante des cases, mises en cache par niveau
  function tile(L, img, key, paint) {
    if (!img.tiles || img.tiles.cell !== CELL) img.tiles = { cell: CELL, map: new Map() };
    let c = img.tiles.map.get(key);
    if (!c) {
      c = document.createElement("canvas"); c.width = c.height = CELL - 1;
      const t = c.getContext("2d"); t.imageSmoothingEnabled = true; t.imageSmoothingQuality = "high";
      paint(t, CELL - 1); img.tiles.map.set(key, c);
    }
    return c;
  }
  const face = (L, img, t, tex, s, crop) => {          // crop : [x, y, l, h] dans la face 128×96
    const fx = (tex % L.atlasCols) * L.faceW, fy = Math.floor(tex / L.atlasCols) * L.faceH;
    const [cx, cy, cw, ch] = crop || [0, 0, L.faceW, L.faceH];
    t.drawImage(img.walls, fx + cx, fy + cy, cw, ch, 0, 0, s, s);
  };
  const floorTile = (L, img) => tile(L, img, "floor", (t, s) => {
    t.drawImage(img.floor, 0, 32, 64, 32, 0, 0, s, s);
    t.fillStyle = "rgba(255,236,190,.22)"; t.fillRect(0, 0, s, s); });
  function cellTile(L, img, i, cls) {
    if (cls === "floor") return floorTile(L, img);
    if (cls === "special") return tile(L, img, "special", (t, s) => {
      t.drawImage(floorTile(L, img), 0, 0); t.fillStyle = "rgba(111,143,88,.45)"; t.fillRect(0, 0, s, s); });
    if (cls === "fake") {
      const tex = baseWallTex(L);
      if (tex < 0) return null;
      return tile(L, img, "fake", (t, s) => {
        face(L, img, t, tex, s, [32, 16, 64, 64]);
        t.fillStyle = "rgba(0,0,0,.6)"; t.fillRect(0, 0, s, s);
        t.fillStyle = "rgba(94,242,194,.28)"; t.fillRect(0, 0, s, s); });
    }
    if (cls === "wall") {
      const tex = baseWallTex(L);
      if (tex < 0) return null;
      return tile(L, img, "wall", (t, s) => {
        face(L, img, t, tex, s, [32, 16, 64, 64]);
        t.fillStyle = "rgba(0,0,0,.72)"; t.fillRect(0, 0, s, s); });
    }
    if (cls === "doorClosed" || cls === "doorOpen") {
      let w = null;
      for (let k = 0; k < 4 && !w; k++) { const v = L.walls[live[i * 4 + k]]; if (v && v.door && v.tex >= 0) w = v; }
      const tex = w ? (cls === "doorOpen" && w.openTex != null ? w.openTex : w.tex) : -1;
      return tile(L, img, cls + tex, (t, s) => {
        t.drawImage(floorTile(L, img), 0, 0);
        if (tex >= 0 && cls === "doorClosed") face(L, img, t, tex, s, [16, 0, 96, 96]);
        t.strokeStyle = COLORS[cls]; t.lineWidth = Math.max(1, s / 8); t.strokeRect(0.5, 0.5, s - 1, s - 1);
      });
    }
    return null;
  }

  function draw(block, dir) {
    lastDraw = [block, dir];
    const L = current, k = CELL / 12;
    g.fillStyle = "#000"; g.fillRect(0, 0, canvas.width, canvas.height);
    if (!L) return;
    const img = texMode ? levelImages(L) : null;
    for (let i = 0; i < 1024; i++) {
      const cls = cellClass(L, i), x = (i % 32) * CELL, y = Math.floor(i / 32) * CELL;
      if (!visible(L, i)) { g.fillStyle = "#15120e"; g.fillRect(x, y, CELL - 1, CELL - 1); continue; }
      const tl = img && cellTile(L, img, i, cls);
      if (tl) g.drawImage(tl, x, y);
      else { g.fillStyle = COLORS[cls]; g.fillRect(x, y, CELL - 1, CELL - 1); }
    }
    g.fillStyle = "#d22";
    // lieux : carré rouge numéroté
    const lp2 = Math.max(1, Math.round(k));
    g.font = `bold ${Math.round(9 * k)}px system-ui, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
    for (const p of L.places) {
      if (!visible(L, p.y * 32 + p.x)) continue;
      g.fillStyle = "#d22";
      g.fillRect(p.x * CELL + lp2 - 1, p.y * CELL + lp2 - 1, CELL + 1 - 2 * lp2, CELL + 1 - 2 * lp2);
      g.fillStyle = "#fff";
      g.fillText(String(p.n), p.x * CELL + CELL / 2, p.y * CELL + CELL / 2 + 0.5);
    }
    // interrupteurs : leviers (barre verte) et éléments cliquables à script (point violet), sur le bord du mur
    for (let i = 0; i < 1024; i++) for (let f = 0; f < 4; f++) {
      const kind = switchKind(L, i, f);
      if (!kind || !visible(L, i)) continue;
      const x0 = (i % 32) * CELL, y0 = Math.floor(i / 32) * CELL, t = Math.max(2, Math.round(2.5 * k));
      const m = Math.round(CELL * 0.2), len = CELL - 1 - 2 * m;
      const [rx, ry, rw, rh] = [[x0 + m, y0, len, t], [x0 + CELL - 1 - t, y0 + m, t, len],
        [x0 + m, y0 + CELL - 1 - t, len, t], [x0, y0 + m, t, len]][f];
      if (kind === "lever") { g.fillStyle = "#000"; g.fillRect(rx - 1, ry - 1, rw + 2, rh + 2); g.fillStyle = "#7cfc00"; g.fillRect(rx, ry, rw, rh); }
      else {
        g.fillStyle = "#c77dff"; g.beginPath();
        g.arc(rx + rw / 2, ry + rh / 2, Math.max(1.5, 1.6 * k), 0, 2 * Math.PI); g.fill();
      }
    }
    // murs fragiles (à casser au Marteau…) : fissure orange, tant que le mur est debout
    g.strokeStyle = "#ff7a1a"; g.lineWidth = Math.max(1.5, 1.6 * k);
    for (const fw of L.fragile) {
      if (!isWallCell(L, fw.y * 32 + fw.x) || !visible(L, fw.y * 32 + fw.x)) continue;
      const x0 = fw.x * CELL, y0 = fw.y * CELL, c = CELL - 1;
      g.beginPath(); g.moveTo(x0 + c * 0.2, y0 + c * 0.1); g.lineTo(x0 + c * 0.55, y0 + c * 0.4);
      g.lineTo(x0 + c * 0.35, y0 + c * 0.6); g.lineTo(x0 + c * 0.8, y0 + c * 0.9); g.stroke();
    }
    // passages cachés (vert d'eau) : faux murs = côtés traversables en pointillés + flèche ;
    // murs effacés par un script = cadre pointillé tant que le mur est debout
    const SECRET = "#5ef2c2";
    g.save(); g.lineWidth = Math.max(2, 2 * k); g.setLineDash([Math.max(2, CELL / 5), Math.max(1.5, CELL / 7)]);
    for (let i = 0; i < 1024; i++) {
      const ff = fakeFaces(L, i);
      if (!ff.length || !visible(L, i)) continue;
      const x0 = (i % 32) * CELL + 0.5, y0 = Math.floor(i / 32) * CELL + 0.5, c = CELL - 2;
      g.strokeStyle = SECRET;
      for (const f of ff) {
        const [ax, ay, bx, by] = [[x0, y0, x0 + c, y0], [x0 + c, y0, x0 + c, y0 + c], [x0, y0 + c, x0 + c, y0 + c], [x0, y0, x0, y0 + c]][f];
        g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      }
      // traversée : trait plein entre les côtés ouverts
      g.save(); g.setLineDash([]); g.lineWidth = Math.max(1, k); g.strokeStyle = "rgba(94,242,194,.8)";
      const mid = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]], cx = x0 + c / 2, cy = y0 + c / 2;
      g.beginPath();
      for (const f of ff) { g.moveTo(cx, cy); g.lineTo(x0 + mid[f][0] * c, y0 + mid[f][1] * c); }
      g.stroke(); g.restore();
    }
    for (const sw of L.secrets) {
      const i = sw.y * 32 + sw.x;
      if (!isWallCell(L, i) || !visible(L, i) || L.fragile.some((fw) => fw.x === sw.x && fw.y === sw.y)) continue;
      const x0 = sw.x * CELL + 1.5, y0 = sw.y * CELL + 1.5, c = CELL - 4;
      g.strokeStyle = "#000"; g.setLineDash([]); g.lineWidth = Math.max(2.5, 2.4 * k); g.strokeRect(x0, y0, c, c);
      g.strokeStyle = SECRET; g.lineWidth = Math.max(1.5, 1.4 * k); g.setLineDash([Math.max(2, CELL / 5), Math.max(1.5, CELL / 7)]);
      g.strokeRect(x0, y0, c, c);
    }
    g.restore();
    // escaliers (triangle), trous (cercle sombre), passages scriptés vers un autre niveau (losange)
    for (let i = 0; i < 1024; i++) {
      const mk = floorMark(L, i);
      if (!mk || !visible(L, i)) continue;
      const cx = (i % 32) * CELL + (CELL - 1) / 2, cy = Math.floor(i / 32) * CELL + (CELL - 1) / 2, r = CELL * 0.42;
      g.lineWidth = 1.2; g.strokeStyle = "#000";
      if (mk === "teleport") continue;          // dessiné avec les passages, plus bas
      if (mk === "hole") {
        g.fillStyle = "#111"; g.beginPath(); g.arc(cx, cy, r * 0.8, 0, 2 * Math.PI); g.fill();
        g.strokeStyle = "#9a9a9a"; g.stroke();
        continue;
      }
      g.fillStyle = mk === "up" ? "#8fe3ff" : "#c58cff";
      g.beginPath();
      if (mk === "up") { g.moveTo(cx, cy - r); g.lineTo(cx + r, cy + r * 0.8); g.lineTo(cx - r, cy + r * 0.8); }
      else { g.moveTo(cx, cy + r); g.lineTo(cx + r, cy - r * 0.8); g.lineTo(cx - r, cy - r * 0.8); }
      g.closePath(); g.fill(); g.stroke();
    }
    // téléporteurs : tourbillon magenta ; destination dans le niveau = cercle creux relié en pointillés
    const ctr = (x, y) => [x * CELL + (CELL - 1) / 2, y * CELL + (CELL - 1) / 2];
    const portals = new Set();
    for (let i = 0; i < 1024; i++) if (floorMark(L, i) === "teleport" && visible(L, i)) portals.add(i);
    const exits = L.exits.filter((e) => visible(L, e.y * 32 + e.x));
    for (const e of exits) if (e.teleport) portals.add(e.y * 32 + e.x);
    g.save(); g.setLineDash([Math.max(2, CELL / 4), Math.max(2, CELL / 5)]); g.lineWidth = Math.max(1, CELL / 10);
    for (const e of exits) if (e.teleport) {
      const [ax, ay] = ctr(e.x, e.y), [bx, by] = ctr(e.tx, e.ty);
      g.strokeStyle = "rgba(255,79,216,.75)"; g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    }
    g.restore();
    for (const e of exits) if (e.teleport) {
      const [bx, by] = ctr(e.tx, e.ty);
      g.lineWidth = Math.max(1.5, CELL / 8); g.strokeStyle = "#000";
      g.beginPath(); g.arc(bx, by, CELL * 0.3, 0, 2 * Math.PI); g.stroke();
      g.lineWidth = Math.max(1, CELL / 12); g.strokeStyle = "#ff4fd8"; g.stroke();
    }
    for (const i of portals) {
      const [cx, cy] = ctr(i % 32, Math.floor(i / 32)), r = CELL * 0.46;
      const grd = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      grd.addColorStop(0, "#fff"); grd.addColorStop(0.35, "#ff4fd8"); grd.addColorStop(1, "rgba(90,0,120,.9)");
      g.fillStyle = grd; g.strokeStyle = "#000"; g.lineWidth = 1;
      g.beginPath(); g.arc(cx, cy, r, 0, 2 * Math.PI); g.fill(); g.stroke();
      g.strokeStyle = "#fff"; g.lineWidth = Math.max(1, CELL / 14); g.beginPath();   // spirale
      for (let a = 0; a <= 4 * Math.PI; a += 0.3) { const rr = r * 0.85 * a / (4 * Math.PI); g.lineTo(cx + rr * Math.cos(a), cy + rr * Math.sin(a)); }
      g.stroke();
    }
    for (const e of exits) {
      if (portals.has(e.y * 32 + e.x)) continue;
      const cx = e.x * CELL + (CELL - 1) / 2, cy = e.y * CELL + (CELL - 1) / 2, r = CELL * 0.32;
      g.fillStyle = "#fff"; g.strokeStyle = "#000"; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(cx, cy - r); g.lineTo(cx + r, cy); g.lineTo(cx, cy + r); g.lineTo(cx - r, cy); g.closePath(); g.fill(); g.stroke();
    }
    // coffres (symbole 210 de la carte du jeu) : petite malle contre la face, couleur selon l'état
    for (let i = 0; i < 1024; i++) for (let f = 0; f < 4; f++) {
      const st = chestState(L, i, f);
      if (st < 0 || !visible(L, i)) continue;
      const x0 = (i % 32) * CELL, y0 = Math.floor(i / 32) * CELL, w = CELL * 0.62, h = CELL * 0.42;
      const cx = x0 + (CELL - 1) / 2 + [0, 1, 0, -1][f] * (CELL - 1 - w) / 2;
      const cy = y0 + (CELL - 1) / 2 + [-1, 0, 1, 0][f] * (CELL - 1 - h) / 2;
      const [body, band] = [["#8b5a2b", "#ffd700"], ["#c08a4a", "#7cfc00"], ["#c08a4a", "#7cfc00"], ["#6b6b6b", "#999"]][st] || ["#8b5a2b", "#ffd700"];
      g.fillStyle = "#000"; g.fillRect(cx - w / 2 - 1, cy - h / 2 - 1, w + 2, h + 2);
      g.fillStyle = body; g.fillRect(cx - w / 2, cy - h / 2, w, h);
      g.fillStyle = band; g.fillRect(cx - w / 2, cy - h * 0.12, w, Math.max(1, h * 0.24));
    }
    // serrures : petite clé dorée dans le coin de la case
    g.strokeStyle = "#ffd700"; g.fillStyle = "#ffd700"; g.lineWidth = Math.max(1, k);
    for (const c of new Set(L.locks.map((l) => l.y * 32 + l.x).filter((c) => visible(L, c)))) {
      const x0 = (c % 32) * CELL, y0 = Math.floor(c / 32) * CELL, r = 2 * k;
      g.beginPath(); g.arc(x0 + r + 1, y0 + r + 1, r, 0, 2 * Math.PI); g.stroke();
      g.beginPath(); g.moveTo(x0 + 2 * r + 1, y0 + r + 1); g.lineTo(x0 + CELL - 2, y0 + r + 1);
      g.lineTo(x0 + CELL - 2, y0 + 2 * r + 1); g.stroke();
    }
    // serrures de la clé sélectionnée dans l'inventaire : cercle doré clignotant
    if (selKey >= 0) {
      const on = Math.floor(performance.now() / 400) % 2 === 0;
      for (const l of L.locks) if (l.key === selKey && visible(L, l.y * 32 + l.x)) {
        const cx = l.x * CELL + CELL / 2, cy = l.y * CELL + CELL / 2;
        g.strokeStyle = "#000"; g.lineWidth = 4;
        g.beginPath(); g.arc(cx, cy, CELL * (on ? 1.1 : 0.9), 0, 2 * Math.PI); g.stroke();
        g.strokeStyle = on ? "#ffd700" : "#fff2a0"; g.lineWidth = 2;
        g.beginPath(); g.arc(cx, cy, CELL * (on ? 1.1 : 0.9), 0, 2 * Math.PI); g.stroke();
      }
    }
    if (hoverCell >= 0) {                       // lieu survolé dans la liste
      g.strokeStyle = "#ffd700"; g.lineWidth = 2;
      g.strokeRect((hoverCell % 32) * CELL - 2, Math.floor(hoverCell / 32) * CELL - 2, CELL + 3, CELL + 3);
    }
    // objets : numéro du groupe sur sa case
    g.font = `bold ${Math.round(9 * k)}px system-ui, sans-serif`; g.textAlign = "center"; g.textBaseline = "middle";
    g.lineWidth = 3 * Math.min(1, k); g.strokeStyle = "#000";
    // objets : icône de la catégorie du premier objet de la case (icônes du jeu), numéro en coin
    const iconOk = iconSheet.complete && iconSheet.naturalWidth > 0 && itemInfo;
    for (const it of L.groups) {
      if (!visible(L, it.y * 32 + it.x)) continue;
      const tx = it.x * CELL + CELL / 2, ty = it.y * CELL + CELL / 2 + 0.5;
      if (iconOk) {
        const cat = groupIcon(it), sz = CELL + 2, ix = it.x * CELL - 1, iy = it.y * CELL - 1;
        g.fillStyle = "rgba(10, 30, 32, .85)"; g.fillRect(ix, iy, sz, sz);
        g.strokeStyle = cat.own ? "#e8dcc0" : "#28dce6"; g.lineWidth = 1; g.strokeRect(ix + .5, iy + .5, sz - 1, sz - 1);
        g.imageSmoothingEnabled = true;
        g.drawImage(iconSheet, (cat.icon % 16) * 20, Math.floor(cat.icon / 16) * 20, 20, 20, ix + 1, iy + 1, sz - 2, sz - 2);
        if (CELL >= 14) {
          g.font = `bold ${Math.round(7 * k)}px system-ui, sans-serif`; g.textAlign = "right"; g.textBaseline = "bottom";
          g.lineWidth = 2.5; g.strokeStyle = "#000"; g.fillStyle = "#28dce6";
          g.strokeText(String(it.n), ix + sz, iy + sz + 1); g.fillText(String(it.n), ix + sz, iy + sz + 1);
          g.textAlign = "center"; g.textBaseline = "middle";
        }
        continue;
      }
      g.fillStyle = "#28dce6";
      g.strokeText(String(it.n), tx, ty); g.fillText(String(it.n), tx, ty);
    }
    // monstres : position réelle et direction
    for (const m of monsters) {
      if (!visible(L, Math.floor(m.y) * 32 + Math.floor(m.x))) continue;
      const mx = m.x * CELL, my = m.y * CELL, a = [-Math.PI / 2, 0, Math.PI / 2, Math.PI][m.dir];
      const col = monsterMood(m).color;
      g.fillStyle = col; g.strokeStyle = "#000"; g.lineWidth = 1;
      g.beginPath(); g.arc(mx, my, 3.2 * k, 0, 2 * Math.PI); g.fill(); g.stroke();
      g.strokeStyle = col; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(mx, my); g.lineTo(mx + Math.cos(a) * 5.5 * k, my + Math.sin(a) * 5.5 * k); g.stroke();
    }
    // groupe : flèche orientée
    const cx = (block % 32) * CELL + CELL / 2, cy = Math.floor(block / 32) * CELL + CELL / 2;
    const a = [-Math.PI / 2, 0, Math.PI / 2, Math.PI][dir & 3];
    g.fillStyle = "#fff"; g.strokeStyle = "#000"; g.lineWidth = 1.5;
    g.beginPath();
    g.lineWidth = 1.5;
    g.moveTo(cx + Math.cos(a) * 9 * k, cy + Math.sin(a) * 9 * k);
    g.lineTo(cx + Math.cos(a + 2.4) * 6 * k, cy + Math.sin(a + 2.4) * 6 * k);
    g.lineTo(cx + Math.cos(a - 2.4) * 6 * k, cy + Math.sin(a - 2.4) * 6 * k);
    g.closePath(); g.stroke(); g.fill();
  }

  const LOCK_KIND = { porte: "Serrure de porte", passage: "Serrure (ouvre un passage)",
    receptacle: "Réceptacle de clé (mécanisme)", coffre: "Donne un objet (lieu)", inconnu: "Serrure" };
  // Info-bulle au survol de la mini-carte : nature de la case, lieu, objets, monstres
  const tipEl = document.getElementById("mm-tip");
  const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  let tipAt = [0, 0];
  function showTip(html, cx, cy) {
    tipEl.innerHTML = html; tipEl.hidden = false; tipAt = [cx, cy]; placeTip();
    for (const im of tipEl.querySelectorAll("img")) if (!im.complete) im.addEventListener("load", placeTip);
  }
  function placeTip() {
    const [cx, cy] = tipAt, w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    let left = cx + 14, top = cy + 14;
    if (left + w > innerWidth - 4) left = cx - w - 14;
    if (top + h > innerHeight - 4) top = cy - h - 14;
    tipEl.style.left = Math.max(4, left) + "px"; tipEl.style.top = Math.max(4, top) + "px";
  }

  // Illustration d'un lieu : image du jeu (fonction 0x29, § 8) si une case de l'entrée en a une,
  // sinon vue 3D prise depuis la case devant l'entrée (x2, y2 de l'annotation), tournée vers le lieu.
  const placeImg = new Map();             // "niveau:n" -> {src, kind} ou Promise
  let snapId = 0;
  const snapWait = new Map();
  addEventListener("message", (e) => {
    if (e.origin !== location.origin || !e.data || e.data.type !== "lol-snap") return;
    const ok = snapWait.get(e.data.id); if (ok) { snapWait.delete(e.data.id); ok(e.data.url); }
  });
  function snapshot(level, x, y, dir) {
    if (!frame3d || !frame3d.contentWindow) return Promise.resolve(null);
    const id = ++snapId;
    return new Promise((ok) => {
      snapWait.set(id, ok);
      setTimeout(() => { if (snapWait.delete(id)) ok(null); }, 1500);
      frame3d.contentWindow.postMessage({ type: "lol-snap", id, level, x, y, dir }, location.origin);
    });
  }
  function placeScene(L, p) {
    const cand = [[p.x2, p.y2], [p.x, p.y]];
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) cand.push([p.x2 + dx, p.y2 + dy]);
    for (const [x, y] of cand) if (x >= 0 && y >= 0 && x < 32 && y < 32 && L.scenes[y * 32 + x]) return L.scenes[y * 32 + x];
    return null;
  }
  function placeView(p) {
    let sx = p.x2, sy = p.y2;
    if (sx == null || (sx === p.x && sy === p.y)) { sx = p.x; sy = p.y; return [sx, sy, 0]; }
    const dx = p.x - sx, dy = p.y - sy;
    const dir = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
    return [sx, sy, dir];
  }
  function placeFigure(L, p) {
    if (!L) return "";
    const key = `${L.level}:${p.n}`, scene = placeScene(L, p);
    if (scene) return `<img class="pl" src="viewer/data/scenes/${escHtml(scene)}" alt=""><span class="t">Image du lieu dans le jeu</span>`;
    const got = placeImg.get(key);
    if (got && got.src) return `<img class="pl" src="${got.src}" alt=""><span class="t">Vue 3D depuis la case ${got.at}</span>`;
    if (!got) {
      const [x, y, dir] = placeView(p);
      const job = snapshot(L.level, x, y, dir).then((url) => {
        if (url) placeImg.set(key, { src: url, at: `${x},${y}, vers ${["le nord", "l'est", "le sud", "l'ouest"][dir]}` });
        else placeImg.delete(key);
        const el = tipEl.querySelector(`[data-place="${key}"]`);
        if (el && url) {
          el.outerHTML = `<img class="pl" src="${url}" alt=""><span class="t">Vue 3D depuis la case ${x},${y}, vers ${["le nord", "l'est", "le sud", "l'ouest"][dir]}</span>`;
          for (const im of tipEl.querySelectorAll("img")) if (!im.complete) im.addEventListener("load", placeTip);
          placeTip();
        }
        else if (el) el.textContent = "(vue 3D indisponible : la vue 3D affiche un autre niveau)";
      });
      placeImg.set(key, { pending: job });
    }
    return `<br><span class="t" data-place="${key}">Illustration en cours…</span>`;
  }
  const CLASS_FR = { wall: "mur", floor: "sol", doorOpen: "porte ouverte", doorClosed: "porte fermée",
    special: "case particulière (levier, niche, décor…)", unknown: "mur inconnu", fake: "faux mur" };
  function cellInfo(x, y) {
    const L = current, i = y * 32 + x, out = [];
    const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
    if (!visible(L, i)) return `<b>Case ${x},${y}</b> <span class="t">· inexplorée</span>`;
    out.push(`<b>Case ${x},${y}</b> <span class="t">· ${CLASS_FR[cellClass(L, i)]}</span>`);
    if (lastDraw[0] === i) out.push("Vous êtes ici");
    for (const p of L.places) if (p.x === x && p.y === y)
      out.push(`<span class="lb">Lieu ${p.n} : ${esc(niceName(p.text))}</span>` + placeFigure(L, p));
    if (L.scenes[i] && !L.places.some((p) => p.x === x && p.y === y)) out.push(`<span class="t">Lieu avec image fixe (scène)</span>`);
    const grp = L.groups.find((g) => g.x === x && g.y === y);
    if (grp) {
      const where = grp.items[0].container === "chest" ? " (dans un coffre)"
        : grp.items[0].container === "niche" ? (DIRS[grp.items[0].face] ? ` (niche, face ${DIRS[grp.items[0].face]})` : " (dans un mur)") : "";
      out.push(`<span class="it">Objets n° ${grp.n}${where} :</span>`);
      for (const it of grp.items) out.push(`<span class="it">• ${esc(it.name || "objet " + it.type)} <span class="t">(${itemCategory(it.type).label})</span>${it.spawn === "event" ? " (événement)" : ""}</span>`);
    }
    const FACE_FR = ["nord", "est", "sud", "ouest"];
    for (let f = 0; f < 4; f++) {
      const kind = switchKind(L, i, f);
      if (kind === "lever") out.push(`<span class="sw">Levier, face ${FACE_FR[f]} (état ${L.wallTypes[live[i * 4 + f]][1] === 2 ? "A" : "B"})</span>`);
      else if (kind) out.push(`<span class="bt">Élément cliquable (bouton, serrure, décor…), face ${FACE_FR[f]}</span>`);
    }
    for (let f = 0; f < 4; f++) {
      const st = chestState(L, i, f);
      if (st >= 0) out.push(`<span class="ch">Coffre ${CHEST_FR[st] || ""}, face ${["nord", "est", "sud", "ouest"][f]}</span>`);
    }
    const loot = L.chestItems[i];
    if (loot) {
      const opened = [0, 1, 2, 3].some((f) => chestState(L, i, f) > 0);
      out.push(`<span class="ch">Contenu${opened ? " d'origine (coffre déjà ouvert : sans doute pris)" : ""} :</span>`);
      for (const e of loot) {
        const inf = itemInfo && itemInfo[e.type];
        out.push(`<span class="ch">• ${esc(e.name)}${e.value ? ` <span class="t">(${/^Bourse/.test(e.name) ? e.value + " pièces" : "valeur " + e.value})</span>` : ""}`
          + (inf ? ` <span class="t">(${itemCategory(e.type).label})</span>` : "")
          + (e.fragile ? ` <span class="t">— Verre cassé si le coffre a été cassé</span>` : "") + "</span>");
      }
    }
    const mk = floorMark(L, i);
    const here = L.exits.filter((e) => e.x === x && e.y === y);
    if (mk && (mk !== "teleport" || !here.length))
      out.push(`<span class="${mk === "teleport" ? "tp" : "st"}">${{ up: "Escalier qui monte", down: "Escalier qui descend", hole: "Trou ou trappe (chute)",
        teleport: "Téléporteur (destination non trouvée dans les scripts)" }[mk]}</span>`);
    for (const e of here) {
      const dest = levels.find((l) => l.level === e.level);
      if (e.teleport) out.push(`<span class="tp">Téléporteur vers la case ${e.tx},${e.ty} (même niveau)</span>`);
      else out.push(`<span class="${mk === "teleport" ? "tp" : "st"}">${mk === "teleport" ? "Téléporteur" : "Passage"} vers le niveau ${e.level}${dest ? " (" + esc(dest.fr) + ")" : ""}, case ${e.tx},${e.ty}</span>`);
    }
    for (const e of L.exits) if (e.teleport && e.tx === x && e.ty === y)
      out.push(`<span class="tp">Arrivée du téléporteur de la case ${e.x},${e.y}</span>`);
    const ff = fakeFaces(L, i);
    if (ff.length) out.push(`<span class="sc">Passage caché : faux mur, on le traverse (côté${ff.length > 1 ? "s" : ""} ${ff.map((f) => FACE_FR[f]).join(", ")})</span>`);
    const sw = secretAt(L, i);
    if (sw && !L.fragile.some((fw) => fw.x === x && fw.y === y)) {
      const cond = (t) => t.item != null ? ` ${t.hand ? "en tenant" : "avec l'objet (posé ou lancé ?)"} : ${esc((itemInfo && itemInfo[t.item] && itemInfo[t.item].name) || "objet " + t.item)}` : "";
      out.push(`<span class="sc">Passage secret${isWallCell(L, i) ? "" : " (ouvert)"} : le mur s'efface`
        + sw.open.map((t) => t.x === x && t.y === y ? " en agissant sur ce mur" + cond(t) : ` depuis la case ${t.x},${t.y}` + cond(t)).join(" ;") + "</span>");
      if (sw.close.length) out.push(`<span class="t">Se referme depuis la case ${sw.close.map((t) => t.x + "," + t.y).join(" ou ")}</span>`);
    }
    for (const s2 of L.secrets) for (const t of s2.open) if (t.x === x && t.y === y && !(s2.x === x && s2.y === y))
      out.push(`<span class="sc">Ouvre le passage secret de la case ${s2.x},${s2.y}${t.item != null ? ` (${t.hand ? "en tenant" : "avec"} : ${esc((itemInfo && itemInfo[t.item] && itemInfo[t.item].name) || "objet " + t.item)})` : ""}</span>`);
    for (const s2 of L.secrets) if (s2.close.some((t) => t.x === x && t.y === y))
      out.push(`<span class="t">Referme le passage secret de la case ${s2.x},${s2.y}</span>`);
    for (const fw of L.fragile) if (fw.x === x && fw.y === y)
      out.push(isWallCell(L, i) ? `<span class="fr">Mur fragile : se casse en le frappant avec : ${esc(fw.toolName)}</span>`
        : `<span class="fr">Mur fragile (déjà cassé)</span>`);
    for (const l of L.locks) if (l.x === x && l.y === y)
      out.push(`<span class="ky">${LOCK_KIND[l.kind] || "Serrure"} : ${esc(l.name)}${owned.has(l.key) ? " ✔ dans l'inventaire" : ""}${l.how === "direct" ? "" : " (probable)"}</span>`);
    for (const m of monsters) if (Math.floor(m.x) === x && Math.floor(m.y) === y) {
      const nm = (L.spriteOf || {})[m.type] || (L.monsterTypes[m.type] || []).join(" / ") || `type ${m.type}`;
      const mood = monsterMood(m);
      out.push(`<span class="mo">Monstre : ${esc(nm)} (regarde vers ${["le nord", "l'est", "le sud", "l'ouest"][m.dir]})</span>`
        + `<br><span style="color:${mood.color}">${mood.label}</span>`);
    }
    return out.join("<br>");
  }
  canvas.addEventListener("mousemove", (e) => {
    if (!current) { tipEl.hidden = true; return; }
    const r = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / r.width * 32), y = Math.floor((e.clientY - r.top) / r.height * 32);
    if (x < 0 || y < 0 || x > 31 || y > 31) { tipEl.hidden = true; return; }
    const key = `${x},${y}`;
    if (tipEl.hidden || tipEl.dataset.cell !== key) { tipEl.dataset.cell = key; showTip(cellInfo(x, y), e.clientX, e.clientY); }
    else { tipAt = [e.clientX, e.clientY]; placeTip(); }
  });
  canvas.addEventListener("mouseleave", () => { tipEl.hidden = true; tipEl.dataset.cell = ""; });

  { let c = 12; try { c = +localStorage.getItem("minimapCell") || 12; } catch (e) {} setCell(c); }

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
      // +12 image d'animation, +13 mode ; +18 drapeaux (& 7 = variante de couleurs), +35..+38 équipement
      out.push({ slot: i, x: x / 256, y: y / 256, dir: bytes[a + 17] & 3, type: bytes[a + 25], sf: bytes[a + 12], mode: bytes[a + 13],
        variant: bytes[a + 18] & 7, equip: [bytes[a + 35], bytes[a + 36], bytes[a + 37], bytes[a + 38]],
        hitX: (bytes[a + 10] << 24) >> 24, hitY: (bytes[a + 11] << 24) >> 24 });   // +10/+11 : hitOffsX/Y (signés)
    }
    return out;
  }

  async function update() {
    const r = await mem.read([[ADDR.block, 2], [ADDR.dir, 2], [ADDR.grid, 1024 * ADDR.stride],
      [MON.x0 - 2, MON.size * MON.count], [ADDR.sceneFlag, 1], [ITEMS.base, ITEMS.size * INV.maxItems]]);
    if (!r) { titleEl.textContent = "Mini-carte"; infoEl.textContent = "en attente du jeu…"; return; }
    const block = r[0][0] | r[0][1] << 8, dir = r[1][0] | r[1][1] << 8;
    const hash = readGrid(r[2]);
    monsters = readMonsters(r[3]);
    if (ENGINE_SPRITES) {
      // ScummVM : image de chaque monstre telle que le jeu la dessine (attaques, coups, marche)
      // + giclée d'un coup reçu : réduction 1-4 (0 = aucune), couleur 0-3, décalage hitOffsX/Y
      const f = await mem.read([[0x7F000200, 120]]);
      if (f) for (const m of monsters) {
        const k = m.slot * 4;
        m.frame = f[0][k]; m.flip = !!f[0][k + 1]; m.blood = f[0][k + 2]; m.bloodType = f[0][k + 3];
      }
    }
    const inScene = r[4][0] === 1;
    const liveItems = readLiveItems(r[2], r[5]);
    const now = performance.now();
    if (hash !== lastHash && now - lastIdentify > 500) {
      const found = identify();
      if (found !== current) { renderItemList(found); if (found) found.spriteOf = null; }
      current = found; lastHash = hash; lastIdentify = now;
    }
    if (current && liveItems) {
      const groups = groupItems(liveItems), key = JSON.stringify(groups);
      if (key !== current.liveKey) {
        current.liveKey = key; current.groups = groups; current.live = true; renderItemList(current);
      }
    }
    if (!current || block > 1023 || dir > 3) {
      titleEl.textContent = "Mini-carte";
      infoEl.textContent = "hors exploration (menu, intro, dialogue…)";
      labelEl.textContent = "";
      draw(0, 0);
      return;
    }
    const x = block % 32, y = Math.floor(block / 32);
    titleEl.textContent = `Niveau ${current.level} — ${current.fr}`;
    infoEl.textContent = `case ${x},${y} · ${["Nord", "Est", "Sud", "Ouest"][dir]}`;
    let near = null, bd = 2.5;
    for (const l of current.labels) {
      if (!l.text || l.text === "ENDROIT INVALIDE") continue;
      const d = Math.hypot(l.x - x, l.y - y);
      if (d < bd) { bd = d; near = l; }
    }
    labelEl.textContent = near ? near.text : "";
    explore(current, block, dir);
    forgetBtn.disabled = !fogOn;
    if (fogListKey(current) !== fogKey) { fogKey = fogListKey(current); renderItemList(current); }
    // objets à portée (case du groupe et cases voisines)
    for (const li of [...itemsEl.children, ...placesEl.children]) {
      const c = +li.dataset.cell;
      li.classList.toggle("near", Number.isFinite(c) && Math.abs((c % 32) - x) <= 1 && Math.abs(Math.floor(c / 32) - y) <= 1);
    }
    draw(block, dir);
    // image fixe du lieu dans la vue 3D ; sans image connue, la vue reste visible (avant : écran
    // noir « Lieu »). Version ScummVM : la page recopie l'image du jeu elle-même (tools/scummvm_web.py).
    sendSceneTo3d(inScene && !ENGINE_SPRITES ? current.scenes[block] || null : null, near ? near.text : "");
    sendGridTo3d(current.level, hash);
    sendMonstersTo3d(current);
    sendItemsTo3d(current, liveItems);
    sendTo3d(current.level, x, y, dir);
  }

  // Sprite de chaque type : quand un type a plusieurs sprites possibles (ex. ORC ou THUG
  // selon l'histoire), on cherche en mémoire lequel le jeu a chargé (une fois par niveau).
  let resolving = false;
  // Version ScummVM : le moteur publie, pour chacun des 5 types de monstres, le nom du fichier de
  // sprites chargé dans son emplacement (zone 0x7F000000, 13 octets par type ; tools/scummvm_web.py).
  // Choix exact, relu à chaque mise à jour (un script peut recharger un emplacement en cours de niveau).
  const ENGINE_SPRITES = window.LOL_ENGINE === "scummvm", SPRITE_NAMES = 0x7F000000;
  async function resolveEngineSprites(L) {
    if (resolving) return;
    resolving = true;
    try {
      const r = await mem.read([[SPRITE_NAMES, 5 * 13]]);
      if (!r) return;
      const b = r[0], spriteOf = {};
      for (const [t, names] of Object.entries(L.monsterTypes)) {
        let n = "";
        for (let k = 0; k < 13 && t < 5 && b[t * 13 + k]; k++) n += String.fromCharCode(b[t * 13 + k]);
        n = n.toUpperCase();
        if (names.includes(n)) spriteOf[t] = n;
        else if (n) console.warn(`mini-carte : sprite ${n} (type ${t}) absent des sprites prévus pour le niveau ${L.level}`, names);
      }
      if (JSON.stringify(spriteOf) !== JSON.stringify(L.spriteOf)) L.spriteOf = spriteOf;
    } finally { resolving = false; }
  }
  async function resolveSprites(L) {
    if (ENGINE_SPRITES) return resolveEngineSprites(L);
    if (L.spriteOf || resolving) return;
    resolving = true;
    try {
      const spriteOf = {}, ambiguous = [];
      for (const [t, names] of Object.entries(L.monsterTypes)) {
        if (names.length === 1) spriteOf[t] = names[0]; else ambiguous.push([t, names]);
      }
      // Plusieurs sprites possibles pour un type (choix selon l'histoire) : on cherche en mémoire
      // lequel est chargé. Une copie périmée d'un niveau précédent peut subsister (ex. RATMAN
      // du niveau 6 au niveau 7) : on garde le candidat le plus proche, en mémoire, des sprites
      // sûrs du niveau (les tampons des emplacements sont alloués côte à côte).
      const sig = (n) => (L.spriteSigs[n] ? Uint8Array.from(L.spriteSigs[n].match(/../g), (x) => parseInt(x, 16)) : null);
      const sure = [...new Set(Object.values(spriteOf))].filter((n) => L.spriteSigs[n]);
      const refs = sure.length ? await mem.find(sure.map(sig)) : [];
      if (!refs) return;                          // jeu indisponible : on réessaiera
      const refAddrs = refs.filter((a) => a >= 0);
      // Choix exact : la condition d'histoire du script .INI (drapeau du jeu, § 12.2)
      const flags = await mem.read([[FLAGS, 128]]);
      if (!flags) return;
      const flag = (n) => (flags[0][(n >> 4) * 2 + ((n & 15) >> 3)] >> (n & 7)) & 1;
      const byCond = (names) => names.find((n) => {
        const c = L.spriteConds[n];
        if (!c) return false;
        const v = flag(c.flag), truth = c.eq === null ? v !== 0 : v === c.eq;
        return truth === c.when;
      });
      for (const [t, names] of ambiguous) {
        const chosen = byCond(names);
        if (chosen) { spriteOf[t] = chosen; continue; }
        const sigs = names.map(sig);
        const found = await mem.find(sigs.map((x) => x || new Uint8Array([0, 0, 0, 0])));
        if (!found) return;
        let best = -1, bestD = Infinity;
        found.forEach((a, i) => {
          if (!sigs[i] || a < 0) return;
          const d = refAddrs.length ? Math.min(...refAddrs.map((r) => Math.abs(r - a))) : -a;   // sans repère : le plus haut
          if (d < bestD) { bestD = d; best = i; }
        });
        spriteOf[t] = names[best >= 0 ? best : 0];
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
  // Objets posés au sol (pas ceux rangés dans un mur ou un coffre) : position fine dans la case
  let lastItemsSent = "";
  function sendItemsTo3d(L, items) {
    if (!items || !frame3d || !frame3d.contentWindow) return;
    const list = items.filter((i) => !i.container).map((i) => ({ x: i.x + (i.xOffs || 0) / 256, y: i.y + (i.yOffs || 0) / 256, type: i.type }));
    const key = L.level + JSON.stringify(list);
    if (key === lastItemsSent) return;
    lastItemsSent = key;
    frame3d.contentWindow.postMessage({ type: "lol-items", level: L.level, list }, location.origin);
  }
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
      titleEl.textContent = `Niveau ${current.level} — ${current.fr} (aperçu)`;
      draw(y * 32 + x, dir);
      sendTo3d(current.level, x, y, dir);
    }
  }
  // --- Inventaire (grille d'icônes du jeu) ------------------------------------
  let itemInfo = null;                  // [{name, icon}] par type d'objet
  const ICON = 20, ICON_COLS = 16, SCALE = 1.5;
  const invBar = document.getElementById("inv-bar"), invHand = document.getElementById("inv-hand"),
    invChars = document.getElementById("inv-chars"), invCount = document.getElementById("inv-count");
  getJSON("viewer/data/items.json?v=20261109k").then((d) => { itemInfo = d; if (current) renderItemList(current); }, () => {});

  function slot(type, label, loc) {
    const d = document.createElement("div");
    d.className = "slot";
    if (loc !== undefined) { d.dataset.loc = loc; if (MANAGE) dragTarget(d, loc, type >= 0); }
    if (type >= 0 && itemInfo) {
      const it = itemInfo[type] || { name: `objet ${type}`, icon: -1 };
      d.classList.add("full");
      d.title = (label ? `${label} : ${it.name}` : it.name) + " — cliquer pour la fiche";
      d.dataset.type = type;
      d.addEventListener("click", () => showDetail(type, label, d));
      setIcon(d, it.icon);
    } else if (label) d.title = `${label} : vide`;
    return d;
  }
  function setIcon(d, icon) {
    if (icon < 0) return;
    const s = ICON * SCALE;
    d.style.backgroundPosition = `-${(icon % ICON_COLS) * s}px -${Math.floor(icon / ICON_COLS) * s}px`;
  }

  // Fiche d'un objet (clic sur une case) : données de tools/item_info.py
  const detailEl = document.getElementById("inv-detail");
  let detailType = -1;
  let fromHand = false;                 // fiche ouverte automatiquement par la prise en main
  function showDetail(type, label, cell, auto = false) {
    const wasSel = cell && cell.classList.contains("sel");
    document.querySelectorAll("#inv .slot.sel").forEach((e) => e.classList.remove("sel"));
    if (!auto && detailType === type && !detailEl.hidden && wasSel) { hideDetail(); return; }
    detailType = type; fromHand = auto;
    if (cell) cell.classList.add("sel");
    selKey = itemInfo[type] && itemInfo[type].kind === "Clé" ? type : -1;
    draw(lastDraw[0], lastDraw[1]);
    const it = itemInfo[type] || { name: `objet ${type}`, icon: -1, effects: [] };
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const icon = el("div", "slot full"); setIcon(icon, it.icon);
    const close = el("button", "x", "✕"); close.type = "button"; close.title = "Fermer"; close.onclick = hideDetail;
    const lines = [...(it.effects || [])];
    if (it.wear) lines.push(`Se porte : ${it.wear}`);
    if (it.kind === "Clé") {
      if (!it.locks) lines.push("Serrure non trouvée dans les scripts des niveaux");
      for (const l of it.locks || [])
        lines.push(`${LOCK_KIND[l.kind] || "Serrure"} : niveau ${l.level}, case ${l.x},${l.y}${l.how === "direct" ? "" : " (probable)"}`
          + (current && current.level === l.level ? " — ce niveau, entourée sur la carte" : ""));
    }
    if (it.value) lines.push(`Valeur : ${it.value} (supposée)`);
    const ul = el("ul"); for (const l of lines) ul.appendChild(el("li", null, l));
    const cmp = compareEquip(type, it);
    detailEl.replaceChildren(icon, el("div", "nm", it.name), close,
      el("div", "kd", (it.kind || "Objet") + (label ? ` · ${label}` : "") + ` · type ${type}`));
    if (lines.length) detailEl.appendChild(ul);
    if (cmp) detailEl.appendChild(cmp);
    if (it.text) detailEl.appendChild(el("div", "txt", it.text));
    detailEl.appendChild(el("div", "note", "Valeurs lues dans la table des objets du jeu ; sens des champs déduit (doc § 8.2)."));
    if (MANAGE && cell && cell.dataset.loc !== undefined) detailEl.appendChild(actions(type, it, +cell.dataset.loc));
    detailEl.hidden = false;
  }
  // Comparaison avec l'équipement porté par chaque personnage, pour les emplacements où
  // l'objet peut aller (masque d'emplacements, § 8.2) : force et protection, effets passifs.
  // Armes et boucliers : comparés à la main principale (emplacements 0 et 1) seulement.
  function compareEquip(type, it) {
    if (!it.slots || !it.slots.length || !lastInvData || !lastInvData.party.length) return null;
    const slots = [...new Set(it.slots.map((k) => (k === 2 ? 0 : k === 3 ? 1 : k)))];
    const stat = (t) => { const o = itemInfo[t] || {}; return { m: o.might || 0, p: o.prot || 0 }; };
    const me = stat(type);
    const box = document.createElement("div"); box.className = "cmp";
    const h = document.createElement("div"); h.className = "cmp-h"; h.textContent = "Comparaison avec l'équipement porté";
    box.appendChild(h);
    const fmt = (a, b, label) => {
      if (!a && !b) return "";
      const d = a - b, cls = d > 0 ? "up" : d < 0 ? "down" : "eq";
      return `<span class="${cls}">${label} ${a}${d ? ` (${d > 0 ? "+" : ""}${d})` : " (=)"}</span>`;
    };
    for (const c of lastInvData.party) {
      for (const k of slots) {
        const cur = c.eq[k], row = document.createElement("div"); row.className = "cmp-r";
        const who = `<b>${escHtml(c.name)}</b>, ${EQUIP_NAMES[k] || "emplacement " + (k + 1)} : `;
        if (cur === type) { row.innerHTML = who + "<i>déjà porté</i>"; box.appendChild(row); continue; }
        const o = stat(cur >= 0 ? cur : -1), curName = cur >= 0 && itemInfo[cur] ? itemInfo[cur].name : null;
        const parts = [fmt(me.m, o.m, "Force"), fmt(me.p, o.p, "Protection")].filter(Boolean);
        const special = (e) => !/^(Force|Protection|Dégâts|Munition|Pas d'effet)/.test(e);
        const lost = cur >= 0 ? (itemInfo[cur].effects || []).filter(special) : [];
        const gain = (it.effects || []).filter(special).filter((e) => !lost.includes(e));
        row.innerHTML = who + (curName ? `remplace <i>${escHtml(curName)}</i>` : "<i>emplacement vide</i>")
          + (parts.length ? " → " + parts.join(", ") : "")
          + (gain.length ? `<br><span class="up">gagne : ${gain.map(escHtml).join(" ; ")}</span>` : "")
          + (lost.length ? `<br><span class="down">perd : ${lost.filter((e) => !(it.effects || []).includes(e)).map(escHtml).join(" ; ")}</span>` : "");
        box.appendChild(row);
      }
    }
    return box;
  }
  function hideDetail() {
    detailEl.hidden = true; detailType = -1; selKey = -1; fromHand = false;
    draw(lastDraw[0], lastDraw[1]);
    document.querySelectorAll("#inv .slot.sel").forEach((e) => e.classList.remove("sel"));
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

  // rôle des 11 emplacements d'équipement, déduit des masques de la table des objets (§ 8.2)
  const EQUIP_NAMES = ["arme", "bouclier", "arme (2)", "bouclier (2)", "tête", "corps", "cou", "poignets", "pieds", "anneau", "anneau (2)"];
  let lastInvData = null;
  let lastInv = "", owned = new Set(), lastHand = -1;         // types d'objets possédés (inventaire, main, équipement)
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
    const party = partyChars(ch).map((c) => ({ name: c.name, slot: c.slot,
      eq: Array.from({ length: INV.equipSlots }, (_, k) => typeOf(c.at(INV.equipOffset + 2 * k) | c.at(INV.equipOffset + 2 * k + 1) << 8)) }));
    owned = new Set([...barTypes, handType, ...party.flatMap((c) => c.eq)].filter((t) => t >= 0));
    const key = JSON.stringify([barTypes, handType, party]);
    lastInvData = { barTypes, handType, party };
    if (key === lastInv) return;          // on ne reconstruit la grille que si elle a changé
    lastInv = key;

    invBar.replaceChildren(...barTypes.map((t, k) => slot(t, `case ${k + 1}`, k)));
    invCount.textContent = `${barTypes.filter((t) => t >= 0).length} / ${INV.barSlots} cases occupées`;
    invHand.replaceChildren(slot(handType, "en main", LOC_HAND));
    document.querySelectorAll("#inv .slot.sel").forEach((e) => e.classList.remove("sel"));
    invChars.replaceChildren();
    for (const c of party) {
      const b = document.createElement("div"); b.className = "inv-sub"; b.textContent = `${c.name} — équipement`;
      const row = document.createElement("div"); row.className = "inv-grid";
      row.append(...c.eq.map((t, k) => slot(t, `${c.name}, ${EQUIP_NAMES[k] || "emplacement " + (k + 1)}`, LOC_EQ(c.slot, k))));
      invChars.append(b, row);
    }
    // objet pris en main dans le jeu : sélectionné comme si on avait cliqué dessus ;
    // reposé : la fiche ouverte par la prise en main se ferme
    if (handType !== lastHand) {
      if (handType >= 0) showDetail(handType, "en main", invHand.firstChild, true);
      else if (fromHand) hideDetail();
    } else if (fromHand && handType >= 0) invHand.firstChild.classList.add("sel");
    lastHand = handType;
  }

  // --- Gestion de l'inventaire (version ScummVM) ------------------------------------
  // Le moteur exécute les commandes avec ses propres fonctions (scripts des objets équipés,
  // recalcul des caractéristiques, affichage) : voir tools/scummvm_web.py. Avec DOSBox, écrire
  // directement en mémoire ne lancerait pas ces scripts : la gestion n'y est pas proposée.
  // Emplacements : 0..47 sac, 100 main, 200 + perso * 11 + emplacement d'équipement.
  const MANAGE = window.LOL_ENGINE === "scummvm";
  const LOC_HAND = 100, LOC_EQ = (c, k) => 200 + c * 11 + k;
  const hintEl = document.getElementById("inv-hint");
  if (MANAGE && hintEl) hintEl.textContent = "Glisser une case sur une autre pour déplacer ou échanger ; cliquer un objet pour d'autres actions.";
  const CMD_ERR = { 1: "Impossible : cet objet ne va pas à cet emplacement.", 2: "Le sac est plein.", 3: "Cet emplacement est vide." };
  function invMessage(t) {
    if (!hintEl) return;
    hintEl.textContent = t;
    clearTimeout(invMessage.t);
    invMessage.t = setTimeout(() => { hintEl.textContent = MANAGE ? "Glisser une case sur une autre pour déplacer ou échanger ; cliquer un objet pour d'autres actions." : ""; }, 4000);
  }
  async function invCmd(c) {
    const r = await mem.cmd(c);
    if (!r) { invMessage("Le jeu ne répond pas (menu ouvert ?) : réessaie en exploration."); return false; }
    if (r.code) { invMessage(CMD_ERR[r.code] || `Refusé (code ${r.code}).`); return false; }
    lastInv = "";
    setTimeout(() => updateInventory().catch(() => {}), 250);
    return true;
  }
  let dragFrom = -1;
  function dragTarget(d, loc, full) {
    if (full) {
      d.draggable = true;
      d.addEventListener("dragstart", (e) => { dragFrom = loc; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(loc)); });
      d.addEventListener("dragend", () => { dragFrom = -1; document.querySelectorAll("#inv .slot.drop").forEach((x) => x.classList.remove("drop")); });
    }
    d.addEventListener("dragover", (e) => { if (dragFrom >= 0 && dragFrom !== loc) { e.preventDefault(); d.classList.add("drop"); } });
    d.addEventListener("dragleave", () => d.classList.remove("drop"));
    d.addEventListener("drop", (e) => {
      e.preventDefault(); d.classList.remove("drop");
      const from = dragFrom; dragFrom = -1;
      if (from >= 0 && from !== loc) { hideDetail(); invCmd({ op: "move", a: from, b: loc }); }
    });
  }
  function firstFreeBag() {
    if (!lastInvData) return -1;
    return lastInvData.barTypes.findIndex((t) => t < 0);
  }
  function actions(type, it, loc) {
    const box = document.createElement("div"); box.className = "acts";
    const btn = (text, title, fn, cls) => {
      const b = document.createElement("button"); b.type = "button"; b.textContent = text; b.title = title;
      if (cls) b.className = cls;
      b.addEventListener("click", (e) => { e.currentTarget.blur(); fn(b); });
      box.appendChild(b);
    };
    const move = (to) => { hideDetail(); invCmd({ op: "move", a: loc, b: to }); };
    if (loc !== LOC_HAND)
      btn("Prendre en main", "Mettre l'objet dans la main (échangé avec l'objet tenu, s'il y en a un)", () => move(LOC_HAND));
    if (loc >= LOC_HAND)
      btn("Ranger dans le sac", "Mettre l'objet dans la première case libre du sac", () => {
        const k = firstFreeBag();
        if (k < 0) invMessage(CMD_ERR[2]); else move(k);
      });
    // équiper : premier emplacement permis et libre du personnage, sinon échange avec l'objet porté
    const allowed = (it.slots || []).filter((k) => k >= 0 && k < INV.equipSlots);
    if (allowed.length && lastInvData)
      for (const c of lastInvData.party) {
        const k = allowed.find((s) => c.eq[s] < 0) ?? allowed[0];
        const to = LOC_EQ(c.slot, k);
        if (to === loc) continue;
        btn(`Équiper : ${c.name}`, `${c.name}, ${EQUIP_NAMES[k] || "emplacement " + (k + 1)}` + (c.eq[k] >= 0 ? " (échange avec l'objet porté)" : ""), () => move(to));
      }
    btn("Supprimer", "Détruire l'objet (deuxième clic pour confirmer)", (b) => {
      if (!b.classList.contains("confirm")) { b.classList.add("confirm"); b.textContent = "Confirmer la suppression"; return; }
      hideDetail(); invCmd({ op: "delete", a: loc });
    }, "del");
    return box;
  }

  // --- Création d'objets dans le sac -------------------------------------------
  // Table des objets (§ 12.2) : entrée libre = mot de drapeaux (+14) à 0x8000. Objet porté :
  // tout à 0 sauf niveau (+11) = 0xFF et type (+12). On remplit une entrée libre puis on met
  // son numéro dans la première case vide du sac (48 mots en 0x3E4F6).
  const addInput = document.getElementById("inv-add-name"), addMsg = document.getElementById("inv-add-msg");
  function fillAddList() {
    if (!itemInfo) return setTimeout(fillAddList, 500);
    const dl = document.getElementById("inv-add-list");
    dl.replaceChildren(...itemInfo.map((it, t) => {
      if (!t || /^temp object$|^Objet illégal$/.test(it.name)) return null;
      const o = document.createElement("option"); o.value = `${t} — ${it.name}`; return o;
    }).filter(Boolean));
  }
  fillAddList();
  async function createItem(type) {
    const v = addInput.value.trim();
    let t = type !== undefined ? type : parseInt(v, 10);
    if (!(t > 0) && itemInfo) t = itemInfo.findIndex((it) => it.name.toLowerCase() === v.toLowerCase());
    if (!(t > 0 && itemInfo && t < itemInfo.length)) { addMsg.textContent = "Objet inconnu : choisis-le dans la liste."; return; }
    if (MANAGE) {
      const ok = await invCmd({ op: "create", a: t });
      if (ok) addMsg.textContent = `${itemInfo[t].name} créé dans le sac.`;
      return;
    }
    const r = await mem.read([[ITEMS.base, ITEMS.size * INV.maxItems], [INV.bar, INV.barSlots * 2]]);
    if (!r) { addMsg.textContent = "Jeu indisponible."; return; }
    const [table, bar] = r;
    let slot = -1;
    for (let k = 0; k < INV.barSlots; k++) if (!(bar[k * 2] | bar[k * 2 + 1] << 8)) { slot = k; break; }
    if (slot < 0) { addMsg.textContent = "Le sac est plein."; return; }
    let id = -1;
    for (let i = 1; i < INV.maxItems; i++) if ((table[i * 16 + 15] & 0x80) && !(table[i * 16 + 12] | table[i * 16 + 13])) { id = i; break; }
    if (id < 0) { addMsg.textContent = "Plus d'entrée libre dans la table des objets du jeu."; return; }
    const e = new Uint8Array(16); e[11] = 0xff; e[12] = t & 255; e[13] = t >> 8;
    await mem.write([[ITEMS.base + id * 16, e], [INV.bar + slot * 2, new Uint8Array([id & 255, id >> 8])]]);
    addMsg.textContent = `${itemInfo[t].name} créé dans la case ${slot + 1} du sac. Dans le jeu, fais défiler la barre (flèche) pour l'afficher.`;
    lastInv = ""; updateInventory().catch(() => {});
  }
  document.getElementById("inv-add-btn").addEventListener("click", (e) => { e.currentTarget.blur(); createItem().catch(() => {}); });

  // --- Magie : lancer un sort depuis la page (version ScummVM) -------------------------
  // Le moteur publie les sorts connus du groupe (zone 0x7F000300, 7 × 48 octets : type, coûts en
  // magie et en vie des 4 niveaux, nom) ; la commande « cast » rejoue le menu de magie d'un portrait
  // (contrôles, coût, expérience). Soin de niveau 1 à 3 : la cible est choisie ici.
  const SPELLS = 0x7F000300, HEAL = 1;
  const spellsEl = document.getElementById("spells"), spList = document.getElementById("sp-list");
  const spCaster = document.getElementById("sp-caster"), spTarget = document.getElementById("sp-target");
  const spTargetL = document.getElementById("sp-target-l"), spMsg = document.getElementById("sp-msg");
  const CP850 = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»";
  const cp850 = (bytes) => Array.from(bytes, (b) => b < 128 ? String.fromCharCode(b) : CP850[b - 128] || "?").join("");
  let spellKey = "", spellParty = [];
  const SPELL_ERR = { 1: "Impossible maintenant : personnage occupé ou inconscient, menu de magie ouvert, ou sort inconnu.",
    4: "Pas assez de magie (ou de vie) pour ce niveau.", 5: "Le sort ne peut pas partir d'ici (mur juste devant ?)." };
  function fillSelect(sel, party, keep) {
    const v = sel.value;
    sel.replaceChildren(...party.map((c) => { const o = document.createElement("option"); o.value = c.slot; o.textContent = c.name; return o; }));
    if (keep && party.some((c) => String(c.slot) === v)) sel.value = v;
  }
  async function updateSpells() {
    if (!MANAGE || previewing) return;
    const r = await mem.read([[SPELLS, 7 * 48], PARTY_RANGE()]);
    if (!r) return;
    const spells = [];
    for (let i = 0; i < 7; i++) {
      const b = r[0].subarray(i * 48, i * 48 + 48);
      if (b[0] === 0xFF) continue;
      const w = (k) => b[k] | b[k + 1] << 8;
      const raw = b.subarray(18, 48), z = raw.indexOf(0), name = cp850(z < 0 ? raw : raw.subarray(0, z)).trim();
      spells.push({ type: b[0], name, mp: [w(2), w(4), w(6), w(8)], hp: [w(10), w(12), w(14), w(16)] });
    }
    const party = partyChars(r[1]).map((c) => {
      const u16 = (k) => c.at(k) | c.at(k + 1) << 8, s16 = (k) => (u16(k) << 16) >> 16;
      return { slot: c.slot, name: c.name, hp: s16(55), mp: s16(59) };
    });
    const key = JSON.stringify([spells, party]);
    if (key === spellKey) return;
    spellKey = key;
    spellsEl.hidden = !spells.length || !party.length;
    if (JSON.stringify(party.map((c) => c.slot)) !== JSON.stringify(spellParty.map((c) => c.slot))) {
      fillSelect(spCaster, party, true);
      fillSelect(spTarget, party, true);
    }
    spellParty = party;
    spTargetL.hidden = !spells.some((s) => s.type === HEAL);
    renderSpells(spells);
  }
  function renderSpells(spells) {
    const caster = spellParty.find((c) => String(c.slot) === spCaster.value) || spellParty[0];
    spList.replaceChildren(...spells.map((s) => {
      const row = document.createElement("div"); row.className = "sp-row";
      const nm = document.createElement("span"); nm.className = "sp-name"; nm.textContent = s.name || `sort ${s.type}`;
      row.appendChild(nm);
      for (let l = 0; l < 4; l++) {
        const b = document.createElement("button"); b.type = "button";
        b.innerHTML = `${l + 1} <small>${s.mp[l]}</small>`;
        const ok = caster && s.mp[l] <= caster.mp && s.hp[l] < caster.hp;
        b.disabled = !ok;
        b.title = `${s.name} niveau ${l + 1} : ${s.mp[l]} points de magie${s.hp[l] ? `, ${s.hp[l]} points de vie` : ""}`
          + (s.type === HEAL ? (l < 3 ? " — soigne le personnage choisi" : " — soigne tout le groupe") : "")
          + (ok ? "" : " (pas assez pour " + (caster ? caster.name : "le lanceur") + ")");
        b.addEventListener("click", () => { b.blur(); cast(s, l).catch(() => {}); });
        row.appendChild(b);
      }
      return row;
    }));
  }
  async function cast(s, level) {
    const a = +spCaster.value, target = s.type === HEAL && level < 3 ? +spTarget.value : -1;
    spMsg.textContent = `${s.name} niveau ${level + 1}…`;
    const r = await mem.cmd({ op: "cast", a, b: s.type | level << 8 | (target + 1) << 12 }, 20000);
    spMsg.textContent = !r ? "Le jeu ne répond pas (menu ou dialogue ouvert ?) : réessaie en exploration."
      : r.code ? SPELL_ERR[r.code] || `Refusé (code ${r.code}).` : `${s.name} niveau ${level + 1} lancé.`;
    spellKey = ""; lastStats = "";
    setTimeout(() => { updateSpells().catch(() => {}); updateStats().catch(() => {}); }, 300);
  }
  spCaster.addEventListener("change", () => { spCaster.blur(); spellKey = ""; updateSpells().catch(() => {}); });
  spTarget.addEventListener("change", () => spTarget.blur());
  if (MANAGE) setInterval(() => { updateSpells().catch(() => {}); }, 1000);

  // --- Annuaire des objets par catégorie (fenêtre modale) ------------------------------
  // Tous les objets de la table du jeu (viewer/data/items.json), classés comme sur la carte ;
  // « + » en crée un dans le sac (comme le champ « Créer un objet »), clic : fiche à droite
  // (la fiche de l'inventaire est déplacée dans la fenêtre le temps de son ouverture).
  const catDlg = document.getElementById("cat-dlg"), catTabs = document.getElementById("cat-tabs");
  const catList = document.getElementById("cat-list"), catQ = document.getElementById("cat-q");
  const catSide = document.getElementById("cat-side"), catMsg = document.getElementById("cat-msg");
  const catHint = document.getElementById("cat-hint"), detailHome = detailEl.parentNode, detailNext = detailEl.nextSibling;
  let catSel = "tout", catType = -1;
  try { catSel = localStorage.getItem("itemCatalogTab") || "tout"; } catch (e) {}
  const catKey = (t) => Object.keys(CATEGORIES).find((k) => CATEGORIES[k] === itemCategory(t));
  function catalogItems() {
    return itemInfo.map((it, t) => ({ it, t })).filter(({ it, t }) => t && !/^temp object$|^Objet illégal$/i.test(it.name));
  }
  function renderCatalog() {
    if (!itemInfo || !catDlg.open) return;
    const all = catalogItems();
    const counts = {}; for (const { t } of all) { const k = catKey(t); counts[k] = (counts[k] || 0) + 1; }
    catTabs.replaceChildren(...[["tout", `tout (${all.length})`], ...Object.keys(CATEGORIES).map((k) => [k, `${CATEGORIES[k].label} (${counts[k] || 0})`])].map(([k, label]) => {
      const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.classList.toggle("on", k === catSel);
      b.addEventListener("click", () => { catSel = k; try { localStorage.setItem("itemCatalogTab", k); } catch (e) {} renderCatalog(); catList.scrollTop = 0; });
      return b;
    }));
    const q = catQ.value.trim().toLowerCase();
    const shown = all.filter(({ it, t }) => (catSel === "tout" || catKey(t) === catSel)
      && (!q || it.name.toLowerCase().includes(q) || (it.kind || "").toLowerCase().includes(q) || (it.effects || []).join(" ").toLowerCase().includes(q)))
      .sort((x, y) => x.it.name.localeCompare(y.it.name, "fr"));
    catList.replaceChildren(...shown.map(({ it, t }) => {
      const li = document.createElement("li"); li.classList.toggle("sel", t === catType);
      const icon = document.createElement("div"); icon.className = "slot full"; setIcon(icon, it.icon); icon.title = "Fiche de l'objet";
      const nm = document.createElement("span"); nm.className = "nm" + (owned.has(t) ? " own" : "");
      nm.textContent = it.name; nm.title = (owned.has(t) ? "Déjà possédé · " : "") + `type ${t} — cliquer pour la fiche`;
      const sm = document.createElement("small"); sm.textContent = [it.kind, ...(it.effects || [])].filter(Boolean).join(" · "); nm.appendChild(sm);
      const add = document.createElement("button"); add.type = "button"; add.className = "add"; add.textContent = "+";
      add.title = `Créer « ${it.name} » dans le sac`;
      add.addEventListener("click", async () => {
        add.blur(); addMsg.textContent = ""; catMsg.classList.remove("err"); catMsg.textContent = "…";
        await createItem(t).catch(() => {});
        const ok = /créé/.test(addMsg.textContent);
        catMsg.textContent = addMsg.textContent || hintEl.textContent || "Création impossible.";
        catMsg.classList.toggle("err", !ok);
      });
      const open = () => {
        catType = t; showDetail(t, "annuaire"); catHint.hidden = true;
        catList.querySelectorAll("li.sel").forEach((e) => e.classList.remove("sel")); li.classList.add("sel");
      };
      icon.addEventListener("click", open); nm.addEventListener("click", open);
      li.append(icon, nm, add);
      return li;
    }));
    if (!shown.length) { const li = document.createElement("li"); li.textContent = "aucun objet"; catList.appendChild(li); }
  }
  document.getElementById("cat-open").addEventListener("click", (e) => {
    e.currentTarget.blur();
    hideDetail(); catType = -1; catHint.hidden = false; catMsg.textContent = "";
    catSide.appendChild(detailEl);
    catDlg.showModal();
    renderCatalog();
    catQ.focus();
  });
  document.getElementById("cat-close").addEventListener("click", () => catDlg.close());
  catDlg.addEventListener("click", (e) => { if (e.target === catDlg) catDlg.close(); });   // clic hors de la fenêtre
  catDlg.addEventListener("close", () => {
    hideDetail();
    detailHome.insertBefore(detailEl, detailNext);
    const f = document.getElementById("dos"); if (f && f.focus) f.focus();
  });
  catQ.addEventListener("input", renderCatalog);
  // le clavier reste dans la fenêtre (sinon le jeu DOSBox reçoit les touches) ; Échap la ferme
  for (const ev of ["keydown", "keyup", "keypress"]) catDlg.addEventListener(ev, (e) => e.stopPropagation());

  addInput.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") createItem().catch(() => {}); });
  addInput.addEventListener("keyup", (e) => e.stopPropagation());

  // --- Export texte de l'inventaire ---------------------------------------------
  function inventoryText() {
    if (!lastInvData || !itemInfo) return null;
    const { barTypes, handType, party } = lastInvData;
    const desc = (t) => {
      const it = itemInfo[t] || { name: `objet ${t}` };
      const extra = [it.kind, ...(it.effects || [])].filter(Boolean).join(" ; ");
      return it.name + (extra ? ` — ${extra}` : "");
    };
    const date = new Date().toLocaleString("fr-FR");
    const lines = [`Lands of Lore — inventaire (${date})`];
    if (current) lines.push(`Niveau ${current.level}, ${current.fr}`);
    const money = /\d+/.exec(stMoney.textContent);
    if (money) lines.push(`Couronnes : ${money[0]}`);
    lines.push("", `Sac (${barTypes.filter((t) => t >= 0).length} / ${barTypes.length} cases)`);
    const counts = new Map();
    for (const t of barTypes) if (t >= 0) counts.set(t, (counts.get(t) || 0) + 1);
    if (!counts.size) lines.push("  (vide)");
    for (const [t, n] of counts) lines.push(`  - ${n > 1 ? n + " × " : ""}${desc(t)}`);
    lines.push("", `En main : ${handType >= 0 ? desc(handType) : "rien"}`);
    for (const c of party) {
      lines.push("", `${c.name} — équipement`);
      let any = false;
      c.eq.forEach((t, k) => { if (t >= 0) { any = true; lines.push(`  - ${EQUIP_NAMES[k]} : ${desc(t)}`); } });
      if (!any) lines.push("  (rien)");
    }
    return lines.join("\n") + "\n";
  }
  document.getElementById("inv-copy").addEventListener("click", async (e) => {
    const b = e.currentTarget; b.blur();
    const txt = inventoryText();
    if (!txt) return;
    try { await navigator.clipboard.writeText(txt); b.textContent = "Copié ✓"; }
    catch (err) { b.textContent = "Échec"; }
    setTimeout(() => { b.textContent = "Copier"; }, 1500);
  });
  document.getElementById("inv-save").addEventListener("click", (e) => {
    e.currentTarget.blur();
    const txt = inventoryText();
    if (!txt) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([txt], { type: "text/plain;charset=utf-8" }));
    a.download = `inventaire-lands-of-lore-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  window.lolInventoryText = inventoryText;            // débogage

  // Débogage depuis la console : LoLMinimap.monsters() -> case, direction, type, sprite choisi
  function debugMonsters() {
    const L = current;
    return monsters.map((m) => ({ case: `${Math.floor(m.x)},${Math.floor(m.y)}`, dir: m.dir, type: m.type, variant: m.variant, equip: m.equip.filter(Boolean).join(","),
      sprite: L && L.spriteOf ? L.spriteOf[m.type] || "(aucun : type inconnu du niveau)" : "(en cours)",
      possibles: L ? (L.monsterTypes[m.type] || []).join("/") : "" }));
  }
  // --- Caractéristiques --------------------------------------------------------
  const stMoney = document.getElementById("st-money"), stChars = document.getElementById("st-chars");
  let lastStats = "";
  // fiches repliées (clic sur le nom), mémorisées par nom de personnage
  let foldedChars = new Set();
  try { foldedChars = new Set(JSON.parse(localStorage.getItem("foldedChars") || "[]")); } catch (e) {}
  stChars.addEventListener("click", (e) => {
    const nm = e.target.closest(".st-char .nm");
    if (!nm) return;
    const box = nm.parentElement, name = box.dataset.name;
    if (foldedChars.has(name)) foldedChars.delete(name); else foldedChars.add(name);
    box.classList.toggle("folded", foldedChars.has(name));
    nm.title = `Cliquer pour ${foldedChars.has(name) ? "déplier" : "replier"}`;
    try { localStorage.setItem("foldedChars", JSON.stringify([...foldedChars])); } catch (err) {}
  });
  async function updateStats() {
    if (previewing) return;
    const r = await mem.read([PARTY_RANGE(), [STATS.money, 2], [XP.table, 4 * 11]]);
    if (!r) return;
    const money = r[1][0] | r[1][1] << 8;
    xpTable = Array.from({ length: 11 }, (_, i) => (r[2][i * 4] | r[2][i * 4 + 1] << 8 | r[2][i * 4 + 2] << 16 | r[2][i * 4 + 3] << 24) >>> 0);
    const chars = partyChars(r[0]).map((c) => {
      const u16 = (k) => c.at(k) | c.at(k + 1) << 8, s16 = (k) => (u16(k) << 16) >> 16;
      const u32 = (k) => (u16(k) | u16(k + 2) << 16) >>> 0;
      let itemsMight = 0; for (let k = 0; k < 8; k++) itemsMight += u16(21 + 2 * k);
      return {
        slot: c.slot, name: c.name, hp: [s16(55), u16(57)], mp: [s16(59), u16(61)],
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
      const cls = ["Guerrier", "Voleur", "Mage"].map((n, k) => {
        const next = c.lv[k] < XP.maxLevel ? xpTable[c.lv[k]] : null;
        const btn = next !== null
          ? `<button type="button" class="lvup" data-slot="${c.slot}" data-skill="${k}" title="Monter ${n} au niveau ${c.lv[k] + 1} (comme le jeu : expérience au seuil, bonus de vie ou de magie)">+</button>` : "";
        return `${n} ${c.lv[k]} (${c.xp[k]}${next !== null ? " / " + next : ""} xp)${btn}`;
      }).join(" · ");
      const folded = foldedChars.has(c.name);
      return `<div class="st-char${folded ? " folded" : ""}" data-name="${escHtml(c.name)}"><div class="nm" title="Cliquer pour ${folded ? "déplier" : "replier"}"><b></b><span class="sum">Vie ${c.hp[0]}/${c.hp[1]} · Magie ${c.mp[0]}/${c.mp[1]}</span></div>${bar("hp", "Vie", c.hp)}${bar("mp", "Magie", c.mp)}
        <span>Force</span><span>${c.force}</span><span>Protection</span><span>${c.prot}</span>
        <div class="st-skills">${cls}</div></div>`;
    }).join("");
    stChars.querySelectorAll(".nm b").forEach((el, i) => { el.textContent = st.chars[i].name; });
  }
  setInterval(() => { updateStats().catch(() => {}); }, 1000);

  // --- Triche : monter de niveau ---------------------------------------------------
  // Le jeu ne vérifie le seuil qu'au moment d'un gain d'expérience (MAIN.EXE, § 12.2) : on
  // reproduit donc sa montée de niveau. Seuils = table de mots de 32 bits au début du segment
  // de données (adresse physique 0x30270) : niveau n -> n+1 quand xp >= table[n] ; niveau 10 maxi.
  // Bonus du jeu : Guerrier vie +4..6 ; Voleur vie +2..6 ; Mage magie +(1..8 + 17) × facteur/256
  // (mot +0x0C de la structure pointée par la fiche en +0x11 depuis le nom), puis vie +1..6.
  // La vie et la magie actuelles augmentent autant que leur maximum.
  const XP = { table: 0x30270, maxLevel: 10, levels: 100, xp: 106, hp: 55, hpMax: 57, mp: 59, mpMax: 61, ptr: 0x11 };
  let xpTable = [];
  const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
  async function levelUp(slot, skill) {
    if (MANAGE) {                       // ScummVM : la page ne peut pas écrire en mémoire, le moteur s'en charge
      const r = await mem.cmd({ op: "levelup", a: slot, b: skill });
      if (!r || r.code) invMessage(!r ? "Le jeu ne répond pas (menu ouvert ?) : réessaie en exploration." : "Montée de niveau impossible pour ce personnage.");
      lastStats = "";
      setTimeout(() => updateStats().catch(() => {}), 250);
      return;
    }
    const base = INV.char0 + slot * INV.charSize;               // adresse du nom
    const r = await mem.read([[base, INV.charSize], [XP.table, 4 * 11]]);
    if (!r) return;
    const c = r[0], t = r[1];
    const u16 = (k) => c[k] | c[k + 1] << 8;
    const lv = c[XP.levels + skill];
    if (lv >= XP.maxLevel) return;
    const need = (t[lv * 4] | t[lv * 4 + 1] << 8 | t[lv * 4 + 2] << 16 | t[lv * 4 + 3] << 24) >>> 0;
    const xpAt = XP.xp + 4 * skill;
    const xp = (c[xpAt] | c[xpAt + 1] << 8 | c[xpAt + 2] << 16 | c[xpAt + 3] << 24) >>> 0;
    const nx = Math.max(xp, need);
    const writes = [[base + XP.levels + skill, new Uint8Array([lv + 1])],
      [base + xpAt, new Uint8Array([nx & 255, nx >>> 8 & 255, nx >>> 16 & 255, nx >>> 24 & 255])]];
    const add = (cur, max, v) => {
      for (const k of [cur, max]) { const n = Math.min(32767, u16(k) + v); writes.push([base + k, new Uint8Array([n & 255, n >> 8])]); }
    };
    if (skill === 0) add(XP.hp, XP.hpMax, rnd(4, 6));
    else if (skill === 1) add(XP.hp, XP.hpMax, rnd(2, 6));
    else {
      const off = u16(XP.ptr), seg = u16(XP.ptr + 2);
      const f = (await mem.read([[seg * 16 + off + 0x0c, 2]])) || [[0, 1]];
      const factor = (f[0][0] | f[0][1] << 8) || 256;
      add(XP.mp, XP.mpMax, Math.floor((rnd(1, 8) + 17) * factor / 256));
      add(XP.hp, XP.hpMax, rnd(1, 6));
    }
    await mem.write(writes);
    lastStats = "";
    updateStats().catch(() => {});
  }
  stChars.addEventListener("click", (e) => {
    const b = e.target.closest(".lvup");
    if (!b) return;
    b.blur();
    levelUp(+b.dataset.slot, +b.dataset.skill).catch(() => {});
  });

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
    if (MANAGE) {                        // ScummVM : le moteur ajoute les pièces (et redessine le tas)
      await mem.cmd({ op: "money", a: 100 });
      lastStats = ""; setTimeout(() => updateStats().catch(() => {}), 300);
      return;
    }
    const r = await mem.read([[STATS.money, 2]]);
    if (!r) return;
    const v = Math.min(65535, (r[0][0] | r[0][1] << 8) + 100);
    await mem.write([[STATS.money, new Uint8Array([v & 255, v >> 8])]]);
    lastStats = "";                      // rafraîchir l'affichage du panneau
    updateStats().catch(() => {});
  });

  // ScummVM : le moteur applique lui-même les triches (une perte de vie ou de magie est remplacée
  // par le maximum, avant toute vérification de mort) : vraiment infinies. État renvoyé au
  // changement et toutes les 3 s (le jeu peut avoir redémarré).
  let cheatSent = -1, cheatSentAt = 0;
  async function sendCheats() {
    const mask = (cheatHp.checked ? 1 : 0) | (cheatMp.checked ? 2 : 0);
    if (mask === cheatSent && performance.now() - cheatSentAt < 3000) return;
    const r = await mem.cmd({ op: "cheat", a: mask }, 1500);
    if (r && r.code === 0) { cheatSent = mask; cheatSentAt = performance.now(); }
  }
  if (MANAGE) {
    for (const box of [cheatHp, cheatMp]) box.addEventListener("change", () => { cheatSent = -1; sendCheats().catch(() => {}); });
    setInterval(() => { if (!previewing) sendCheats().catch(() => {}); }, 1000);
  }

  let cheating = false;
  setInterval(async () => {
    if (MANAGE || cheating || previewing || !(cheatHp.checked || cheatMp.checked)) return;
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

  // Débogage : LoLMinimap.spriteChoice(11) -> sprites retenus pour ce niveau avec les drapeaux actuels
  async function spriteChoice(level) {
    const L = levels.find((l) => l.level === level);
    if (!L) return null;
    const saved = L.spriteOf; L.spriteOf = null;
    await resolveSprites(L);
    const res = L.spriteOf; L.spriteOf = saved;
    return res;
  }
  window.LoLMinimap = { attach() {}, preview, monsters: debugMonsters, spriteChoice };

  setInterval(() => { updateInventory().catch(() => {}); }, 1000);
  loadLevels().then(() => setInterval(tick, 200),
    (e) => { infoEl.textContent = "cartes introuvables (viewer/data) : " + e.message; });
})();
