// Mini-carte en direct à côté du jeu : lit la position du groupe dans la RAM du PC émulé.
// L'émulateur reste dans son worker ; la lecture passe par le canal « lol-mem » ajouté
// à emulators/wdosbox-x.js (quelques Ko toutes les 200 ms).
// Adresses physiques trouvées par recherche mémoire (voir docs/reverse-engineering.md, § 12).
(() => {
  "use strict";
  // taille de l'interface (Options : zoom CSS --ui-z) : les éléments placés en pixels par la page
  // reçoivent des coordonnées d'écran divisées par le zoom ; leurs tailles mesurées sont multipliées
  const UZ = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-z")) || 1;
  const ADDR = {
    block: 0x3E4E0,   // u16 : case du groupe = y*32 + x
    dir: 0x3E4EF,     // u16 : 0 N, 1 E, 2 S, 3 O
    grid: 0x3E713,    // grille vivante du niveau : 1024 cases de 10 octets, octets 0..3 = murs N E S O
    stride: 10,
    sceneFlag: 0x5D6B5,  // u8 : 5 en exploration, 1 pendant l'image fixe d'un lieu (observé)
  };
  // Caractéristiques (§ 12.2) : fiche de personnage, champs relatifs au nom ; argent du groupe
  const STATS = { money: 0x3E6F0 };   // couronnes d'argent (u16, vérifié : le jeu annonce la valeur écrite)
  // Inventaire (§ 12.2 de docs/reverse-engineering.md)
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

  // canevas de dessin : mini-carte, ou grande carte (Tab) le temps de son dessin (drawBig)
  let canvas = document.getElementById("mm-canvas");
  let g = canvas.getContext("2d");
  const titleEl = document.querySelector("#mm-title span");
  const infoEl = document.getElementById("mm-info");
  const labelEl = document.getElementById("mm-label");
  const itemsEl = document.getElementById("mm-items");
  const itemsTitleEl = document.getElementById("mm-items-title");
  const frame3d = document.getElementById("v3d-frame");
  // Taille de la carte à l'écran (SIZE, 256 à 768 px ; le panneau suit, variables CSS) et zoom
  // (CELL, 6 à 40 px par case) réglés à part et mémorisés. Centrage automatique (⌖) : la vue suit
  // le groupe, au centre ; sinon la carte entière est centrée, ou bornée au niveau si elle déborde.
  const CELL_MIN = 6, CELL_MAX = 40, SIZE_MIN = 256, SIZE_MAX = 768;
  let SIZE = 384, follow = true, view = [0, 0];      // view : décalage du coin haut-gauche (px carte)
  let lastDraw = [0, 0];
  function setSize(sz) {
    SIZE = Math.max(SIZE_MIN, Math.min(SIZE_MAX, sz));
    canvas.width = canvas.height = SIZE;
    document.documentElement.style.setProperty("--mm-size", SIZE + "px");
    document.getElementById("mm-smaller").disabled = SIZE <= SIZE_MIN;
    document.getElementById("mm-bigger").disabled = SIZE >= SIZE_MAX;
    try { localStorage.setItem("minimapSize", String(SIZE)); } catch (e) {}
    draw(lastDraw[0], lastDraw[1]);
    window.dispatchEvent(new Event("resize"));     // js-dos recalcule la taille du jeu
  }
  function setCell(c) {
    CELL = Math.max(CELL_MIN, Math.min(CELL_MAX, Math.round(c)));
    document.getElementById("mm-zout").disabled = CELL <= CELL_MIN;
    document.getElementById("mm-zin").disabled = CELL >= CELL_MAX;
    try { localStorage.setItem("minimapCell", String(CELL)); } catch (e) {}
    draw(lastDraw[0], lastDraw[1]);
  }
  function viewFor(block) {
    const full = 32 * CELL;
    const axis = (p) => {
      if (follow) return (p + 0.5) * CELL - SIZE / 2;                 // groupe au centre
      if (full <= SIZE) return -(SIZE - full) / 2;                    // carte entière, centrée
      return Math.max(0, Math.min(full - SIZE, (p + 0.5) * CELL - SIZE / 2));
    };
    return block < 1024 ? [axis(block % 32), axis(block >> 5)] : [-(SIZE - full) / 2, -(SIZE - full) / 2];
  }
  for (const [id, d] of [["mm-smaller", -64], ["mm-bigger", 64]])
    document.getElementById(id).addEventListener("click", (e) => { setSize(SIZE + d); e.currentTarget.blur(); });
  for (const [id, d] of [["mm-zout", -2], ["mm-zin", 2]])
    document.getElementById(id).addEventListener("click", (e) => { setCell(CELL + d); e.currentTarget.blur(); });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); setCell(CELL + (e.deltaY < 0 ? 2 : -2)); }, { passive: false });
  const centerBtn = document.getElementById("mm-center");
  try { follow = localStorage.getItem("minimapFollow") !== "0"; } catch (e) {}
  centerBtn.classList.toggle("on", follow);
  centerBtn.addEventListener("click", (e) => {
    follow = !follow; centerBtn.classList.toggle("on", follow); e.currentTarget.blur();
    try { localStorage.setItem("minimapFollow", follow ? "1" : "0"); } catch (err) {}
    draw(lastDraw[0], lastDraw[1]);
  });

  const mem = new LoLMem.RemoteMemory();
  const levels = [];          // { level, name, faces: Uint8Array(4096), wallTypes, labels }
  let current = null, lastHash = -1, lastIdentify = 0;
  let live = new Uint8Array(4096);     // grille vivante (remplacée le temps du dessin d'un autre niveau : grande carte)

  // Chargement un par un, avec nouvelles tentatives : le petit serveur local
  // (python -m http.server) supporte mal les requêtes simultanées.
  async function getJSON(url) {
    for (let i = 0; ; i++) {
      try { const r = await fetch(url); if (r.ok) return await r.json(); throw new Error(r.status); }
      catch (e) { if (i >= 4) throw e; await new Promise((ok) => setTimeout(ok, 300 * (i + 1))); }
    }
  }
  async function loadLevels() {
    const index = await getJSON("viewer/data/levels.json?v=20261114b");
    for (const l of index) {
      const d = await getJSON(`viewer/data/level${String(l.level).padStart(2, "0")}.json?v=20261114b`);
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
        if (g.items.every((x) => x.type === g.items[0].type)) ic.dataset.type = g.items[0].type;   // infobulle de l'objet
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
  // Entrée de 16 octets : +0 suivant, +4 hauteur de vol (objet lancé : 12, puis 0 à l'arrivée),
  // +5 case, +7 x, +9 y (case*256 + décalage), +12 type.
  const ITEMS = { base: INV.items - 12, size: 16 };
  function readLiveItems(grid, table) {
    if (!itemInfo || !current) return null;
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
            xOffs: table[o + 7], yOffs: table[o + 9], h: table[o + 4], id, container: chest ? "chest" : wall ? "wall" : undefined });
        }
        id = w(o);
      }
    }
    return out;
  }

  // Drapeaux de case (octet 9) : 0x80 = flaque de sang (LoLEngine::drawBlockEffects)
  let liveBlood = [];
  function readGrid(bytes) {
    let hash = 0;
    liveBlood = [];
    for (let i = 0; i < 1024; i++) {
      const a = i * ADDR.stride;
      for (let k = 0; k < 4; k++) { const v = bytes[a + k]; live[i * 4 + k] = v; hash = (hash * 31 + v) | 0; }
      gameSeen[i] = bytes[a + 9] & 7 ? 1 : 0;
      if (bytes[a + 9] & 0x80) liveBlood.push(i);
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
  // Mode « jeu » (◐ jeu) : la carte montre exactement les cases de la carte automatique du jeu, sans
  // l'exploration de la page. ScummVM publie celle de tous les niveaux visités (zone 0x7F001000 :
  // niveaux visités u32, puis 29 × 128 octets, un bit par case) ; DOSBox : niveau en cours seulement.
  // Le jeu ne marque les cases qu'une fois l'atlas trouvé (updateAutoMap, drapeau 0x10 de l'octet 31).
  const SEEN_KEY = (level) => `minimapSeen:${window.LOL_ENGINE || "dosbox"}:${level}`;
  const seenOf = new Map();                     // n° de niveau -> Uint8Array(1024)
  const gameSeen = new Uint8Array(1024);        // marques du jeu dans la grille vivante
  let fogOn = true, fogGame = false;
  try { const v = localStorage.getItem("minimapFog"); fogOn = v !== "0"; fogGame = v === "game"; } catch (e) {}
  const gameMaps = new Map();                   // n° de niveau -> Uint8Array(1024), autres niveaux (ScummVM)
  let gameSeenLevel = null;                     // niveau de la grille vivante (gameSeen)
  const NO_CELLS = new Uint8Array(1024);
  const gameMapFor = (L) => L.level === gameSeenLevel ? gameSeen : gameMaps.get(L.level) || NO_CELLS;
  const GAME_MAP = 0x7F001000;
  let gameMapsTime = 0, gameMapsHash = 0;
  async function readGameMaps() {
    if (window.LOL_ENGINE !== "scummvm") return false;      // DOSBox : grille vivante seulement
    const r = await mem.read([[GAME_MAP, 4 + 29 * 128]]);
    if (!r || !r[0]) return false;
    const b = r[0], visited = (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0;
    let hash = visited | 0;
    for (let l = 0; l < 29; l++) {
      if (!(visited & (1 << l))) { gameMaps.delete(l + 1); continue; }
      const m = gameMaps.get(l + 1) || new Uint8Array(1024);
      for (let i = 0; i < 1024; i++) { m[i] = (b[4 + l * 128 + (i >> 3)] >> (i & 7)) & 1; hash = (hash * 31 + m[i]) | 0; }
      gameMaps.set(l + 1, m);
    }
    const changed = hash !== gameMapsHash;
    gameMapsHash = hash;
    return changed;
  }
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
  const visible = (L, i) => !fogOn || !L || (fogGame ? gameMapFor(L)[i] === 1 : seenFor(L)[i] === 1);
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
  const FOG_TITLE = {
    off: "Toute la carte (clic : exploration de la page)",
    web: "Exploration de la page : cases déjà vues par le groupe (clic : carte du jeu)",
    game: "Carte du jeu : mêmes cases que la carte automatique du jeu, atlas requis (clic : toute la carte)",
  };
  function showFogBtn(b) {
    const mode = !fogOn ? "off" : fogGame ? "game" : "web";
    b.classList.toggle("on", fogOn); b.classList.toggle("game", fogGame && fogOn);
    b.textContent = mode === "game" ? "◐ jeu" : "◐"; b.title = FOG_TITLE[mode];
  }
  function refreshFog() {
    showFogBtn(fogBtn);
    forgetBtn.disabled = !fogOn || fogGame || !current;
    fogKey = "";
    if (current) renderItemList(current);
    draw(lastDraw[0], lastDraw[1]);
  }
  fogBtn.addEventListener("click", (e) => {
    // cycle : toute la carte -> exploration de la page -> carte du jeu -> toute la carte
    if (!fogOn) { fogOn = true; fogGame = false; } else if (!fogGame) fogGame = true; else { fogOn = false; fogGame = false; }
    try { localStorage.setItem("minimapFog", !fogOn ? "0" : fogGame ? "game" : "1"); } catch (err) {}
    if (fogGame) readGameMaps().then(() => refreshFog());
    refreshFog(); e.currentTarget.blur();
  });
  forgetBtn.addEventListener("click", (e) => {
    e.currentTarget.blur();
    if (!current || !confirm(`Oublier l'exploration du niveau ${current.level} (${current.fr}) sur la mini-carte ?`)) return;
    seenFor(current).fill(0); saveSeen(current);
    if (lastDraw[0] < 1024) explore(current, lastDraw[0], lastDraw[1]);
    refreshFog();
  });
  showFogBtn(fogBtn);
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
      im.src = `viewer/data/level${nn}_${name}.png?v=20261122b`; });
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
    if (!img.tiles) img.tiles = new Map();          // une réserve de tuiles par taille de case
    if (!img.tiles.has(CELL)) img.tiles.set(CELL, new Map());
    const tiles = img.tiles.get(CELL);
    let c = tiles.get(key);
    if (!c) {
      c = document.createElement("canvas"); c.width = c.height = CELL - 1;
      const t = c.getContext("2d"); t.imageSmoothingEnabled = true; t.imageSmoothingQuality = "high";
      paint(t, CELL - 1); tiles.set(key, c);
    }
    return c;
  }
  const face = (L, img, t, tex, s, crop) => {          // crop : [x, y, l, h] dans la face 128×96
    const fx = (tex % L.atlasCols) * L.faceW, fy = Math.floor(tex / L.atlasCols) * L.faceH;
    const [cx, cy, cw, ch] = crop || [0, 0, L.faceW, L.faceH];
    t.drawImage(img.walls, fx + cx, fy + cy, cw, ch, 0, 0, s, s);
  };
  const floorTile = (L, img) => tile(L, img, "floor", (t, s) => {
    t.drawImage(img.floor, 0, 0, img.floor.width, img.floor.height, 0, 0, s, s);
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
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = "#000"; g.fillRect(0, 0, canvas.width, canvas.height);
    if (!L) return;
    view = viewFor(block);
    g.setTransform(1, 0, 0, 1, -Math.round(view[0]), -Math.round(view[1]));
    const img = texMode ? levelImages(L) : null;
    for (let i = 0; i < 1024; i++) {
      const cls = cellClass(L, i), x = (i % 32) * CELL, y = Math.floor(i / 32) * CELL;
      if (!visible(L, i)) {
        // case inexplorée qui touche une case explorée par un côté : grisée (bord de l'exploration)
        const cx = i % 32, cy = i >> 5;
        const edge = (cx > 0 && visible(L, i - 1)) || (cx < 31 && visible(L, i + 1)) || (cy > 0 && visible(L, i - 32)) || (cy < 31 && visible(L, i + 32));
        g.fillStyle = edge ? "#3d3a35" : "#15120e"; g.fillRect(x, y, CELL - 1, CELL - 1); continue;
      }
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
    // groupe : flèche orientée (pas de flèche sur un autre niveau : grande carte)
    if (block > 1023) return;
    const cx = (block % 32) * CELL + CELL / 2, cy = Math.floor(block / 32) * CELL + CELL / 2;
    const a = [-Math.PI / 2, 0, Math.PI / 2, Math.PI][dir & 3];
    g.fillStyle = "#fff"; g.strokeStyle = "#000"; g.lineWidth = 1.5;
    g.beginPath();
    g.lineWidth = 1.5;
    g.moveTo(cx + Math.cos(a) * 9 * k, cy + Math.sin(a) * 9 * k);
    g.lineTo(cx + Math.cos(a + 2.4) * 6 * k, cy + Math.sin(a + 2.4) * 6 * k);
    g.lineTo(cx + Math.cos(a - 2.4) * 6 * k, cy + Math.sin(a - 2.4) * 6 * k);
    g.closePath(); g.stroke(); g.fill();
    if (bigOpen && !drawingBig) drawBig();
  }

  // --- Grande carte (touche Tab) ----------------------------------------------------------
  // Même dessin que la mini-carte (draw), dans un canevas de fenêtre modale : case de la taille
  // qui remplit l'écran, niveau entier centré. Double-clic : téléportation (version ScummVM).
  const bigDlg = document.getElementById("bm-dlg"), bigCanvas = document.getElementById("bm-canvas");
  const bigG = bigCanvas.getContext("2d"), bigHint = document.getElementById("bm-hint");
  let bigOpen = false, drawingBig = false, bigCell = 20;
  // Autre niveau choisi dans la grande carte : le temps d'un dessin ou d'une info-bulle, il devient
  // le niveau « courant », avec sa grille de départ et sans monstres (données exportées).
  let bigLevel = null;                     // n° du niveau affiché (null : celui du groupe)
  const bigOther = () => bigLevel !== null && (!current || bigLevel !== current.level) ? levels.find((l) => l.level === bigLevel) : null;
  function withBigLevel(fn) {
    const Lb = bigOther();
    if (!Lb) return fn(null);
    const save = [current, live, monsters, lastDraw];
    current = Lb; live = Lb.faces; monsters = [];
    try { return fn(Lb); } finally { [current, live, monsters, lastDraw] = save; }
  }
  function drawBig() {
    const save = [canvas, g, CELL, SIZE, follow, view];
    drawingBig = true;
    try {
      canvas = bigCanvas; g = bigG; CELL = bigCell; SIZE = 32 * bigCell; follow = false;
      withBigLevel((Lb) => (Lb ? draw(0xFFFF, 0) : draw(lastDraw[0], lastDraw[1])));
    } finally {
      [canvas, g, CELL, SIZE, follow, view] = save;
      drawingBig = false;
    }
    if ((current ? current.level : null) !== bigFilledFor) fillBigLevels();     // le groupe a changé de niveau
    const shown = bigOther() || current;
    document.getElementById("bm-title").textContent = shown ? `Niveau ${shown.level} — ${shown.fr}` : "Carte";
  }
  // options d'affichage de la mini-carte, reprises dans la fenêtre (mêmes réglages) : cases
  // illustrées, brouillard ; ↺ oublie l'exploration du niveau affiché ; légende recopiée
  const bmTex = document.getElementById("bm-tex"), bmFog = document.getElementById("bm-fog"), bmForget = document.getElementById("bm-forget"),
    bmForgetAll = document.getElementById("bm-forget-all");
  function syncBigOpts() {
    bmTex.classList.toggle("on", texMode); showFogBtn(bmFog); bmForget.disabled = bmForgetAll.disabled = !fogOn || fogGame;
  }
  bmTex.addEventListener("click", (e) => { e.currentTarget.blur(); setTexMode(!texMode); syncBigOpts(); });
  bmFog.addEventListener("click", (e) => { e.currentTarget.blur(); fogBtn.click(); syncBigOpts(); });
  bmForget.addEventListener("click", (e) => {
    e.currentTarget.blur();
    const L = bigOther() || current;
    if (!L || !confirm(`Oublier l'exploration du niveau ${L.level} (${L.fr}) sur la carte ?`)) return;
    seenFor(L).fill(0); saveSeen(L);
    if (L === current && lastDraw[0] < 1024) explore(current, lastDraw[0], lastDraw[1]);
    refreshFog();
  });
  // ↺ tous : oublie l'exploration de tous les niveaux (moteur de la page), mémorisée ou non
  bmForgetAll.addEventListener("click", (e) => {
    e.currentTarget.blur();
    if (!confirm("Oublier l'exploration de tous les niveaux sur les cartes ?\n\n" +
      "Les cases marquées par la carte automatique du jeu (niveau en cours) réapparaîtront.")) return;
    const prefix = SEEN_KEY("");
    try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith(prefix)) localStorage.removeItem(k); } } catch (err) {}
    seenOf.clear();
    if (current && lastDraw[0] < 1024) explore(current, lastDraw[0], lastDraw[1]);
    refreshFog();
  });
  const bigLevelSel = document.getElementById("bm-level");
  let bigFilledFor = undefined;
  function fillBigLevels() {
    if (!levels.length) return;
    const cur = current ? current.level : null;
    bigFilledFor = cur;
    bigLevelSel.replaceChildren(...levels.map((L) => {
      const o = document.createElement("option"); o.value = L.level;
      o.textContent = `${L.level}. ${L.fr}${L.level === cur ? " (groupe)" : ""}`; return o;
    }));
    bigLevelSel.value = bigLevel !== null ? bigLevel : cur !== null ? cur : levels[0].level;
  }
  bigLevelSel.addEventListener("change", () => {
    const v = +bigLevelSel.value;
    bigLevel = current && v === current.level ? null : v;
    bigLevelSel.blur(); tipEl.hidden = true; drawBig();
  });
  function openBig() {
    const box = Math.min(innerWidth - 120, innerHeight - 200);     // place pour l'en-tête et la légende
    bigCell = Math.max(10, Math.min(40, Math.floor(box / 32)));
    bigCanvas.width = bigCanvas.height = 32 * bigCell;
    bigCanvas.style.width = bigCanvas.style.height = 32 * bigCell + "px";
    bigLevel = null; fillBigLevels(); syncBigOpts();
    document.getElementById("bm-legend").innerHTML = document.getElementById("mm-legend").innerHTML;
    bigHint.textContent = MANAGE ? "Double-clic sur une case : s'y téléporter. Tab ou Échap : fermer." : "Tab ou Échap : fermer.";
    bigDlg.showModal(); bigOpen = true;
    bigDlg.appendChild(tipEl);                       // info-bulle au-dessus de la fenêtre
    drawBig();
  }
  function closeBig() { if (bigDlg.open) bigDlg.close(); }
  bigDlg.addEventListener("close", () => {
    bigOpen = false; tipEl.hidden = true; document.body.appendChild(tipEl);
    const f = document.getElementById("dos"); if (f && f.focus) f.focus();
  });
  const bigCellAt = (e) => {
    const r = bigCanvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / r.width * 32), y = Math.floor((e.clientY - r.top) / r.height * 32);
    return x < 0 || y < 0 || x > 31 || y > 31 ? null : [x, y];
  };
  bigCanvas.addEventListener("mousemove", (e) => {
    const c = (current || bigOther()) && bigCellAt(e);
    if (!c) { tipEl.hidden = true; return; }
    const key = (bigLevel ?? "") + ":" + c.join(",");
    if (tipEl.hidden || tipEl.dataset.cell !== key) { tipEl.dataset.cell = key; showTip(withBigLevel(() => cellInfo(c[0], c[1])), e.clientX, e.clientY); }
    else { tipAt = [e.clientX, e.clientY]; placeTip(); }
  });
  bigCanvas.addEventListener("mouseleave", () => { tipEl.hidden = true; tipEl.dataset.cell = ""; });
  bigCanvas.addEventListener("dblclick", (e) => {
    const c = (current || bigOther()) && bigCellAt(e);
    if (!c || !MANAGE) return;
    if (window.lolCheatsShown && !window.lolCheatsShown()) { bigHint.textContent = "Téléportation : triche cachée (Options…)."; return; }
    const i = c[1] * 32 + c[0];
    // mêmes règles que sur le niveau du groupe ; un autre niveau est chargé (commande goto)
    const check = withBigLevel(() => !visible(current, i) ? "Case inexplorée." : opaque(current, i) && cellClass(current, i) !== "doorClosed" ? "Case pleine." : "");
    if (check) { bigHint.textContent = check; return; }
    const target = bigOther() || current;
    bigHint.textContent = target !== current ? `Chargement du niveau ${target.level}…` : "";
    teleport(target.level, i).then((msg) => {
      bigLevel = null; fillBigLevels(); drawBig();
      bigHint.textContent = msg || "Téléporté.";
      clearTimeout(bigHint.t); bigHint.t = setTimeout(() => { bigHint.textContent = "Double-clic sur une case : s'y téléporter. Tab ou Échap : fermer."; }, 3000);
    });
  });
  document.getElementById("bm-close").addEventListener("click", closeBig);
  bigDlg.addEventListener("click", (e) => { if (e.target === bigDlg) closeBig(); });
  // Tab : ouvrir / fermer, depuis la page ou depuis le jeu (cadre ScummVM : écouteur dans sa fenêtre)
  const onTab = (e) => {
    if (!LoLKeys.is(e, "map")) return;
    const t = e.target, typing = t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA");
    if (typing && !bigOpen) return;
    const other = document.querySelector("dialog[open]:not(#bm-dlg)");
    if (other) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (bigOpen) closeBig(); else openBig();
  };
  addEventListener("keydown", onTab, true);
  const hookFrame = () => { const f = document.querySelector("iframe#dos"); try { if (f && f.contentWindow) f.contentWindow.addEventListener("keydown", onTab, true); } catch (e) {} };
  hookFrame();
  { const f = document.querySelector("iframe#dos"); if (f) f.addEventListener("load", hookFrame); }
  for (const ev of ["keyup", "keypress"]) bigDlg.addEventListener(ev, (e) => e.stopPropagation());
  bigDlg.addEventListener("keydown", (e) => { if (!LoLKeys.is(e, "map")) e.stopPropagation(); });

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
    tipEl.style.left = Math.max(4, left) / UZ() + "px"; tipEl.style.top = Math.max(4, top) / UZ() + "px";
  }

  // Illustration d'un lieu : image du jeu (fonction 0x29, § 8) si une case de l'entrée en a une,
  // sinon vue 3D prise depuis la case devant l'entrée (x2, y2 de l'annotation), tournée vers le lieu.
  const placeImg = new Map();             // "niveau:n" -> {src, kind} ou Promise
  let snapId = 0;
  const snapWait = new Map();
  // Interrupteur cliqué dans la vue 3D (mur devant le groupe) : le moteur ScummVM clique ce mur
  // comme le joueur (commande clickwall, clickedWall du jeu). Sous DOSBox, pas de commande.
  addEventListener("message", async (e) => {
    if (e.origin !== location.origin || !e.data || e.data.type !== "lol-clickwall") return;
    if (window.LOL_ENGINE !== "scummvm") { console.info("Interrupteur : actionnable seulement sous ScummVM"); return; }
    try { await mem.cmd({ op: "clickwall" }, 5000); } catch (err) { console.warn("clickwall", err); }
  });
  // Espace devant un interrupteur (la vue 3D signale s'il y en a un devant le groupe) : même
  // commande que le clic. La touche part aussi au jeu, qui ne s'en sert qu'en boîte de dialogue.
  let switchAhead = false;
  addEventListener("message", (e) => {
    if (e.origin === location.origin && e.data && e.data.type === "lol-switch-ahead") switchAhead = !!e.data.on;
  });
  const onSpace = (e) => {
    if (!LoLKeys.is(e, "switch") || e.repeat || !switchAhead || window.LOL_ENGINE !== "scummvm" || LoLKeys.typing(e.target)) return;
    if (document.querySelector("dialog[open]")) return;
    mem.cmd({ op: "clickwall" }, 5000).catch((err) => console.warn("clickwall", err));
  };
  addEventListener("keydown", onSpace, true);
  const hookSpace = () => { const f = document.querySelector("iframe#dos"); try { if (f && f.contentWindow) f.contentWindow.addEventListener("keydown", onSpace, true); } catch (e) {} };
  hookSpace();
  { const f = document.querySelector("iframe#dos"); if (f) f.addEventListener("load", hookSpace); }
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
    const x = Math.floor(((e.clientX - r.left) / r.width * SIZE + Math.round(view[0])) / CELL);
    const y = Math.floor(((e.clientY - r.top) / r.height * SIZE + Math.round(view[1])) / CELL);
    if (x < 0 || y < 0 || x > 31 || y > 31) { tipEl.hidden = true; return; }
    const key = `${x},${y}`;
    if (tipEl.hidden || tipEl.dataset.cell !== key) { tipEl.dataset.cell = key; showTip(cellInfo(x, y), e.clientX, e.clientY); }
    else { tipAt = [e.clientX, e.clientY]; placeTip(); }
  });
  canvas.addEventListener("mouseleave", () => { tipEl.hidden = true; tipEl.dataset.cell = ""; });

  {
    let c = 12, sz = 0;
    try { c = +localStorage.getItem("minimapCell") || 12; sz = +localStorage.getItem("minimapSize") || 0; } catch (e) {}
    setCell(c); setSize(sz || 32 * c);              // ancienne version : taille = 32 cases
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
      // +12 image d'animation, +13 mode ; +18 drapeaux (& 7 = variante de couleurs), +35..+38 équipement
      out.push({ slot: i, x: x / 256, y: y / 256, dir: bytes[a + 17] & 3, type: bytes[a + 25], sf: bytes[a + 12], mode: bytes[a + 13],
        variant: bytes[a + 18] & 7, equip: [bytes[a + 35], bytes[a + 36], bytes[a + 37], bytes[a + 38]],
        hitX: (bytes[a + 10] << 24) >> 24, hitY: (bytes[a + 11] << 24) >> 24,     // +10/+11 : hitOffsX/Y (signés)
        hp: ((bytes[a + 22] | bytes[a + 23] << 8) << 16) >> 16 });               // +22 : points de vie actuels
    }
    return out;
  }

  async function update() {
    const r = await mem.read([[ADDR.block, 2], [ADDR.dir, 2], [ADDR.grid, 1024 * ADDR.stride],
      [MON.x0 - 2, MON.size * MON.count], [ADDR.sceneFlag, 1], [ITEMS.base, ITEMS.size * INV.maxItems],
      ...(ENGINE_SPRITES ? [[CUR_LEVEL, 1]] : [])]);
    if (!r) { titleEl.textContent = "Mini-carte"; infoEl.textContent = "en attente du jeu…"; return; }
    const block = r[0][0] | r[0][1] << 8, dir = r[1][0] | r[1][1] << 8;
    const hash = readGrid(r[2]);
    monsters = readMonsters(r[3]);
    if (ENGINE_SPRITES) {
      // ScummVM : image de chaque monstre telle que le jeu la dessine (attaques, coups, marche)
      // + giclée d'un coup reçu : réduction 1-4 (0 = aucune), couleur 0-3, décalage hitOffsX/Y
      // + points de vie maximum du type (zone 0x7F000900 : 5 × u16) pour la barre de vie de la vue 3D
      const f = await mem.read([[0x7F000200, 120], [0x7F000900, 20]]);
      if (f) for (const m of monsters) {
        const k = m.slot * 4;
        m.frame = f[0][k]; m.flip = !!f[0][k + 1]; m.blood = f[0][k + 2]; m.bloodType = f[0][k + 3];
        m.hpMax = m.type < 5 ? f[1][m.type * 2] | f[1][m.type * 2 + 1] << 8 : 0;
        m.translucent = m.type < 5 && !!(f[1][10 + m.type * 2 + 1] & 0x08);    // drapeau 0x800 du type
      }
    }
    const inScene = r[4][0] === 1;
    const now = performance.now();
    // ScummVM publie le niveau en cours ; sous DOSBox, on le reconnaît à sa grille (identify)
    const engineLevel = ENGINE_SPRITES && r[6] ? levels.find((q) => q.level === r[6][0]) : undefined;
    if (engineLevel && engineLevel !== current) {
      renderItemList(engineLevel); engineLevel.spriteOf = null;
      current = engineLevel; lastHash = hash; lastIdentify = now;
    } else if (!engineLevel && hash !== lastHash && now - lastIdentify > 500) {
      const found = identify();
      if (found !== current) { renderItemList(found); if (found) found.spriteOf = null; }
      current = found; lastHash = hash; lastIdentify = now;
    }
    // objets lus une fois le niveau connu (cases de mur, coffres : d'après ses données) ; une partie
    // chargée au lancement (save_slot) en a déjà avant que le niveau soit reconnu
    const liveItems = current ? readLiveItems(r[2], r[5]) : null;
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
    gameSeenLevel = current.level;
    explore(current, block, dir);
    forgetBtn.disabled = !fogOn || fogGame;
    if (fogGame && fogOn && now - gameMapsTime > 1000) {      // autres niveaux de la carte du jeu (ScummVM)
      gameMapsTime = now;
      if (await readGameMaps() && bigOpen && bigOther()) drawBig();
    }
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
    sendBloodTo3d(current.level);
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
  const CUR_LEVEL = 0x7F000A00;   // u8 publié par le moteur : niveau en cours
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
    // objets d'une niche : dans la case du mur, contre la face tournée vers le groupe (décalage 0x00 ou
    // 0xFF), hauteur 8 (clickedNiche) ; montrés un peu en avant de la face pour ne pas être cachés par le mur
    const nudge = (o) => (o >= 0xF0 ? o + 24 : o <= 0x10 ? o - 24 : o);
    // coffre ou niche à volets (manoir de Roland) : objets montrés quand la face contre laquelle ils
    // sont posés est ouverte (état 1 ouvert, 2 ouvert vide, 3 cassé ; 0 fermé)
    const faceOf = (i) => { const xo = i.xOffs || 0, yo = i.yOffs || 0; return yo <= 0x10 ? 0 : xo >= 0xF0 ? 1 : yo >= 0xF0 ? 2 : xo <= 0x10 ? 3 : -1; };
    const openChest = (i) => { const f = faceOf(i), st = f >= 0 ? chestState(L, i.y * 32 + i.x, f) : -1; return st >= 0 && st % 4 !== 0; };
    // niche : seulement si la face est (devenue) une niche, type spécial 6 ; fermée, c'est un mur plein
    // (manoir de Roland : la face 4,8 nord passe du type 1 au type 64 quand un script l'ouvre)
    const openNiche = (i) => { const f = faceOf(i), t = f >= 0 ? L.wallTypes[live[(i.y * 32 + i.x) * 4 + f]] : null; return !!t && t[1] === 6; };
    const list = items.filter((i) => !i.container || (i.container === "wall" && i.h > 1 && openNiche(i)) || (i.container === "chest" && openChest(i))).map((i) => {
      const niche = !!i.container;
      const xo = niche ? nudge(i.xOffs || 0) : i.xOffs || 0, yo = niche ? nudge(i.yOffs || 0) : i.yOffs || 0;
      return { x: i.x + xo / 256, y: i.y + yo / 256, type: i.type, h: i.h || 0, id: i.id };
    });
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
  let lastBloodSent = "";
  function sendBloodTo3d(level) {
    const key = `${level}:${liveBlood.join(",")}`;
    if (key === lastBloodSent || !frame3d || !frame3d.contentWindow) return;
    lastBloodSent = key;
    frame3d.contentWindow.postMessage({ type: "lol-blood", level, cells: liveBlood.slice() }, location.origin);
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
  getJSON("viewer/data/items.json?v=20261114a").then((d) => { itemInfo = d; if (current) renderItemList(current); }, () => {});

  // Emplacements d'équipement vides : image du jeu (GAMESHP.SHP, slotShapes de
  // gui_drawCharInventoryItem : silhouette de l'arme, du bouclier, du casque…), exportée dans
  // viewer/data/slot_shapes.png ; mise à l'échelle de la case (22 px du jeu -> 28 px de contenu).
  let slotShapes = null;
  getJSON("viewer/data/slot_shapes.json?v=20261114b").then((d) => { slotShapes = d; lastInv = ""; updateInventory().catch(() => {}); }, () => {});
  function slotPlaceholder(d, loc) {
    if (!slotShapes || loc === undefined || loc < 200) return;
    const r = slotShapes.slots[(loc - 200) % 11];
    if (!r) return;
    const k = 28 / 22, [x, y, w, h] = r;
    d.classList.add("ph");
    d.style.backgroundSize = `${slotShapes.w * k}px ${slotShapes.h * k}px`;
    d.style.backgroundPosition = `${-x * k + (28 - w * k) / 2}px ${-y * k + (28 - h * k) / 2}px`;
  }
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
    } else {
      if (label) d.title = `${label} : vide`;
      slotPlaceholder(d, loc);
    }
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
  // Infobulle flottante des objets (survol) : nom, nature, effets, emplacement, comparaison avec
  // l'équipement porté, valeur, texte. Sur tout élément portant data-type (sac, équipement, annuaire,
  // liste du niveau) ou data-item-type (barre d'actions), et sur les objets au sol de la vue 3D
  // (message « lol-itemhover »). Dans une fenêtre modale (couche supérieure), l'infobulle y est placée.
  const itemTip = document.createElement("div");
  itemTip.id = "item-tip"; itemTip.hidden = true;
  {
    const st = document.createElement("style");
    st.textContent = `
    #item-tip { position: fixed; z-index: 1005; max-width: 300px; padding: 8px 10px; border: 1px solid #c9a227; border-radius: 6px;
      background: rgba(14, 11, 7, .96); color: #e8dcc0; font: 12px/1.4 system-ui, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.7);
      pointer-events: none; zoom: var(--ui-z, 1); display: grid; grid-template-columns: 30px 1fr; gap: 2px 8px; margin: 0; }
    dialog #item-tip { zoom: 1; }
    #item-tip[hidden] { display: none; }
    #item-tip .slot { grid-row: span 2; }
    #item-tip .nm { color: #f0d070; font-weight: 600; font-size: 13px; }
    #item-tip .kd { color: #a39578; }
    #item-tip ul { grid-column: 1 / 3; margin: 4px 0 0; padding-left: 16px; }
    #item-tip .cmp, #item-tip .note2 { grid-column: 1 / 3; margin-top: 4px; }
    #item-tip .note2 { color: #a39578; font-style: italic; }
    #item-tip .txt { grid-column: 1 / 3; margin-top: 4px; padding: 4px 6px; background: #e8dcc0; color: #2a2217; border-radius: 3px;
      font: italic 11px/1.35 Georgia, serif; white-space: pre-wrap; }`;
    document.head.appendChild(st);
    document.body.appendChild(itemTip);
  }
  function fillItemTip(type, note) {
    const it = itemInfo && itemInfo[type] ? itemInfo[type] : { name: `objet ${type}`, icon: -1, effects: [] };
    const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const icon = el("div", "slot full"); setIcon(icon, it.icon);
    const lines = [...(it.effects || [])];
    if (it.wear) lines.push(`Se porte : ${it.wear}`);
    if (it.value) lines.push(`Valeur : ${it.value}`);
    itemTip.replaceChildren(icon, el("div", "nm", it.name), el("div", "kd", it.kind || "Objet"));
    if (lines.length) { const ul = el("ul"); for (const l of lines) ul.appendChild(el("li", null, l)); itemTip.appendChild(ul); }
    const cmp = compareEquip(type, it);
    if (cmp) itemTip.appendChild(cmp);
    if (it.text) itemTip.appendChild(el("div", "txt", it.text.length > 220 ? it.text.slice(0, 220) + "…" : it.text));
    if (note) itemTip.appendChild(el("div", "note2", note));
  }
  function placeItemTip(x, y) {
    const z = UZ(), w = itemTip.offsetWidth * z, h = itemTip.offsetHeight * z;
    let left = x + 16, top = y + 16;
    if (left + w > innerWidth - 4) left = x - w - 12;
    if (top + h > innerHeight - 4) top = y - h - 12;
    itemTip.style.left = Math.max(4, left) / z + "px"; itemTip.style.top = Math.max(4, top) / z + "px";
  }
  function showItemTip(type, x, y, host, note) {
    if (!itemInfo || type < 0) { itemTip.hidden = true; return; }
    host = host || document.body;
    if (itemTip.parentNode !== host) host.appendChild(itemTip);
    if (itemTip.dataset.type !== String(type) || itemTip.dataset.note !== (note || "")) { fillItemTip(type, note); itemTip.dataset.type = type; itemTip.dataset.note = note || ""; }
    itemTip.hidden = false;
    placeItemTip(x, y);
  }
  let tipTarget = null;
  document.addEventListener("mouseover", (e) => {
    const t = e.target.closest && e.target.closest("[data-type], [data-item-type]");
    if (t === tipTarget) return;
    if (tipTarget && tipTarget.dataset.tipTitle !== undefined) { tipTarget.title = tipTarget.dataset.tipTitle; delete tipTarget.dataset.tipTitle; }
    tipTarget = t;
    if (!t) { itemTip.hidden = true; return; }
    if (t.title) { t.dataset.tipTitle = t.title; t.title = ""; }        // pas d'infobulle du navigateur en double
    showItemTip(+(t.dataset.itemType ?? t.dataset.type), e.clientX, e.clientY, t.closest("dialog") || document.body, t.dataset.itemNote);
  });
  document.addEventListener("mousemove", (e) => { if (tipTarget && !itemTip.hidden) placeItemTip(e.clientX, e.clientY); });
  addEventListener("message", (e) => {
    if (e.origin !== location.origin || !e.data || e.data.type !== "lol-itemhover") return;
    if (e.data.t < 0 || !frame3d) { if (!tipTarget) itemTip.hidden = true; return; }
    const r = frame3d.getBoundingClientRect();
    showItemTip(e.data.t, r.left + e.data.x, r.top + e.data.y, document.body, "Au sol : clic pour le prendre");
  });

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
  let lastInv = "", owned = new Set(), lastHand = -1;
  let stackView = false;                                     // sac affiché par piles d'objets identiques
  try { stackView = localStorage.getItem("invStacks") === "on"; } catch (e) {}         // types d'objets possédés (inventaire, main, équipement)
  async function updateInventory() {
    if (!itemInfo || previewing) return;
    const r = await mem.read([[INV.bar, INV.barSlots * 2], [INV.hand, 2], [INV.items, INV.itemSize * INV.maxItems],
      PARTY_RANGE(), ...(MANAGE ? [[0x7F000C00, 8]] : [])]);
    if (!r) return;
    const [bar, hand, table, ch, use] = r;
    // emplacements d'équipement que la race de chaque personnage a (moteur ScummVM ; tous sinon)
    const usable = (slot) => (use ? use[slot * 2] | use[slot * 2 + 1] << 8 : 0x7FF) || 0x7FF;
    const typeOf = (id) => (id > 0 && id < INV.maxItems ? table[id * INV.itemSize] | table[id * INV.itemSize + 1] << 8 : -1);
    const barTypes = [];
    for (let k = 0; k < INV.barSlots; k++) barTypes.push(typeOf(bar[k * 2] | bar[k * 2 + 1] << 8));
    const handType = typeOf(hand[0] | hand[1] << 8);
    const party = partyChars(ch).map((c) => ({ name: c.name, slot: c.slot, usable: usable(c.slot),
      id: Math.abs(((c.at(12) | c.at(13) << 8) << 16) >> 16),
      eq: Array.from({ length: INV.equipSlots }, (_, k) => typeOf(c.at(INV.equipOffset + 2 * k) | c.at(INV.equipOffset + 2 * k + 1) << 8)) }));
    owned = new Set([...barTypes, handType, ...party.flatMap((c) => c.eq)].filter((t) => t >= 0));
    const key = JSON.stringify([barTypes, handType, party]);
    lastInvData = { barTypes, handType, party };
    window.lolInvData = () => lastInvData;   // débogage
    if (key === lastInv) return;          // on ne reconstruit la grille que si elle a changé
    lastInv = key;

    if (stackView) {
      // par piles : une case par type d'objet (la première où il se trouve), avec le nombre
      // d'exemplaires ; chaque objet garde sa propre case dans le sac du jeu
      const first = new Map(), count = new Map();
      barTypes.forEach((t, k) => { if (t < 0) return; if (!first.has(t)) first.set(t, k); count.set(t, (count.get(t) || 0) + 1); });
      invBar.replaceChildren(...[...first].map(([t, k]) => {
        const d = slot(t, count.get(t) > 1 ? `pile de ${count.get(t)}` : `case ${k + 1}`, k);
        if (count.get(t) > 1) { const n = document.createElement("span"); n.className = "cnt"; n.textContent = count.get(t); d.appendChild(n); }
        return d;
      }));
    } else invBar.replaceChildren(...barTypes.map((t, k) => slot(t, `case ${k + 1}`, k)));
    invCount.textContent = `${barTypes.filter((t) => t >= 0).length} / ${INV.barSlots} cases occupées`;
    if (window.lolActionBarRefresh) window.lolActionBarRefresh();
    if (window.lolEquipRefresh) window.lolEquipRefresh();
    document.getElementById("inv-mini-count").textContent = invCount.textContent;
    invHand.replaceChildren(slot(handType, "en main", LOC_HAND));
    document.querySelectorAll("#inv .slot.sel").forEach((e) => e.classList.remove("sel"));
    invChars.replaceChildren();
    if (MANAGE) {
      // l'équipement se change dans la fenêtre des personnages (liste des pièces possibles et écarts)
      const b = document.createElement("button"); b.type = "button"; b.id = "inv-equip-open"; b.textContent = "Équipement des personnages…";
      b.addEventListener("click", () => { document.getElementById("inv-dlg").close(); openStats(); });
      invChars.appendChild(b);
    }
    for (const c of MANAGE ? [] : party) {
      const b = document.createElement("div"); b.className = "inv-sub"; b.textContent = `${c.name} — équipement`;
      const row = document.createElement("div"); row.className = "inv-grid";
      row.append(...c.eq.map((t, k) => {
        const d = slot(t, `${c.name}, ${EQUIP_NAMES[k] || "emplacement " + (k + 1)}`, LOC_EQ(c.slot, k));
        if (!(c.usable >> k & 1)) { d.classList.add("nouse"); d.title = `${c.name} : emplacement absent pour sa race (utilisable seulement avec les triches)`; }
        return d;
      }));
      invChars.append(b, row);
    }
    // objet pris en main dans le jeu : sélectionné comme si on avait cliqué dessus ;
    // reposé : la fiche ouverte par la prise en main se ferme
    if (handType !== lastHand) {
      if (handType >= 0) showDetail(handType, "en main", invHand.firstChild, true);
      else if (fromHand) hideDetail();
    } else if (fromHand && handType >= 0) invHand.firstChild.classList.add("sel");
    lastHand = handType;
    sendHandTo3d(handType);
  }
  // Objet en main : la vue 3D le montre en curseur ; un clic dedans le lance (haut de la vue) ou le
  // pose (sol), comme un clic dans la vue du jeu (commande « hand », op 22)
  let lastHandSent = null;
  function sendHandTo3d(t) {
    const icon = t >= 0 && itemInfo && itemInfo[t] ? itemInfo[t].icon : -1;
    if (icon === lastHandSent || !frame3d || !frame3d.contentWindow) return;
    lastHandSent = icon;
    frame3d.contentWindow.postMessage({ type: "lol-hand", icon }, location.origin);
  }
  // clic droit dans la vue 3D avec un objet en main : rangé dans la première case libre du sac
  addEventListener("message", async (e) => {
    if (e.origin !== location.origin || !e.data || e.data.type !== "lol-handstore" || window.LOL_ENGINE !== "scummvm") return;
    const free = lastInvData ? lastInvData.barTypes.indexOf(-1) : -1;
    if (free < 0) { console.info("Ranger : le sac est plein."); return; }
    await mem.cmd({ op: "move", a: LOC_HAND, b: free }, 4000);
    lastInv = ""; setTimeout(() => updateInventory().catch(() => {}), 150);
  });
  // clic sur un objet au sol dans la vue 3D : pris en main (sac si la main est occupée ; « pickup », op 24)
  const PICK_ERR = { 1: "Trop loin : seulement sur la case du groupe ou celle de devant.", 2: "Un mur est devant.", 3: "L'objet n'est plus là.", 11: "Pas pendant un dialogue." };
  addEventListener("message", async (e) => {
    if (e.origin !== location.origin || !e.data || e.data.type !== "lol-pickup" || window.LOL_ENGINE !== "scummvm") return;
    const r = await mem.cmd({ op: "pickup", a: e.data.block | 0, b: e.data.itemType | 0 }, 4000);
    if (r && (r.code === 0 || r.code === 6)) { lastInv = ""; setTimeout(() => updateInventory().catch(() => {}), 150); }
    else console.info("Ramasser :", r ? PICK_ERR[r.code] || `refusé (code ${r.code})` : "le jeu ne répond pas");
  });
  addEventListener("message", async (e) => {
    if (e.origin !== location.origin || !e.data || e.data.type !== "lol-handclick" || window.LOL_ENGINE !== "scummvm") return;
    await mem.cmd({ op: "hand", a: e.data.mode | 0 }, 4000);
    lastInv = ""; setTimeout(() => updateInventory().catch(() => {}), 150);
  });

  // --- Gestion de l'inventaire (version ScummVM) ------------------------------------
  // Le moteur exécute les commandes avec ses propres fonctions (scripts des objets équipés,
  // recalcul des caractéristiques, affichage) : voir tools/scummvm_web.py. Avec DOSBox, écrire
  // directement en mémoire ne lancerait pas ces scripts : la gestion n'y est pas proposée.
  // Emplacements : 0..47 sac, 100 main, 200 + perso * 11 + emplacement d'équipement.
  const MANAGE = window.LOL_ENGINE === "scummvm";
  const LOC_HAND = 100, LOC_EQ = (c, k) => 200 + c * 11 + k;
  const hintEl = document.getElementById("inv-hint");
  if (MANAGE && hintEl) hintEl.textContent = "Glisser une case sur une autre pour déplacer ou échanger ; cliquer un objet pour d'autres actions.";
  const CMD_ERR = { 1: "Impossible : cet objet ne va pas à cet emplacement (ou la race du personnage ne l'a pas).", 2: "Le sac est plein.", 3: "Cet emplacement est vide." };
  function invMessage(t) {
    if (!hintEl) return;
    hintEl.textContent = t;
    clearTimeout(invMessage.t);
    invMessage.t = setTimeout(() => { hintEl.textContent = MANAGE ? "Glisser une case sur une autre pour déplacer ou échanger ; cliquer un objet pour d'autres actions." : ""; }, 4000);
  }
  // sans triches (Options) : équipement limité aux emplacements que la race du personnage a, comme le jeu
  const strictEquip = () => !!(window.lolCheatsShown && !window.lolCheatsShown());
  async function invCmd(c) {
    if (c.op === "move" && strictEquip()) c = { ...c, a: c.a | 0x4000 };
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
    // équiper : dans la fenêtre des personnages (pièces possibles, écarts de force et de protection)
    const allowed = (it.slots || []).filter((k) => k >= 0 && k < INV.equipSlots);
    const who = lastInvData && allowed.length ? lastInvData.party.find((p) => !strictEquip() || allowed.some((k) => p.usable >> k & 1)) : null;
    if (who) {
      const k = allowed.find((x) => !strictEquip() || who.usable >> x & 1);
      btn("Équiper…", "Choisir le personnage et comparer, dans la fenêtre des personnages", () => { document.getElementById("inv-dlg").close(); openStats(k, who.slot); });
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
  // Sorts de joueur (types 0 à 6, connus ou non : zone 0x7F000480, 7 × 46 octets) : ceux qui
  // manquent peuvent être débloqués (commande « learn » = addSpellToScroll, comme les scripts).
  const SPELLS = 0x7F000300, ALL_SPELLS = 0x7F000480, HEAL = 1;
  const spLearn = document.getElementById("sp-learn");
  const spellsEl = document.getElementById("spells"), spList = document.getElementById("sp-list");
  const spCaster = document.getElementById("sp-caster"), spTarget = document.getElementById("sp-target");
  const spTargetL = document.getElementById("sp-target-l"), spMsg = document.getElementById("sp-msg");
  const CP850 = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»";
  const cp850 = (bytes) => Array.from(bytes, (b) => b < 128 ? String.fromCharCode(b) : CP850[b - 128] || "?").join("");
  let spellKey = "", spellParty = [], knownSpells = [];
  const SPELL_ERR = { 1: "Impossible maintenant : personnage occupé ou inconscient, menu de magie ouvert, ou sort inconnu.",
    4: "Pas assez de magie (ou de vie) pour ce niveau.", 5: "Le sort ne peut pas partir d'ici (mur juste devant ?)." };
  function fillSelect(sel, party, keep) {
    const v = sel.value;
    sel.replaceChildren(...party.map((c) => { const o = document.createElement("option"); o.value = c.slot; o.textContent = c.name; return o; }));
    if (keep && party.some((c) => String(c.slot) === v)) sel.value = v;
  }
  async function updateSpells() {
    if (!MANAGE || previewing) return;
    const r = await mem.read([[SPELLS, 7 * 48], PARTY_RANGE(), [ALL_SPELLS, 7 * 46]]);
    if (!r) return;
    const spells = [];
    for (let i = 0; i < 7; i++) {
      const b = r[0].subarray(i * 48, i * 48 + 48);
      if (b[0] === 0xFF) continue;
      const w = (k) => b[k] | b[k + 1] << 8;
      const raw = b.subarray(18, 48), z = raw.indexOf(0), name = cp850(z < 0 ? raw : raw.subarray(0, z)).trim();
      spells.push({ type: b[0], name, mp: [w(2), w(4), w(6), w(8)], hp: [w(10), w(12), w(14), w(16)] });
    }
    const known = new Set(spells.map((s) => s.type)), missing = [];
    for (let t = 0; t < 7; t++) {
      const b = r[2].subarray(t * 46, t * 46 + 46), raw = b.subarray(16, 46), z = raw.indexOf(0);
      const name = cp850(z < 0 ? raw : raw.subarray(0, z)).trim();
      if (name) missing.push({ type: t, name, known: known.has(t) });
    }
    const party = partyChars(r[1]).map((c) => {
      const u16 = (k) => c.at(k) | c.at(k + 1) << 8, s16 = (k) => (u16(k) << 16) >> 16;
      return { slot: c.slot, name: c.name, hp: s16(55), mp: s16(59) };
    });
    const key = JSON.stringify([spells, party, missing]);
    if (key === spellKey) return;
    spellKey = key;
    spellsEl.hidden = !party.length;
    if (JSON.stringify(party.map((c) => c.slot)) !== JSON.stringify(spellParty.map((c) => c.slot))) {
      fillSelect(spCaster, party, true);
      fillSelect(spTarget, party, true);
    }
    spellParty = party;
    spTargetL.hidden = !spells.some((s) => s.type === HEAL);
    knownSpells = spells;
    renderSpells(spells);
    renderAutoCfg(spells, party);
    renderLearn(missing);
  }
  // Attaque auto : arme ou sort offensif de chaque personnage (sort lancé par le moteur au plus haut
  // niveau que sa magie et sa vie permettent, sur un monstre jusqu'à 3 cases devant ; sinon l'arme).
  // Choix mémorisé par nom de personnage, renvoyé au moteur à chaque changement et toutes les 3 s.
  const OFFENSIVE = new Set([0, 2, 3, 4, 5, 6]);       // Étincelle, Gel, Boule de feu, Poing mortel, Brume fatale, Foudre
  const autoCfg = document.getElementById("auto-cfg");
  let autoParty = [], autoKey = "", autoSentAt = 0;
  const autoChoice = (name) => { try { const v = localStorage.getItem("autoSpell:" + name); return v === null ? -1 : +v; } catch (e) { return -1; } };
  function renderAutoCfg(spells, party) {
    autoParty = party;
    const offensive = spells.filter((s) => OFFENSIVE.has(s.type));
    const key = JSON.stringify([offensive.map((s) => [s.type, s.name]), party.map((c) => [c.slot, c.name])]);
    if (key === autoKey) return;
    autoKey = key;
    autoCfg.replaceChildren(Object.assign(document.createElement("span"), { className: "h", textContent: "Attaque auto de chaque personnage" }),
      ...party.flatMap((c) => {
        const n = document.createElement("span"); n.textContent = c.name;
        const sel = document.createElement("select");
        sel.title = "Arme, ou sort lancé au plus haut niveau possible (l'arme quand la magie manque)";
        for (const [v, t] of [[-1, "Arme"], ...offensive.map((s) => [s.type, `${s.name} (niveau max)`])]) {
          const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o);
        }
        const cur = autoChoice(c.name);
        sel.value = offensive.some((s) => s.type === cur) ? cur : -1;
        sel.addEventListener("change", () => {
          try { localStorage.setItem("autoSpell:" + c.name, sel.value); } catch (e) {}
          sel.blur(); sendAutoSpells(true).catch(() => {});
        });
        return [n, sel];
      }));
    sendAutoSpells(true).catch(() => {});
  }
  async function sendAutoSpells(force) {
    if (!MANAGE || (!force && performance.now() - autoSentAt < 3000)) return;
    autoSentAt = performance.now();
    for (const c of autoParty) await mem.cmd({ op: "autospell", a: c.slot, b: autoChoice(c.name) }, 1500);
  }
  if (MANAGE) setInterval(() => {
    autoCfg.hidden = !document.getElementById("cheat-auto").checked || !autoParty.length;
    sendAutoSpells(false).catch(() => {});
  }, 1000);

  // fenêtre « Débloquer » : les 7 sorts du joueur, connus ou à apprendre
  function renderLearn(all) {
    const mk = (label, title, types, cls) => {
      const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.title = title;
      if (cls) b.className = cls;
      b.addEventListener("click", () => { b.blur(); learn(types).catch(() => {}); });
      return b;
    };
    const todo = all.filter((s) => !s.known);
    spLearn.replaceChildren(...all.map((s) => {
      const row = document.createElement("div"); row.className = "ch-row";
      const n = document.createElement("span"); n.className = "ch-n"; n.textContent = s.name;
      const st = document.createElement("span"); st.className = "ch-st"; st.textContent = s.known ? "✓ connu" : "";
      const b = mk("Apprendre", `Apprendre ${s.name} (ajouté au parchemin des sorts, comme dans le jeu)`, [s.type]);
      b.disabled = s.known;
      row.append(n, st, b);
      return row;
    }), ...(todo.length > 1 ? [mk("Tout apprendre", "Apprendre tous les sorts manquants", todo.map((s) => s.type), "all")] : []));
  }
  async function learn(types) {
    let ok = 0, last = null;
    const spMsg = document.getElementById("ch-msg");
    for (const t of types) {
      spMsg.textContent = `Apprentissage… (${ok + 1} / ${types.length}, animation du jeu)`;
      last = await mem.cmd({ op: "learn", a: t, b: +spCaster.value }, 20000);
      if (!last || last.code) break;
      ok++;
    }
    spMsg.textContent = !last ? "Le jeu ne répond pas (menu ou dialogue ouvert ?) : réessaie en exploration."
      : last.code === 6 ? "Ce sort est déjà connu." : last.code ? "Impossible maintenant (menu de magie ouvert ?)."
      : ok > 1 ? `${ok} sorts débloqués.` : "Sort débloqué.";
    spellKey = "";
    setTimeout(() => updateSpells().catch(() => {}), 300);
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
        // glisser vers la barre d'actions : ce sort, ce niveau, ce lanceur
        b.draggable = true;
        b.addEventListener("dragstart", (e) => {
          e.dataTransfer.effectAllowed = "copy";
          e.dataTransfer.setData("application/x-lol-action", JSON.stringify({ k: "spell", s: s.type, l, c: +spCaster.value, n: s.name }));
        });
        row.appendChild(b);
      }
      return row;
    }));
    // attaques des personnages, à glisser dans la barre d'actions
    const atk = document.getElementById("sp-atk");
    if (atk) {
      atk.replaceChildren(Object.assign(document.createElement("span"), { textContent: "Attaques :" }), ...spellParty.map((c) => {
        const chip = document.createElement("span"); chip.className = "chip"; chip.textContent = "⚔ " + c.name; chip.draggable = true;
        chip.title = `Glisser dans la barre d'actions : attaque de ${c.name}`;
        chip.addEventListener("dragstart", (e) => { e.dataTransfer.effectAllowed = "copy"; e.dataTransfer.setData("application/x-lol-action", JSON.stringify({ k: "atk", c: c.slot })); });
        return chip;
      }));
      atk.title = "Glisser un niveau de sort ou une attaque sur une case de la barre d'actions";
    }
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

  // --- Volumes du jeu : musique, effets, voix (version ScummVM) -------------------------
  // Le moteur publie les trois volumes (zone 0x7F000600 : 2 = coupé … 102, échelle du menu
  // « Contrôles audio » du jeu) ; la commande « volume » les règle comme ce menu (setVolume,
  // enregistré dans scummvm.ini). Voix à 0 : texte seul, comme dans le jeu.
  if (MANAGE) {
    const VOLS = 0x7F000600, moreBtn = document.getElementById("vol-more"), mix = document.getElementById("vol-mix");
    const rows = ["Musique", "Effets", "Voix"].map((label, k) => {
      const l = document.createElement("label"), t = document.createElement("span"), r = document.createElement("input"), o = document.createElement("output");
      t.textContent = label; r.type = "range"; r.min = 0; r.max = 100; r.step = 1; o.textContent = "…";
      l.append(t, r, o); mix.appendChild(l);
      let timer = 0, dragging = false;
      const show = () => { o.textContent = +r.value === 0 ? "coupé" : r.value + " %"; };
      r.addEventListener("pointerdown", () => { dragging = true; });
      r.addEventListener("input", () => {
        show(); dragging = true; clearTimeout(timer);
        timer = setTimeout(() => mem.cmd({ op: "volume", a: k, b: +r.value + 2 }).catch(() => {}), 120);
      });
      r.addEventListener("change", () => { setTimeout(() => { dragging = false; }, 600); r.blur(); });
      for (const ev of ["keydown", "keyup"]) r.addEventListener(ev, (e) => e.stopPropagation());
      return { r, show, busy: () => dragging };
    });
    moreBtn.hidden = false;
    moreBtn.addEventListener("click", (e) => {
      e.currentTarget.blur(); mix.hidden = !mix.hidden; moreBtn.classList.toggle("on", !mix.hidden);
      if (!mix.hidden) readVols();
    });
    document.addEventListener("pointerdown", (e) => { if (!mix.hidden && !e.target.closest("#vol")) { mix.hidden = true; moreBtn.classList.remove("on"); } });
    async function readVols() {
      const r = await mem.read([[VOLS, 3]]);
      if (!r) return;
      rows.forEach((row, k) => { if (!row.busy()) { row.r.value = Math.max(0, Math.min(100, r[0][k] - 2)); row.show(); } });
    }
    setInterval(() => { if (!mix.hidden) readVols().catch(() => {}); }, 1000);
  }


  // --- Fenêtre « Débloquer » : atlas, livre de sorts, boussole, sorts (version ScummVM) -------------------------
  // Atlas, livre de sorts et boussole : drapeaux de _flagsTable[31] (0x10 atlas = carte automatique,
  // 0x20 livre de sorts = parchemin, 0x40 boussole),
  // lus dans les drapeaux publiés (0x3E55C + 31) ; commande « unlock » (masque), puis le jeu
  // redessine son terrain de jeu. Les sorts : renderLearn / learn (section Magie).
  if (MANAGE) {
    const chDlg = document.getElementById("ch-dlg"), chMsg = document.getElementById("ch-msg");
    const chOpen = document.getElementById("ch-open");
    chOpen.hidden = false;
    const ITEMS_UNLOCK = [["ch-atlas", 0x10, "Atlas"], ["ch-book", 0x20, "Livre de sorts"], ["ch-compass", 0x40, "Boussole"]];
    async function readUnlocks() {
      const r = await mem.read([[FLAGS + 31, 1]]);
      if (!r) return;
      for (const [id, bit] of ITEMS_UNLOCK) {
        const on = !!(r[0][0] & bit);
        document.getElementById(id + "-st").textContent = on ? "✓ débloqué" : "";
        document.getElementById(id).disabled = on;
      }
    }
    for (const [id, bit, label] of ITEMS_UNLOCK) document.getElementById(id).addEventListener("click", async (e) => {
      e.currentTarget.blur();
      const r = await mem.cmd({ op: "unlock", a: bit }, 5000);
      chMsg.textContent = !r ? "Le jeu ne répond pas (menu ou dialogue ouvert ?) : réessaie en exploration."
        : r.code ? "Impossible maintenant (dialogue ou scène en cours)." : `${label} débloqué${label === "Boussole" ? "e" : ""}.`;
      setTimeout(() => readUnlocks().catch(() => {}), 400);
    });
    chOpen.addEventListener("click", (e) => {
      e.currentTarget.blur(); chMsg.textContent = ""; chDlg.showModal();
      readUnlocks().catch(() => {}); spellKey = ""; updateSpells().catch(() => {});
    });
    setInterval(() => { if (chDlg.open) readUnlocks().catch(() => {}); }, 1000);
    document.getElementById("ch-close").addEventListener("click", () => chDlg.close());
    chDlg.addEventListener("click", (e) => { if (e.target === chDlg) chDlg.close(); });
    chDlg.addEventListener("close", () => { const f = document.getElementById("dos"); if (f && f.focus) f.focus(); });
    for (const ev of ["keydown", "keyup", "keypress"]) chDlg.addEventListener(ev, (e) => e.stopPropagation());
  }

  // --- Sauvegardes : sauvegarder et charger (version ScummVM) -------------------------------
  // « listsaves » : le moteur relit les fichiers lol-fr.### et publie n° + nom (zone 0x7F000700 :
  // nombre u16, puis 42 octets par sauvegarde ; noms en UTF-8, comme les enregistre le jeu).
  // « load » : comme le menu « Charger une partie » (_gameToLoad, chargé au tour de boucle suivant).
  // « save » : comme le menu « Sauvegarder » (saveGameStateIntern, miniature générée par le moteur) ;
  // a = emplacement (-1 : premier libre), nom passé en texte avec la commande.
  if (MANAGE) {
    const SAVES = 0x7F000700, svDlg = document.getElementById("sv-dlg"), svList = document.getElementById("sv-list");
    const svMsg = document.getElementById("sv-msg"), svOpen = document.getElementById("sv-open");
    const svName = document.getElementById("sv-name"), utf8 = new TextDecoder();
    svOpen.hidden = false;
    const defaultName = () => {
      const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
      return `${current ? current.fr : "Partie"} ${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${p2(d.getHours())}h${p2(d.getMinutes())}`.slice(0, 36);
    };
    async function readSaves() {
      await new Promise((r) => setTimeout(r, 400));             // publication suivante
      const r = await mem.read([[SAVES, 2 + 200 * 42]]);
      if (!r) return null;
      const b = r[0], n = b[0] | b[1] << 8;
      if (n === 0xFFFF) return null;
      const saves = [];
      for (let i = 0; i < n; i++) {
        const o = 2 + i * 42, raw = b.subarray(o + 2, o + 42), z = raw.indexOf(0);
        saves.push({ slot: b[o] | b[o + 1] << 8, name: utf8.decode(z < 0 ? raw : raw.subarray(0, z)).trim() });
      }
      return saves;
    }
    // Avant le début de la partie (introduction, menu principal), le moteur n'exécute pas les
    // commandes : la liste est lue dans les fichiers de sauvegarde (IndexedDB d'Emscripten,
    // /home/web_user/saves/lol-fr.###, en-tête « WWSV », id du jeu u8, version u32, nom en UTF-8
    // terminé par 0), et « Charger » relance le jeu sur la sauvegarde (save_slot, lol-game.html).
    const gameStarted = () => { try { const w = document.getElementById("dos").contentWindow; return !!(w.lolStarted && w.lolStarted()); } catch (e) { return false; } };
    function readSaveFiles() {
      return new Promise((ok) => {
        let req;
        try { req = indexedDB.open("/home/web_user"); } catch (e) { return ok(null); }
        req.onupgradeneeded = () => req.transaction.abort();      // base absente : aucune sauvegarde
        req.onerror = () => ok([]);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("FILE_DATA")) { db.close(); return ok([]); }
          const st = db.transaction("FILE_DATA").objectStore("FILE_DATA"), out = [];
          const all = st.openCursor();
          all.onsuccess = () => {
            const c = all.result;
            if (!c) { db.close(); return ok(out.sort((a, b) => a.slot - b.slot)); }
            const m = /^\/home\/web_user\/saves\/lol-fr\.(\d{3})$/.exec(c.key), b = c.value && c.value.contents;
            if (m && b && b.length > 9 && b[0] === 0x57 && b[1] === 0x57 && b[2] === 0x53 && b[3] === 0x56) {
              const z = b.indexOf(0, 9);
              out.push({ slot: +m[1], name: utf8.decode(b.subarray(9, z < 0 ? Math.min(b.length, 90) : z)).trim() });
            }
            c.continue();
          };
          all.onerror = () => { db.close(); ok(null); };
        };
      });
    }
    function loadAtStart(s) {
      try { sessionStorage.setItem("lol-load-slot", String(s.slot)); } catch (e) { svMsg.textContent = "Impossible de relancer le jeu."; return; }
      svMsg.textContent = `Lancement de la partie « ${s.name} »…`;
      setTimeout(() => { svDlg.close(); document.getElementById("dos").contentWindow.location.reload(); }, 400);
    }
    const resetConfirms = () => svList.querySelectorAll("button.confirm").forEach((x) => { x.classList.remove("confirm"); x.textContent = x.dataset.label; });
    const twoStep = (btn) => {                         // deuxième clic pour confirmer
      if (btn.classList.contains("confirm")) return true;
      resetConfirms(); btn.classList.add("confirm"); btn.textContent = "Confirmer"; return false;
    };
    function renderSaves(saves) {
      svList.replaceChildren(...saves.map((s) => {
        const li = document.createElement("li");
        const no = document.createElement("span"); no.className = "no"; no.textContent = s.slot;
        const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = s.name || "(sans nom)"; nm.title = s.name;
        const ow = document.createElement("button"); ow.type = "button"; ow.className = "ow"; ow.dataset.label = ow.textContent = "Écraser";
        ow.title = "Remplacer cette sauvegarde par la partie en cours (nom : celui du champ, sinon le sien)";
        ow.addEventListener("click", () => { if (twoStep(ow)) save(s.slot, svName.value.trim() || s.name).catch(() => {}); });
        ow.hidden = !gameStarted();
        const go = document.createElement("button"); go.type = "button"; go.dataset.label = go.textContent = "Charger";
        go.title = "Charger cette sauvegarde (la partie en cours non sauvegardée est perdue)";
        go.addEventListener("click", async () => {
          if (!gameStarted()) { loadAtStart(s); return; }   // introduction, menu principal : pas besoin de confirmer
          if (!twoStep(go)) return;
          const res = await mem.cmd({ op: "load", a: s.slot }, 5000);
          if (!res || res.code) { svMsg.textContent = !res ? "Le jeu ne répond pas (menu ou dialogue ouvert ?)." : "Sauvegarde illisible."; return; }
          svMsg.textContent = `Chargement de « ${s.name} »…`;
          setTimeout(() => svDlg.close(), 600);
        });
        li.append(no, nm, ow, go);
        return li;
      }));
      svMsg.textContent = saves.length ? `${saves.length} sauvegarde${saves.length > 1 ? "s" : ""}.` : "Aucune sauvegarde pour l'instant.";
    }
    async function listSaves() {
      svMsg.textContent = "Lecture des sauvegardes…";
      document.getElementById("sv-save").disabled = svName.disabled = !gameStarted();
      if (!gameStarted()) {
        const files = await readSaveFiles();
        if (!files) { svMsg.textContent = "Sauvegardes illisibles dans ce navigateur."; return; }
        renderSaves(files);
        svMsg.textContent += " La partie n'est pas encore lancée : « Charger » la démarre sur la sauvegarde.";
        return;
      }
      const c = await mem.cmd({ op: "listsaves" }, 8000);
      if (!c || c.code) { svMsg.textContent = "Le jeu ne répond pas (menu ou dialogue ouvert ?) : réessaie en exploration."; return; }
      const saves = await readSaves();
      if (!saves) { svMsg.textContent = "Liste pas encore prête : clique sur ↻."; return; }
      renderSaves(saves);
    }
    async function save(slot, name) {
      svMsg.textContent = "Sauvegarde…";
      const r = await mem.cmd({ op: "save", a: slot, b: 0, text: name || defaultName() }, 10000);
      if (!r || r.code) { svMsg.textContent = !r ? "Le jeu ne répond pas (menu ou dialogue ouvert ?) : réessaie en exploration." : "La sauvegarde a échoué."; return; }
      const saves = await readSaves();
      if (saves) renderSaves(saves);
      svMsg.textContent = `Partie sauvegardée${slot >= 0 ? ` dans l'emplacement ${slot}` : ""} : « ${name || "…"} ».`;
      svName.value = defaultName();
    }
    document.getElementById("sv-save").addEventListener("click", (e) => { e.currentTarget.blur(); save(-1, svName.value.trim() || defaultName()).catch(() => {}); });
    svName.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(-1, svName.value.trim() || defaultName()).catch(() => {}); } });
    svOpen.addEventListener("click", (e) => { e.currentTarget.blur(); svName.value = defaultName(); svDlg.showModal(); listSaves().catch(() => {}); });
    document.getElementById("sv-refresh").addEventListener("click", (e) => { e.currentTarget.blur(); listSaves().catch(() => {}); });
    document.getElementById("sv-close").addEventListener("click", () => svDlg.close());
    svDlg.addEventListener("click", (e) => { if (e.target === svDlg) svDlg.close(); });
    svDlg.addEventListener("close", () => { const f = document.getElementById("dos"); if (f && f.focus) f.focus(); });
    for (const ev of ["keydown", "keyup", "keypress"]) svDlg.addEventListener(ev, (e) => e.stopPropagation());
  }

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
      const icon = document.createElement("div"); icon.className = "slot full"; setIcon(icon, it.icon); icon.title = "Fiche de l'objet"; icon.dataset.type = t;
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

  // --- Vider le sac (version ScummVM) : chaque case occupée est détruite par la commande
  // « delete » du moteur (comme « Supprimer » dans la fiche d'un objet : deleteItem). Deuxième clic
  // pour confirmer ; l'équipement des personnages et l'objet en main ne sont pas touchés.
  {
    const clearBtn = document.getElementById("inv-clear");
    clearBtn.hidden = !MANAGE;
    let clearTimer = 0, clearing = false;
    clearBtn.addEventListener("click", async () => {
      clearBtn.blur();
      if (clearing) return;
      const locs = lastInvData ? lastInvData.barTypes.map((t, k) => (t >= 0 ? k : -1)).filter((k) => k >= 0) : [];
      if (!locs.length) { invMessage("Le sac est déjà vide."); return; }
      if (!clearBtn.classList.contains("confirm")) {
        clearBtn.classList.add("confirm"); clearBtn.textContent = `Vider ${locs.length} objet${locs.length > 1 ? "s" : ""} ?`;
        clearTimeout(clearTimer); clearTimer = setTimeout(() => { clearBtn.classList.remove("confirm"); clearBtn.textContent = "Vider"; }, 4000);
        return;
      }
      clearTimeout(clearTimer); clearBtn.classList.remove("confirm"); clearBtn.textContent = "Vider";
      clearing = true; hideDetail();
      let done = 0;
      try {
        for (const loc of locs) {
          const r = await mem.cmd({ op: "delete", a: loc });
          if (!r) { invMessage("Le jeu ne répond pas (menu ouvert ?) : réessaie en exploration."); break; }
          if (!r.code) done++;
        }
      } finally { clearing = false; }
      if (done) invMessage(`${done} objet${done > 1 ? "s" : ""} détruit${done > 1 ? "s" : ""}.`);
      lastInv = ""; updateInventory().catch(() => {});
    });
  }

  // --- Fenêtre « Inventaire et équipement » (bouton « Gérer… » ou touche B, réglable) -------------
  const invKey = () => { try { const c = LoLKeys.codeOf("inv"); return c ? LoLKeys.keyName(c) : ""; } catch (e) { return "B"; } };
  const invTitles = () => {
    const k = invKey(), o = document.getElementById("inv-open"), x = document.getElementById("inv-close");
    if (o) o.title = "Gérer le sac et l'équipement" + (k ? ` (touche ${k})` : "");
    if (x) x.title = "Fermer (Échap" + (k ? `, ${k}` : "") + ")";
  };
  invTitles();
  if (window.LoLKeys) LoLKeys.onChange(invTitles);
  {
    const invDlg = document.getElementById("inv-dlg");
    const openInv = () => { if (!invDlg.open && !document.querySelector("dialog[open]")) { lastInv = ""; invDlg.showModal(); updateInventory().catch(() => {}); } };
    document.getElementById("inv-open").addEventListener("click", (e) => { e.currentTarget.blur(); openInv(); });
    document.getElementById("inv-close").addEventListener("click", () => invDlg.close());
    invDlg.addEventListener("click", (e) => { if (e.target === invDlg) invDlg.close(); });
    invDlg.addEventListener("close", () => { hideDetail(); const f = document.getElementById("dos"); if (f && f.focus) f.focus(); });
    for (const ev of ["keyup", "keypress"]) invDlg.addEventListener(ev, (e) => e.stopPropagation());
    invDlg.addEventListener("keydown", (e) => {
      e.stopPropagation();
      const t = e.target;
      if (LoLKeys.is(e, "inv") && !(t && (t.tagName === "INPUT" || t.tagName === "SELECT"))) { e.preventDefault(); invDlg.close(); }
    });
    // touche de l'inventaire : depuis la page ou depuis le jeu (cadre ScummVM), hors saisie
    const onI = (e) => {
      if (!LoLKeys.is(e, "inv")) return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault(); e.stopImmediatePropagation(); openInv();
    };
    addEventListener("keydown", onI, true);
    const hook = () => { const f = document.querySelector("iframe#dos"); try { if (f && f.contentWindow) f.contentWindow.addEventListener("keydown", onI, true); } catch (e) {} };
    hook();
    { const f = document.querySelector("iframe#dos"); if (f) f.addEventListener("load", hook); }
  }

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
    return monsters.map((m) => ({ case: `${Math.floor(m.x)},${Math.floor(m.y)}`, dir: m.dir, type: m.type, pv: m.hpMax ? `${m.hp}/${m.hpMax}` : m.hp, variant: m.variant, equip: m.equip.filter(Boolean).join(","),
      sprite: L && L.spriteOf ? L.spriteOf[m.type] || "(aucun : type inconnu du niveau)" : "(en cours)",
      possibles: L ? (L.monsterTypes[m.type] || []).join("/") : "" }));
  }
  // --- Caractéristiques --------------------------------------------------------
  // Panneau : résumé (vie, magie) ; fiches complètes dans une fenêtre modale (bouton « Fiches… »
  // ou clic sur le résumé), avec la triche de montée de niveau.
  const stMoney = document.getElementById("st-money"), stChars = document.getElementById("st-chars");
  const stMini = document.getElementById("st-mini"), stMoney2 = document.getElementById("st-money2");
  const stDlg = document.getElementById("st-dlg");
  let lastStats = "";
  // --- Équipement dans la fenêtre des personnages (version ScummVM) ----------------------------
  // Emplacements de chaque personnage (sans triches : seulement ceux de sa race) ; clic : pièces qui
  // peuvent y aller (sac, main, portées par un autre, avec son portrait), écarts de force et de
  // protection avec la pièce en place (vert : mieux, rouge : moins bien). Clic sur une pièce : équipée
  // (commande « move » ; pièce d'un autre personnage qui ne peut pas reprendre la pièce en place :
  // celle-ci passe d'abord par le sac). « Retirer » : pièce en place rangée dans le sac.
  if (MANAGE) {
    const eqBox = document.getElementById("st-equip"), eqRows = document.getElementById("st-eq-rows"), eqCand = document.getElementById("st-eq-cand");
    let pick = null, eqMsg = "";
    const faceMini = (id) => { const f = document.createElement("span"); f.className = "face-mini"; f.style.backgroundPosition = `0 -${(Math.min(9, Math.max(1, id)) - 1) * 24}px`; return f; };
    const fitsSlot = (t, k) => t >= 0 && itemInfo && itemInfo[t] && (itemInfo[t].slots || []).includes(k);
    const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const slotName = (k) => EQUIP_NAMES[k] || `emplacement ${k + 1}`;
    function renderEquip() {
      if (!stDlg.open || !lastInvData || !itemInfo) return;
      const party = lastInvData.party;
      eqBox.hidden = !party.length;
      if (pick && !party.some((p) => p.slot === pick.c)) pick = null;
      eqRows.replaceChildren(...party.map((c) => {
        const row = mk("div", "eq-row"), who = mk("span", "who");
        who.append(faceMini(c.id), mk("span", null, c.name));
        row.appendChild(who);
        for (let k = 0; k < INV.equipSlots; k++) {
          if (strictEquip() && !(c.usable >> k & 1)) continue;          // emplacement absent pour sa race
          const t = c.eq[k], d = mk("div", "slot");
          if (t >= 0) { d.classList.add("full"); setIcon(d, (itemInfo[t] || {}).icon ?? -1); d.dataset.type = t; }
          else slotPlaceholder(d, LOC_EQ(c.slot, k));
          d.title = `${c.name}, ${slotName(k)}`;
          if (pick && pick.c === c.slot && pick.k === k) d.classList.add("on");
          d.addEventListener("click", () => { pick = pick && pick.c === c.slot && pick.k === k ? null : { c: c.slot, k }; eqMsg = ""; renderEquip(); });
          row.appendChild(d);
        }
        return row;
      }));
      renderCand();
    }
    function diffs(t, cur) {
      const a = itemInfo[t] || {}, b = cur >= 0 ? itemInfo[cur] || {} : {};
      const out = [];
      for (const [key, label] of [["might", "Force"], ["prot", "Protection"]]) {
        const d = (a[key] || 0) - (b[key] || 0);
        if (d) out.push([`${label} ${d > 0 ? "+" : "−"}${Math.abs(d)}`, d > 0 ? "up" : "down"]);
      }
      if (!out.length) out.push(["Force et protection inchangées", "eq0"]);
      return out;
    }
    function renderCand() {
      if (!pick || !lastInvData) { eqCand.hidden = true; return; }
      const party = lastInvData.party, me = party.find((p) => p.slot === pick.c);
      const dst = LOC_EQ(pick.c, pick.k), cur = me.eq[pick.k];
      const list = [];
      const bag = new Map();
      lastInvData.barTypes.forEach((t, loc) => { if (fitsSlot(t, pick.k)) { const e = bag.get(t); if (e) e.n++; else bag.set(t, { loc, n: 1 }); } });
      for (const [t, e] of bag) list.push({ t, loc: e.loc, src: e.n > 1 ? `sac (×${e.n})` : "sac" });
      if (fitsSlot(lastInvData.handType, pick.k)) list.push({ t: lastInvData.handType, loc: LOC_HAND, src: "en main" });
      for (const p of party) p.eq.forEach((t, k) => {
        if ((p.slot === pick.c && k === pick.k) || !fitsSlot(t, pick.k)) return;
        list.push({ t, loc: LOC_EQ(p.slot, k), who: p, src: `${p.name}, ${slotName(k)}` });
      });
      eqCand.replaceChildren(mk("div", "ch", `${me.name}, ${slotName(pick.k)} : ` + (cur >= 0 ? `porte « ${(itemInfo[cur] || {}).name} »` : "vide")));
      if (cur >= 0) {
        const r = mk("div", "cand"), ic = mk("div", "slot"), src = mk("span", "src", "vers le sac");
        r.append(ic, mk("span", "n", "Retirer"), src, mk("span", "d eq0", `ranger « ${(itemInfo[cur] || {}).name} » dans le sac`));
        r.addEventListener("click", () => equip(dst, -1));
        eqCand.appendChild(r);
      }
      if (!list.length) eqCand.appendChild(mk("div", "none", "Aucune autre pièce ne peut aller à cet emplacement."));
      for (const c of list) {
        const it = itemInfo[c.t] || { name: `objet ${c.t}` };
        const r = mk("div", "cand"), ic = mk("div", "slot full"); setIcon(ic, it.icon ?? -1); ic.dataset.type = c.t;
        const src = mk("span", "src"); if (c.who) src.appendChild(faceMini(c.who.id)); src.appendChild(mk("span", null, c.src));
        const d = mk("span", "d");
        for (const [text, cls] of diffs(c.t, cur)) { if (d.childNodes.length) d.appendChild(document.createTextNode(" · ")); d.appendChild(mk("span", cls, text)); }
        const fx = (it.effects || []).filter((x) => !/^(Force|Protection) [+−-]/.test(x));
        if (fx.length) d.appendChild(mk("span", "eq0", " · " + fx.join(" · ")));
        r.append(ic, mk("span", "n", it.name), src, d);
        r.addEventListener("click", () => equip(c.loc, dst));
        eqCand.appendChild(r);
      }
      if (eqMsg) eqCand.appendChild(mk("div", "msg", eqMsg));
      eqCand.hidden = false;
    }
    const move = (a, b) => mem.cmd({ op: "move", a: a | (strictEquip() ? 0x4000 : 0), b }, 5000);
    async function equip(src, dst) {
      eqMsg = "";
      let r;
      if (dst < 0) {                                        // retirer : pièce en place -> sac
        const free = lastInvData.barTypes.indexOf(-1);
        r = free < 0 ? { code: 2 } : await move(src, free);
      } else {
        r = await move(src, dst);
        if (r && r.code === 1 && src >= 200) {              // l'autre personnage ne peut pas reprendre la pièce en place
          const free = lastInvData.barTypes.indexOf(-1);
          if (free >= 0 && (await move(dst, free) || {}).code === 0) r = await move(src, dst);
        }
      }
      eqMsg = !r ? "Le jeu ne répond pas (menu ouvert ?)." : r.code === 2 ? "Le sac est plein." : r.code ? "Impossible : la pièce ne va pas là (ou la race du personnage ne le permet pas)." : "";
      lastInv = ""; await updateInventory().catch(() => {}); renderEquip();
      lastStats = ""; updateStats().catch(() => {});
    }
    window.lolEquipRefresh = renderEquip;
    window.lolEquipPick = (c, k) => { pick = { c, k }; eqMsg = ""; renderEquip(); };
    stDlg.addEventListener("close", () => { pick = null; eqCand.hidden = true; });
  }
  const openStats = (eqSlot, eqChar) => {
    lastStats = ""; stDlg.showModal(); updateStats().catch(() => {}); updateParty(true).catch(() => {});
    if (MANAGE) { lastInv = ""; updateInventory().catch(() => {}); if (eqSlot !== undefined && typeof eqChar === "number") setTimeout(() => window.lolEquipPick && window.lolEquipPick(eqChar, eqSlot), 400); }
  };
  document.getElementById("st-open").addEventListener("click", (e) => { e.currentTarget.blur(); openStats(); });
  stMini.addEventListener("click", openStats);
  document.getElementById("st-close").addEventListener("click", () => stDlg.close());
  stDlg.addEventListener("click", (e) => { if (e.target === stDlg) stDlg.close(); });
  stDlg.addEventListener("close", () => { const f = document.getElementById("dos"); if (f && f.focus) f.focus(); });
  for (const ev of ["keydown", "keyup", "keypress"]) stDlg.addEventListener(ev, (e) => e.stopPropagation());
  // Compagnons (version ScummVM) : places 2 et 3 du groupe, au choix parmi les personnages prédéfinis
  // du jeu (zone 0x7F000800 : nombre, puis id i16 + nom 11 octets + race/classe/sexe) ; commande
  // « setchar » (comme addCharacter ; 0 = place vidée, objets du partant mis dans le sac).
  const stParty = document.getElementById("st-party"), stPartyMsg = document.getElementById("st-party-msg");
  const slotSel = [document.getElementById("st-slot1"), document.getElementById("st-slot2")];
  let roster = [], partyKey = "";
  async function updateParty(force) {
    if (!MANAGE || !stDlg.open) return;
    const r = await mem.read([[0x7F000800, 1 + 20 * 14], PARTY_RANGE()]);
    if (!r) return;
    const b = r[0], n = b[0];
    roster = [];
    for (let i = 0; i < n; i++) {
      const o = 1 + i * 14, raw = b.subarray(o + 2, o + 13), z = raw.indexOf(0);
      roster.push({ id: ((b[o] | b[o + 1] << 8) << 16) >> 16, name: cp850(z < 0 ? raw : raw.subarray(0, z)).trim() });
    }
    const party = partyChars(r[1]);
    const key = JSON.stringify([roster, party.map((c) => [c.slot, c.name])]);
    if (key === partyKey && !force) return;
    partyKey = key;
    stParty.hidden = !roster.length || !party.length;
    const hero = party.find((c) => c.slot === 0);
    slotSel.forEach((sel, k) => {
      const slot = k + 1, cur = party.find((c) => c.slot === slot);
      const reachable = slot <= party.length;                     // pas de trou dans le groupe
      sel.disabled = !reachable;
      sel.replaceChildren(...[{ id: 0, name: slot < party.length ? "— retirer —" : "— vide —" },
        ...roster.filter((p) => p.id && (!hero || p.name !== hero.name))].map((p) => {
        const o = document.createElement("option"); o.value = p.id; o.textContent = p.name;
        if (p.id && party.some((c) => c.name === p.name && c.slot !== slot)) { o.disabled = true; o.textContent += " (dans le groupe)"; }
        return o;
      }));
      const curDef = cur && roster.find((p) => p.name === cur.name);
      sel.value = curDef ? curDef.id : 0; sel.dataset.cur = sel.value;
    });
  }
  slotSel.forEach((sel, k) => sel.addEventListener("change", async () => {
    sel.blur();
    const hadOne = !!sel.dataset.cur && sel.dataset.cur !== "0";
    stPartyMsg.textContent = "…";
    const r = await mem.cmd({ op: "setchar", a: k + 1, b: +sel.value }, 8000);
    stPartyMsg.textContent = !r ? "Le jeu ne répond pas (menu ou dialogue ouvert ?)."
      : r.code === 6 ? "Ce personnage est déjà dans le groupe." : r.code ? "Impossible maintenant (dialogue, scène ou menu ouvert ?)."
      : +sel.value ? (hadOne ? "Personnage remplacé (objets du précédent dans le sac)." : "Personnage ajouté.") : "Place libérée (objets dans le sac).";
    lastStats = ""; partyKey = "";
    setTimeout(() => { updateStats().catch(() => {}); updateParty(true).catch(() => {}); }, 400);
  }));
  if (MANAGE) setInterval(() => { updateParty().catch(() => {}); }, 1500);
  stDlg.addEventListener("close", () => { partyKey = ""; });
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
    stMoney.textContent = stMoney2.textContent = `${money} couronnes`;
    const bar = (cls, label, [cur, max]) => {
      const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0;
      return `<span>${label}</span><div class="bar ${cls}"><i style="width:${pct}%"></i><span>${cur} / ${max}</span></div>`;
    };
    stChars.innerHTML = st.chars.map((c) => {
      const cls = ["Guerrier", "Voleur", "Mage"].map((n, k) => {
        const next = c.lv[k] < XP.maxLevel ? xpTable[c.lv[k]] : null;
        const btn = next !== null
          ? `<button type="button" class="lvup" data-slot="${c.slot}" data-skill="${k}" title="Monter ${n} au niveau ${c.lv[k] + 1} (comme le jeu : expérience au seuil, bonus de vie ou de magie)">+</button>` : "";
        return `<span class="sk"><b>${n} ${c.lv[k]}</b><small>${c.xp[k]}${next !== null ? " / " + next : ""} xp</small>${btn}</span>`;
      }).join("");
      return `<div class="st-char" data-name="${escHtml(c.name)}"><div class="nm"><b></b></div>${bar("hp", "Vie", c.hp)}${bar("mp", "Magie", c.mp)}
        <span>Force</span><span>${c.force}</span><span>Protection</span><span>${c.prot}</span>
        <div class="st-skills">${cls}</div></div>`;
    }).join("");
    stChars.querySelectorAll(".nm b").forEach((el, i) => { el.textContent = st.chars[i].name; });
    const mini = (cls, [cur, max]) => `<div class="bar ${cls}"><i style="width:${max > 0 ? Math.max(0, Math.min(100, cur / max * 100)) : 0}%"></i><span>${cur} / ${max}</span></div>`;
    stMini.innerHTML = st.chars.map((c) => `<span class="n"></span>${mini("hp", c.hp)}${mini("mp", c.mp)}`).join("");
    stMini.querySelectorAll(".n").forEach((el, i) => { el.textContent = st.chars[i].name; });
    stMini.title = "Cliquer pour les fiches complètes";
  }
  setInterval(() => { updateStats().catch(() => {}); }, 1000);

  // --- Portraits flottants (comme les cadres de groupe d'un MMORPG) ------------------------------
  // Un cadre par personnage : portrait du jeu (viewer/data/faces.png, FACEnn.SHP), nom, vie, magie.
  // Image du portrait comme gui_drawCharFaceShape : expression courante (curFaceFrame, ou
  // tempFaceFrame pendant une animation), 1 si le personnage est hors de combat (drapeaux 0x1108),
  // + 14 (visage blessé) à la moitié de sa vie ou moins. Déplaçable à la souris (position gardée),
  // clic sur un portrait : fiches ; touche réglable (F7 par défaut) pour afficher ou masquer.
  {
    const css = document.createElement("style");
    css.textContent = `
    #party-float { position: fixed; z-index: 1002; display: flex; flex-direction: column; gap: 4px; padding: 4px;
      font: 12px/1.2 system-ui, sans-serif; color: #e8dcc0; user-select: none; touch-action: none; cursor: grab; }
    #party-float[hidden] { display: none; }
    #party-float.drag { cursor: grabbing; }
    #party-float .pm { display: grid; grid-template-columns: 52px 128px 26px; gap: 0 7px; align-items: center; padding: 4px 6px 4px 4px;
      background: rgba(12, 10, 7, .78); border: 1px solid #6d5a3a; border-radius: 7px; box-shadow: 0 2px 10px rgba(0,0,0,.6); }
    #party-float .pa { grid-column: 3; grid-row: 1 / span 3; display: flex; flex-direction: column; gap: 4px; }
    #party-float .pa button { width: 26px; height: 24px; padding: 0; border: 1px solid #6d5a3a; border-radius: 4px; background: #241c12;
      color: #f0d070; font-size: 14px; line-height: 1; cursor: pointer; }
    #party-float .pa button:hover { border-color: #c9a227; }
    #party-float .pa button.busy { filter: grayscale(1) brightness(.5); cursor: default; }
    #party-float .pa button.on { background: #5a4520; border-color: #f0d070; }
    #spell-pop { position: fixed; z-index: 1003; padding: 6px; border: 1px solid #6d5a3a; border-radius: 7px; background: rgba(12,10,7,.95);
      font: 12px/1.2 system-ui, sans-serif; color: #e8dcc0; box-shadow: 0 4px 14px rgba(0,0,0,.6); zoom: var(--ui-z, 1); min-width: 150px; }
    #spell-pop[hidden] { display: none; }
    #spell-pop .sh { color: #a39578; margin-bottom: 4px; }
    #spell-pop .types, #spell-pop .lv { display: flex; flex-wrap: wrap; gap: 4px; }
    #spell-pop .lv { margin-top: 6px; }
    #spell-pop button { font: inherit; padding: 3px 7px; border: 1px solid #555; border-radius: 4px; background: #1b1610; color: #e8dcc0; cursor: pointer; }
    #spell-pop button.on { border-color: #c9a227; color: #f0d070; }
    #spell-pop button:disabled { opacity: .35; cursor: default; }
    #spell-pop button small { color: #8fb0ff; margin-left: 3px; }
    #spell-pop .msg { margin-top: 4px; color: #ffb4a0; }
    #spell-pop .msg:empty { display: none; }
    #party-float .pf { grid-row: span 3; width: 48px; height: 48px; border: 2px solid #3a3226; border-radius: 5px;
      background-image: url("viewer/data/faces.png?v=20261123a"); background-size: ${28 * 48}px ${9 * 48}px;
      image-rendering: pixelated; cursor: pointer; }
    #party-float .pm.ko { opacity: .55; }
    #party-float .pm.ko .pf { filter: grayscale(1); }
    #party-float .pn { font-weight: 600; color: #c9a227; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #party-float .pb { position: relative; height: 12px; background: #2a2218; border-radius: 3px; overflow: hidden; }
    #party-float .pb i { position: absolute; inset: 0 auto 0 0; transition: width .25s; }
    #party-float .pb.hp i { background: linear-gradient(#4fcf5a, #2f8f38); }
    #party-float .pb.hp.mid i { background: linear-gradient(#e8c440, #b08a1a); }
    #party-float .pb.hp.low i { background: linear-gradient(#ef5a3a, #a8301c); }
    #party-float .pb.mp i { background: linear-gradient(#5a8cef, #2c55b0); }
    #party-float .pb span { position: absolute; inset: 0; text-align: center; font-size: 10px; line-height: 12px; color: #fff;
      text-shadow: 0 1px 1px #000; }`;
    document.head.appendChild(css);
    const pf = document.createElement("div");
    pf.id = "party-float"; pf.title = "Glisser pour déplacer · clic sur un portrait : fiches";
    document.body.appendChild(pf);
    let on = true, pos = null;
    try { on = localStorage.getItem("partyFloat") !== "off"; pos = JSON.parse(localStorage.getItem("partyFloatPos") || "null"); } catch (e) {}
    const place = () => {
      const r = pf.getBoundingClientRect(), w = r.width || 200, h = r.height || 60;
      let x, y;
      if (pos) { x = pos.x; y = pos.y; }
      else { const g = document.getElementById("dos"), gr = g ? g.getBoundingClientRect() : { left: 0, top: 0 }; x = gr.left + 8; y = gr.top + 8; }
      x = Math.max(0, Math.min(innerWidth - w, x)); y = Math.max(0, Math.min(innerHeight - h, y));
      pf.style.left = x / UZ() + "px"; pf.style.top = y / UZ() + "px";
    };
    const show = (v) => { on = v; pf.hidden = !on || !pf.childElementCount; try { localStorage.setItem("partyFloat", on ? "on" : "off"); } catch (e) {} if (on) place(); };
    addEventListener("resize", place);
    // déplacement : au-delà de 4 px, sinon clic (portrait -> fiches)
    let drag = null;
    pf.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const r = pf.getBoundingClientRect();
      drag = { x0: e.clientX, y0: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false, target: e.target };
      pf.setPointerCapture(e.pointerId); e.preventDefault();
    });
    pf.addEventListener("pointermove", (e) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) <= 4) return;
      drag.moved = true; pf.classList.add("drag");
      pos = { x: e.clientX - drag.dx, y: e.clientY - drag.dy }; place();
    });
    pf.addEventListener("pointerup", () => {
      if (!drag) return;
      const d = drag; drag = null; pf.classList.remove("drag");
      if (d.moved) { try { localStorage.setItem("partyFloatPos", JSON.stringify(pos)); } catch (e) {} }
      else if (d.target.closest(".pa .atk")) attackFrom(+d.target.closest(".pm").dataset.slot);
      else if (d.target.closest(".pa .book")) toggleSpells(+d.target.closest(".pm").dataset.slot);
      else if (d.target.closest(".pf") && typeof openStats === "function") openStats();
      const g = document.getElementById("dos"); if (g && g.focus) g.focus();
    });
    // Boutons à droite de chaque portrait (ScummVM) : ⚔ attaque (touche F1-F3 du jeu ; personnage 4 :
    // pas de touche, rien), 📖 livre de sorts : bascule une petite fenêtre à côté du portrait, choix du
    // sort puis du niveau (coût en magie ; grisé si le personnage ne peut pas le payer), lancé par la
    // commande « cast » (Soin 1-3 : sur le plus blessé). Grisés tant que le personnage ne peut pas agir.
    let spellFor = null, spellType = null, floatParty = [], spellMsg = "";
    const pop = document.createElement("div"); pop.id = "spell-pop"; pop.hidden = true;
    document.body.appendChild(pop);
    function attackFrom(slot) {
      const c = floatParty.find((p) => p.slot === slot);
      if (!c || c.busy || slot > 2 || !window.LoLKeys) return;
      LoLKeys.pressGame("AT" + (slot + 1));
    }
    function toggleSpells(slot) {
      spellFor = spellFor === slot ? null : slot; spellType = null; spellMsg = "";
      lastFloat = "";                                   // bouton enfoncé redessiné
      updateFloat().catch(() => {});
      renderSpellPop();
    }
    function renderSpellPop() {
      const c = floatParty.find((p) => p.slot === spellFor);
      const card = pf.querySelector(`.pm[data-slot="${spellFor}"]`);
      if (spellFor === null || !c || !card || pf.hidden) { pop.hidden = true; pop.dataset.key = ""; return; }
      const spells = knownSpells || [];
      if (spellType !== null && !spells.some((q) => q.type === spellType)) spellType = null;
      // contenu inchangé : seulement replacé (le redessiner entre l'appui et le relâchement perdrait le clic)
      const key = JSON.stringify([spellFor, spellType, c.mp, c.hp, c.busy, spells.map((q) => [q.type, q.name, q.mp, q.hp]), spellMsg]);
      if (key === pop.dataset.key && !pop.hidden) { placePop(card); return; }
      pop.dataset.key = key;
      pop.innerHTML = "";
      const h = document.createElement("div"); h.className = "sh"; h.textContent = spells.length ? `${c.name} : sort à lancer` : "Aucun sort connu";
      const types = document.createElement("div"); types.className = "types";
      for (const sp of spells) {
        const b = document.createElement("button"); b.type = "button"; b.textContent = sp.name || `sort ${sp.type}`;
        if (sp.type === spellType) b.className = "on";
        b.addEventListener("click", () => { spellType = sp.type === spellType ? null : sp.type; spellMsg = ""; renderSpellPop(); });
        types.appendChild(b);
      }
      pop.append(h, types);
      const sp = spells.find((q) => q.type === spellType);
      if (sp) {
        const lv = document.createElement("div"); lv.className = "lv";
        for (let l = 0; l < 4; l++) {
          const b = document.createElement("button"); b.type = "button";
          b.innerHTML = `Niv. ${l + 1}<small>${sp.mp[l]}</small>`;
          const ok = !c.busy && sp.mp[l] <= c.mp && sp.hp[l] < c.hp;
          b.disabled = !ok;
          b.title = `${sp.name} niveau ${l + 1} : ${sp.mp[l]} points de magie${sp.hp[l] ? `, ${sp.hp[l]} points de vie` : ""}` + (sp.type === 1 ? (l < 3 ? " — soigne le plus blessé" : " — soigne tout le groupe") : "");
          b.addEventListener("click", () => castFrom(c.slot, sp, l));
          lv.appendChild(b);
        }
        pop.appendChild(lv);
      }
      const m = document.createElement("div"); m.className = "msg"; m.textContent = spellMsg; pop.appendChild(m);
      pop.hidden = false;
      placePop(card);
    }
    function placePop(card) {
      const r = card.getBoundingClientRect(), z = UZ();
      pop.style.left = Math.min(innerWidth - pop.offsetWidth * z - 4, r.right + 6) / z + "px";
      pop.style.top = Math.max(4, Math.min(innerHeight - pop.offsetHeight * z - 4, r.top)) / z + "px";
    }
    async function castFrom(slot, sp, l) {
      let target = -1;
      if (sp.type === 1 && l < 3) {                     // Soin 1-3 : le plus blessé du groupe
        let q = 2;
        for (const p of floatParty) if (!p.ko && p.hpMax && p.hp / p.hpMax < q) { q = p.hp / p.hpMax; target = p.slot; }
      }
      spellMsg = "…"; renderSpellPop();
      const r = await mem.cmd({ op: "cast", a: slot, b: sp.type | l << 8 | (target + 1) << 12 }, 20000);
      spellMsg = !r ? "Le jeu ne répond pas." : r.code ? ({ 1: "Impossible maintenant.", 4: "Pas assez de magie.", 5: "Le sort ne peut pas partir d'ici." }[r.code] || `Refusé (${r.code}).`) : "";
      if (!r || !r.code) { spellFor = null; lastFloat = ""; pop.hidden = true; updateFloat().catch(() => {}); return; }
      renderSpellPop();
    }
    // clic droit sur un portrait avec un objet en main : utilisé sur ce personnage, comme dans le jeu
    pf.addEventListener("contextmenu", async (e) => {
      const m = e.target.closest(".pm"); if (!m) return;
      e.preventDefault();
      if (!lastInvData || lastInvData.handType < 0 || !window.LOL_ENGINE || window.LOL_ENGINE !== "scummvm") return;
      await mem.cmd({ op: "handuse", a: +m.dataset.slot }, 4000);
      lastInv = ""; setTimeout(() => updateInventory().catch(() => {}), 150);
    });
    const toggleKey = (e) => {
      if (!window.LoLKeys || !LoLKeys.is(e, "party") || LoLKeys.typing(e.target) || document.querySelector("dialog[open]")) return;
      e.preventDefault(); e.stopImmediatePropagation(); show(!on);
    };
    addEventListener("keydown", toggleKey, true);
    const hookP = () => { const f = document.querySelector("iframe#dos"); try { if (f && f.contentWindow) f.contentWindow.addEventListener("keydown", toggleKey, true); } catch (e) {} };
    hookP();
    { const f = document.querySelector("iframe#dos"); if (f) f.addEventListener("load", hookP); }

    let lastFloat = "", busy = false;
    async function updateFloat() {
      if (!on || busy || previewing) return;
      busy = true;
      try {
        const r = await mem.read([PARTY_RANGE()]);
        if (!r) return;
        const block = r[0];
        const list = partyChars(block).map((c) => {
          const u16 = (k) => c.at(k) | c.at(k + 1) << 8, s16 = (k) => (u16(k) << 16) >> 16;
          const o = c.slot * INV.charSize, flags = block[o] | block[o + 1] << 8;
          const id = Math.abs(s16(12)), cur = c.at(14), temp = c.at(15);
          const hp = s16(55), hpMax = u16(57), mp = s16(59), mpMax = u16(61);
          let f = cur < 7 && temp ? temp : temp === 0 && cur > 1 && cur < 7 ? 0 : cur;
          if (flags & 0x1108 && f < 7) f = 1;
          if (hp <= hpMax >> 1) f += 14;
          return { slot: c.slot, name: c.name, id, f: Math.max(0, Math.min(27, f)), hp, hpMax, mp, mpMax, ko: !!(flags & 8) || hp <= 0,
            busy: !!(flags & 0x314C) || hp <= 0 };
        });
        const key = JSON.stringify(list);
        if (key === lastFloat) return;
        const count = pf.childElementCount;
        lastFloat = key;
        const bar = (cls, cur, max) => {
          const q = max > 0 ? Math.max(0, Math.min(1, cur / max)) : 0;
          return `<div class="pb ${cls}${cls === "hp" ? (q <= 0.25 ? " low" : q <= 0.5 ? " mid" : "") : ""}"><i style="width:${q * 100}%"></i><span>${cur} / ${max}</span></div>`;
        };
        pf.innerHTML = list.map((c) => `<div class="pm${c.ko ? " ko" : ""}" data-slot="${c.slot}">
          <div class="pf" style="background-position:-${c.f * 48}px -${(Math.min(9, Math.max(1, c.id)) - 1) * 48}px"></div>
          <div class="pn"></div>${bar("hp", c.hp, c.hpMax)}${c.mpMax > 0 ? bar("mp", c.mp, c.mpMax) : "<div></div>"}
          ${window.LOL_ENGINE === "scummvm" ? `<div class="pa"><button type="button" class="atk${c.busy ? " busy" : ""}" title="Attaque (arme en main)">⚔</button>
          <button type="button" class="book${spellFor === c.slot ? " on" : ""}${c.busy ? " busy" : ""}" title="Livre de sorts">📖</button></div>` : ""}</div>`).join("");
        floatParty = list;
        if (spellFor !== null) renderSpellPop();
        pf.querySelectorAll(".pn").forEach((el, i) => { el.textContent = list[i].name; });
        pf.hidden = !on || !list.length;
        if (pf.childElementCount !== count) place();
      } finally { busy = false; }
    }
    setInterval(() => { updateFloat().catch(() => {}); }, 250);
    show(on);
  }

  // --- Répliques des dialogues en bulle (version ScummVM) --------------------------------------
  // Le moteur publie la dernière réplique (zone 0x7F000B00 : numéro u16, locuteur s8, longueur u16,
  // texte ; TextDisplayer_LoL::printDialogueText2 et playCharacterScriptChat). Bulle à côté du
  // portrait flottant de celui qui parle (place 0-3 du groupe) ; sinon (personnage hors du groupe,
  // texte sans locuteur, portraits masqués) en haut de la vue 3D. Durée selon la longueur du texte.
  if (window.LOL_ENGINE === "scummvm") {
    const css = document.createElement("style");
    css.textContent = `
    #say { position: fixed; z-index: 1003; max-width: 340px; padding: 7px 10px; border: 1px solid #c9a227; border-radius: 8px;
      background: rgba(20, 16, 10, .94); color: #f1e6c8; font: 13px/1.35 Georgia, serif; box-shadow: 0 4px 16px rgba(0,0,0,.7);
      pointer-events: none; white-space: pre-wrap; transition: opacity .25s; }
    #say[hidden] { display: none; }
    #say b { display: block; font: 600 11px system-ui, sans-serif; color: #c9a227; margin-bottom: 2px; }
    #say::before { content: ""; position: absolute; width: 10px; height: 10px; background: inherit; border: inherit; border-width: 0 0 1px 1px;
      left: -6px; top: 16px; transform: rotate(45deg); }
    #say.top::before { display: none; }`;
    document.head.appendChild(css);
    const say = document.createElement("div"); say.id = "say"; say.hidden = true;
    document.body.appendChild(say);
    let lastSeq = -1, hideT = 0;
    const clean = (bytes) => cp850(bytes).replace(/\r/g, "\n").replace(/[\x00-\x09\x0b-\x1f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
    async function poll() {
      const r = await mem.read([[0x7F000B00, 5 + 400], PARTY_RANGE()]);
      if (!r) return;
      const b = r[0], seq = b[0] | b[1] << 8, sp = (b[2] << 24) >> 24, n = b[3] | b[4] << 8;
      if (lastSeq < 0) { lastSeq = seq; return; }              // pas de bulle pour la réplique déjà là au chargement
      if (seq === lastSeq || !n) return;
      lastSeq = seq;
      const text = clean(b.subarray(5, 5 + n));
      if (!text) return;
      const who = sp >= 0 ? partyChars(r[1]).find((c) => c.slot === sp) : null;
      say.innerHTML = "";
      if (who) { const nb = document.createElement("b"); nb.textContent = who.name; say.appendChild(nb); }
      say.appendChild(document.createTextNode(text));
      say.hidden = false; say.style.opacity = 1;
      const card = who ? document.querySelector(`#party-float:not([hidden]) .pm[data-slot="${sp}"]`) : null;
      if (card) {
        const c = card.getBoundingClientRect();
        say.classList.remove("top");
        const z = UZ();
        say.style.left = Math.min(innerWidth - say.offsetWidth * z - 8, c.right + 10) / z + "px";
        say.style.top = Math.max(4, Math.min(innerHeight - say.offsetHeight * z - 4, c.top)) / z + "px";
      } else {
        const v = (document.getElementById("v3d") || document.body).getBoundingClientRect();
        say.classList.add("top");
        const z = UZ();
        say.style.left = Math.max(4, v.left + v.width / 2 - say.offsetWidth * z / 2) / z + "px";
        say.style.top = (v.top + 10) / z + "px";
      }
      clearTimeout(hideT);
      hideT = setTimeout(() => { say.style.opacity = 0; setTimeout(() => { say.hidden = true; }, 260); }, 2500 + 55 * text.length);
    }
    setInterval(() => { poll().catch(() => {}); }, 250);
    window.lolSay = () => ({ seq: lastSeq, text: say.textContent, hidden: say.hidden });   // débogage
  }

  // --- Barre d'actions (version ScummVM) ---------------------------------------------------------
  // 9 cases, touches 1 à 9 (réglables, keys.js). Une case contient un type d'objet (pile : nombre
  // d'exemplaires dans le sac) ou l'attaque d'un personnage. Objet : la commande « use » (op 21)
  // l'utilise sur un personnage comme un clic droit sur son portrait avec l'objet en main ; cible
  // « auto » = le personnage valide le plus blessé (proportion de vie). Attaque : touche F1-F3 du jeu.
  // On remplit la barre depuis l'inventaire (glisser un objet sur une case) ; clic droit sur une case :
  // attaques, cible, vider. Barre déplaçable (poignée ⠿), position gardée ; F6 : afficher/masquer.
  if (MANAGE) {
    const css = document.createElement("style");
    css.textContent = `
    #action-bar { position: fixed; z-index: 1002; display: flex; align-items: center; gap: 3px; padding: 4px 6px 4px 2px;
      background: rgba(12, 10, 7, .8); border: 1px solid #6d5a3a; border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,.6);
      font: 11px/1 system-ui, sans-serif; color: #e8dcc0; user-select: none; touch-action: none; }
    #action-bar[hidden] { display: none; }
    #action-bar .grip { width: 14px; align-self: stretch; display: flex; align-items: center; justify-content: center; color: #6d5a3a; cursor: grab; font-size: 14px; }
    .ab { position: relative; width: var(--ab-size, 40px); height: var(--ab-size, 40px); box-sizing: border-box; border: 1px solid #3a3226; border-radius: 4px;
      background-color: #17130e; image-rendering: pixelated; cursor: pointer; }
    .ab.full { border-color: #6d5a3a; background-image: url("viewer/data/item_icons.png"); background-size: calc(var(--ab-size, 40px) * 16) auto; background-repeat: no-repeat; }
    .ab:hover { border-color: #c9a227; }
    .ab.drop { outline: 2px dashed #28dce6; outline-offset: -1px; }
    .ab.empty-stack, .ab.busy { filter: grayscale(1) brightness(.45); }
    .ab.flash { box-shadow: 0 0 0 2px #c9a227 inset; }
    #action-bar.holding .ab { cursor: copy; }
    #action-bar.holding .ab:hover { outline: 2px dashed #28dce6; outline-offset: -2px; }
    .ab.fail { box-shadow: 0 0 0 2px #e0442a inset; }
    .ab .k { position: absolute; left: 2px; top: 1px; color: #c9a227; font-weight: 700; text-shadow: 0 0 2px #000; }
    .ab .cnt { position: absolute; right: 2px; bottom: 1px; color: #fff; font-weight: 700; text-shadow: 0 0 2px #000, 0 0 2px #000; }
    .ab .atk { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; font-size: 9px; color: #ffd2a0; }
    .ab .atk b { font-size: 16px; }
    .ab .atk.spell { color: #b8d0ff; }
    .ab[draggable="true"] { cursor: grab; }
    #ab-tip { position: fixed; z-index: 1003; padding: 3px 7px; border-radius: 4px; background: #0f0d0a; border: 1px solid #6d5a3a; color: #e8dcc0;
      font: 12px system-ui, sans-serif; pointer-events: none; }
    #ab-tip[hidden] { display: none; }
    #ab-menu { position: fixed; z-index: 1004; min-width: 170px; padding: 4px; border: 1px solid #6d5a3a; border-radius: 6px; background: #0f0d0a;
      font: 13px system-ui, sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.7); }
    #ab-menu[hidden] { display: none; }
    #ab-menu .h { padding: 3px 8px; color: #8a7f68; font-size: 11px; }
    #ab-menu button { display: block; width: 100%; text-align: left; padding: 4px 8px; border: 0; border-radius: 4px; background: none; color: #e8dcc0; cursor: pointer; font: inherit; }
    #ab-menu button:hover { background: #2a2217; }
    #ab-menu button.on::before { content: "✓ "; color: #c9a227; }`;
    document.head.appendChild(css);
    const N = 9, AB_ICON = 40, HEAL_SPELL = 1;
    let bar = [];
    try { bar = JSON.parse(localStorage.getItem("lol-actionbar") || "[]") || []; } catch (e) { bar = []; }
    bar = Array.from({ length: N }, (_, i) => bar[i] || null);
    const saveBar = () => { try { localStorage.setItem("lol-actionbar", JSON.stringify(bar)); } catch (e) {} refresh(); };
    const el = document.createElement("div"); el.id = "action-bar";
    const grip = document.createElement("div"); grip.className = "grip"; grip.textContent = "⠿"; grip.title = "Glisser pour déplacer la barre";
    el.appendChild(grip);
    const tip = document.createElement("div"); tip.id = "ab-tip"; tip.hidden = true;
    const menu = document.createElement("div"); menu.id = "ab-menu"; menu.hidden = true;
    document.body.append(el, tip, menu);
    const invRow = document.getElementById("inv-abar-row"), invAbar = document.getElementById("inv-abar");
    if (invRow) invRow.hidden = false;

    const bagTypes = () => (lastInvData ? lastInvData.barTypes : []);
    const countOf = (t) => bagTypes().filter((x) => x === t).length;
    const partyNow = () => (lastInvData ? lastInvData.party : []);
    function slotEl(i, inDialog) {
      const a = bar[i], d = document.createElement("div");
      d.className = "ab"; d.dataset.i = i;
      const k = document.createElement("span"); k.className = "k";
      const code = window.LoLKeys ? LoLKeys.codeOf("bar" + (i + 1)) : "Digit" + (i + 1);
      k.textContent = code ? LoLKeys.keyName(code) : "";
      if (a && a.k === "item" && itemInfo) {
        const it = itemInfo[a.t] || { name: `objet ${a.t}`, icon: -1 }, n = countOf(a.t);
        d.classList.add("full");
        const S = inDialog ? AB_ICON : parseFloat(getComputedStyle(el).getPropertyValue("--ab-size")) || AB_ICON;
        if (it.icon >= 0) d.style.backgroundPosition = `-${(it.icon % ICON_COLS) * S}px -${Math.floor(it.icon / ICON_COLS) * S}px`;
        if (!n) d.classList.add("empty-stack");
        const c = document.createElement("span"); c.className = "cnt"; c.textContent = n; d.appendChild(c);
        const who = a.for === undefined || a.for === "auto" ? "le plus blessé" : (partyNow().find((p) => p.slot === a.for) || {}).name || "?";
        d.dataset.tip = `${it.name} — ${n} dans le sac · ` + (a.mode === "use" ? `utiliser sur : ${who}` : "prendre en main");
        d.dataset.itemType = a.t; d.dataset.itemNote = `${n} dans le sac · touche : ` + (a.mode === "use" ? `utiliser sur ${who}` : "prendre en main");
        if (lastInvData && lastInvData.handType === a.t) d.classList.add("flash");
      } else if (a && a.k === "spell") {
        const p = partyNow().find((q) => q.slot === a.c);
        const box = document.createElement("div"); box.className = "atk spell"; box.innerHTML = "<b>✦</b><span></span>";
        box.lastChild.textContent = `${(a.n || "sort").slice(0, 7)} ${a.l + 1}`;
        d.appendChild(box);
        const healWho = a.s === HEAL_SPELL && a.l < 3 ? ` · soigne : ${a.for === undefined || a.for === "auto" ? "le plus blessé" : (partyNow().find((q) => q.slot === a.for) || {}).name || "?"}` : "";
        d.dataset.tip = `${a.n || "Sort"} niveau ${a.l + 1} · lanceur : ${p ? p.name : "?"}${healWho}`;
      } else if (a && a.k === "atk") {
        const p = partyNow().find((q) => q.slot === a.c);
        const box = document.createElement("div"); box.className = "atk"; box.innerHTML = "<b>⚔</b><span></span>";
        box.lastChild.textContent = p ? p.name : `perso ${a.c + 1}`;
        d.appendChild(box);
        d.dataset.tip = `Attaque : ${p ? p.name : "personnage " + (a.c + 1)}`;
      } else d.dataset.tip = inDialog ? "Case vide : glisser un objet du sac ici" : `Case vide : glisser un sort ou une attaque du panneau Magie, ou un objet depuis l'inventaire (${invKey() || "Gérer…"}) ; clic droit : attaques`;
      d.appendChild(k);
      return d;
    }
    // glisser-déposer : actions du panneau de magie, objets du sac (fenêtre d'inventaire), cases de
    // la barre (déplacer / échanger ; lâchée hors de la barre : case vidée)
    let dragSlot = -1;
    function wire(d, i) {
      if (bar[i]) {
        d.draggable = true;
        d.addEventListener("dragstart", (e) => {
          dragSlot = i; tip.hidden = true;
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("application/x-lol-action", JSON.stringify({ from: i }));
        });
        d.addEventListener("dragend", (e) => {
          const from = dragSlot; dragSlot = -1;
          const r = (d.closest("#action-bar, #inv-abar") || d).getBoundingClientRect();
          const out = e.clientX < r.left - 8 || e.clientX > r.right + 8 || e.clientY < r.top - 8 || e.clientY > r.bottom + 8;
          if (from >= 0 && e.dataTransfer.dropEffect === "none" && out && (e.clientX || e.clientY)) { bar[from] = null; saveBar(); }
          else refresh();
        });
      }
      d.addEventListener("dragover", (e) => {
        if (dragFrom >= 0 || dragSlot >= 0 || e.dataTransfer.types.includes("application/x-lol-action")) {
          e.preventDefault(); e.dataTransfer.dropEffect = dragSlot >= 0 ? "move" : "copy"; d.classList.add("drop");
        }
      });
      d.addEventListener("dragleave", () => d.classList.remove("drop"));
      d.addEventListener("drop", (e) => {
        e.preventDefault(); d.classList.remove("drop");
        let data = null;
        try { data = JSON.parse(e.dataTransfer.getData("application/x-lol-action") || "null"); } catch (err) {}
        if (data && data.from !== undefined) {
          const f = data.from; if (f !== i) { [bar[f], bar[i]] = [bar[i], bar[f]]; }
          dragSlot = -1; saveBar(); return;
        }
        if (data && (data.k === "atk" || data.k === "spell")) { bar[i] = data.k === "spell" ? { ...data, for: "auto" } : data; saveBar(); return; }
        const t = typeAtLoc(dragFrom); dragFrom = -1;
        if (t >= 0) { bar[i] = { k: "item", t, for: "auto", mode: "hand" }; saveBar(); }
      });
    }
    function refresh() {
      if (!itemInfo || dragSlot >= 0) return;
      const keep = el.querySelectorAll(".ab").length;
      el.replaceChildren(grip, ...bar.map((_, i) => { const d = slotEl(i, false); wire(d, i); return d; }));
      if (invAbar) invAbar.replaceChildren(...bar.map((_, i) => { const d = slotEl(i, true); wire(d, i); return d; }));
      if (typeof applyReady === "function") applyReady();
      if (!keep) place();
    }
    // Disponibilité (toutes les 200 ms) : attaque grisée tant que le personnage ne peut pas frapper
    // (drapeaux & 0x314C, comme clickedAttackButton : arme qui se recharge, inconscient…) ; sort
    // grisé si le lanceur ne peut pas le lancer (même drapeaux, magie ou vie insuffisante pour ce niveau).
    let ready = new Map();                              // personnage -> { flags, hp, mp }
    function applyReady() {
      for (const d of document.querySelectorAll("#action-bar .ab, #inv-abar .ab")) {
        const a = bar[+d.dataset.i], c = a && (a.k === "atk" || a.k === "spell") ? ready.get(a.c) : null;
        let busy = false;
        if (a && (a.k === "atk" || a.k === "spell")) busy = !c || !!(c.flags & 0x314C) || c.hp <= 0;
        if (!busy && a && a.k === "spell" && c) {
          const sp = knownSpells.find((q) => q.type === a.s);
          busy = !sp || sp.mp[a.l] > c.mp || sp.hp[a.l] >= c.hp;
        }
        d.classList.toggle("busy", busy);
      }
    }
    let polling = false;
    setInterval(async () => {
      if (polling || el.hidden || previewing || !bar.some((a) => a && a.k !== "item")) return;
      polling = true;
      try {
        const r = await mem.read([PARTY_RANGE()]);
        if (!r) return;
        const m = new Map();
        for (const c of partyChars(r[0])) {
          const u16 = (k) => c.at(k) | c.at(k + 1) << 8, s16 = (k) => (u16(k) << 16) >> 16;
          const o = c.slot * INV.charSize;
          m.set(c.slot, { flags: r[0][o] | r[0][o + 1] << 8, hp: s16(55), mp: s16(59) });
        }
        ready = m; applyReady();
      } finally { polling = false; }
    }, 200);
    window.lolActionBarRefresh = refresh;
    window.lolActionBar = { get: () => bar.slice(), set: (i, a) => { bar[i] = a; saveBar(); } };   // débogage
    function typeAtLoc(loc) {
      if (!lastInvData) return -1;
      if (loc >= 0 && loc < 48) return lastInvData.barTypes[loc];
      if (loc === LOC_HAND) return lastInvData.handType;
      if (loc >= 200) { const c = lastInvData.party.find((p) => p.slot === Math.floor((loc - 200) / 11)); return c ? c.eq[(loc - 200) % 11] : -1; }
      return -1;
    }

    // déclenchement
    const USE_ERR = { 1: "impossible", 3: "case vide", 4: "cet objet ne s'utilise pas ainsi", 5: "personnage hors de combat",
      11: "pas pendant un dialogue", 13: "menu de magie ouvert" };
    function flash(i, ok, msg) {
      for (const d of document.querySelectorAll(`.ab[data-i="${i}"]`)) {
        d.classList.add(ok ? "flash" : "fail"); setTimeout(() => d.classList.remove("flash", "fail"), 350);
      }
      if (msg) showTip(el.querySelector(`.ab[data-i="${i}"]`), msg, 1800);
    }
    async function autoTarget() {
      const r = await mem.read([PARTY_RANGE()]);
      if (!r) return 0;
      let best = -1, bestQ = 2;
      for (const c of partyChars(r[0])) {
        const u16 = (k) => c.at(k) | c.at(k + 1) << 8, s16 = (k) => (u16(k) << 16) >> 16;
        const flags = r[0][c.slot * INV.charSize] | r[0][c.slot * INV.charSize + 1] << 8;
        const hp = s16(55), max = u16(57);
        if (flags & 8 || hp <= 0 || !max) continue;
        const q = hp / max;
        if (q < bestQ) { bestQ = q; best = c.slot; }
      }
      return best < 0 ? 0 : best;
    }
    let busyUse = false;
    async function trigger(i) {
      const a = bar[i];
      if (!a) { flash(i, false, "Case vide"); return; }
      if (a.k === "atk") { LoLKeys.pressGame("AT" + (a.c + 1)); flash(i, true); return; }
      if (a.k === "spell") {
        if (busyUse) return;
        busyUse = true;
        try {
          const caster = partyNow().some((p) => p.slot === a.c) ? a.c : (partyNow()[0] || { slot: 0 }).slot;
          const target = a.s === HEAL_SPELL && a.l < 3 ? (a.for === undefined || a.for === "auto" ? await autoTarget() : a.for) : -1;
          const r = await mem.cmd({ op: "cast", a: caster, b: a.s | a.l << 8 | (target + 1) << 12 }, 20000);
          if (!r) flash(i, false, "Le jeu ne répond pas (menu ouvert ?)");
          else if (r.code) flash(i, false, { 1: "impossible maintenant", 4: "pas assez de magie", 5: "le sort ne peut pas partir d'ici" }[r.code] || `refusé (code ${r.code})`);
          else flash(i, true);
        } finally { busyUse = false; }
        return;
      }
      if (busyUse) return;
      const loc = bagTypes().indexOf(a.t);
      if (a.mode !== "use") {
        // prendre en main (curseur du jeu), comme un clic sur l'objet dans le sac : on l'utilise
        // ensuite comme dans le jeu (clic dans la vue : lancé sur un monstre ; sur le sol : posé ;
        // clic droit sur un portrait : utilisé). Déjà en main : reposé dans le sac.
        const held = lastInvData ? lastInvData.handType : -1;
        busyUse = true;
        try {
          let r;
          if (held === a.t) {
            const free = bagTypes().indexOf(-1);
            if (free < 0) { flash(i, false, "Le sac est plein"); return; }
            r = await mem.cmd({ op: "move", a: LOC_HAND, b: free }, 4000);
          } else {
            if (loc < 0) { flash(i, false, `Plus de ${(itemInfo[a.t] || {}).name || "cet objet"} dans le sac`); return; }
            r = await mem.cmd({ op: "move", a: loc, b: LOC_HAND }, 4000);
          }
          if (!r) flash(i, false, "Le jeu ne répond pas (menu ouvert ?)");
          else if (r.code) flash(i, false, `impossible (code ${r.code})`);
          else flash(i, true, held === a.t ? "Rangé dans le sac" : "En main : clic dans la vue pour le lancer, sur le sol pour le poser, clic droit sur un portrait pour l'utiliser");
          lastInv = ""; setTimeout(() => updateInventory().catch(() => {}), 150);
        } finally { busyUse = false; }
        return;
      }
      if (loc < 0) { flash(i, false, `Plus de ${(itemInfo[a.t] || {}).name || "cet objet"} dans le sac`); return; }
      busyUse = true;
      try {
        const who = a.for === undefined || a.for === "auto" ? await autoTarget() : a.for;
        const r = await mem.cmd({ op: "use", a: loc, b: who }, 4000);
        if (!r) flash(i, false, "Le jeu ne répond pas (menu ouvert ?)");
        else if (r.code) flash(i, false, USE_ERR[r.code] || `refusé (code ${r.code})`);
        else flash(i, true);
        lastInv = ""; setTimeout(() => updateInventory().catch(() => {}), 150);
      } finally { busyUse = false; }
    }
    // touches : depuis la page et depuis la fenêtre du jeu (où arrivent aussi celles de la vue 3D)
    const onKey = (e) => {
      if (!window.LoLKeys || e.ctrlKey || e.metaKey || e.altKey || LoLKeys.typing(e.target)) return;
      if (LoLKeys.is(e, "bar")) { if (document.querySelector("dialog[open]")) return; e.preventDefault(); e.stopImmediatePropagation(); showBar(el.hidden); return; }
      const id = LoLKeys.actionFor(e.code, "barre");
      if (!id || document.querySelector("dialog[open]")) return;
      try { const w = document.getElementById("dos").contentWindow; if (w.lolMenuOpen && w.lolMenuOpen()) return; } catch (err) {}
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat) trigger(+id.slice(3) - 1);
    };
    addEventListener("keydown", onKey, true);
    const hookK = () => { const f = document.querySelector("iframe#dos"); try { if (f && f.contentWindow) f.contentWindow.addEventListener("keydown", onKey, true); } catch (e) {} };
    hookK();
    { const f = document.querySelector("iframe#dos"); if (f) f.addEventListener("load", hookK); }
    if (window.LoLKeys) LoLKeys.onChange(refresh);

    // souris : clic = déclencher, clic droit = menu, poignée = déplacer
    function showTip(d, text, ms) {
      if (!d || !text) { tip.hidden = true; return; }
      const r = d.getBoundingClientRect();
      tip.textContent = text; tip.hidden = false;
      const z = UZ(), tw = tip.offsetWidth * z, th = tip.offsetHeight * z;
      tip.style.left = Math.max(4, Math.min(innerWidth - tw - 4, r.left + r.width / 2 - tw / 2)) / z + "px";
      tip.style.top = Math.max(4, r.top - th - 6) / z + "px";
      clearTimeout(showTip.t); if (ms) showTip.t = setTimeout(() => { tip.hidden = true; }, ms);
    }
    el.addEventListener("mouseover", (e) => { const d = e.target.closest(".ab"); if (d && !d.dataset.itemType) showTip(d, d.dataset.tip); else tip.hidden = true; });
    el.addEventListener("mouseleave", () => { tip.hidden = true; });
    // objet tenu en main (curseur du jeu) déposé sur une case : la case reçoit ce type d'objet et
    // l'objet retourne dans le sac (première case libre), où la pile de la case le compte
    async function dropHand(i) {
      const t = lastInvData ? lastInvData.handType : -1;
      if (t < 0) return false;
      bar[i] = { k: "item", t, for: "auto", mode: "hand" }; saveBar();
      const free = bagTypes().indexOf(-1);
      if (free >= 0) {
        await mem.cmd({ op: "move", a: LOC_HAND, b: free }, 4000);
        lastInv = ""; setTimeout(() => updateInventory().catch(() => {}), 150);
        flash(i, true, `${(itemInfo[t] || {}).name || "Objet"} : rangé dans le sac, raccourci en case ${i + 1}`);
      } else flash(i, true, "Raccourci créé (sac plein : l'objet reste en main)");
      return true;
    }
    el.addEventListener("mouseenter", () => el.classList.toggle("holding", !!(lastInvData && lastInvData.handType >= 0)));
    el.addEventListener("click", async (e) => {
      const d = e.target.closest(".ab"); if (!d) return;
      if (lastInvData && lastInvData.handType >= 0 && !(bar[+d.dataset.i] && bar[+d.dataset.i].k === "item" && bar[+d.dataset.i].t === lastInvData.handType && bar[+d.dataset.i].mode !== "use")) {
        await dropHand(+d.dataset.i);
        const g = document.getElementById("dos"); if (g && g.focus) g.focus();
        return;
      }
      trigger(+d.dataset.i);
      const g = document.getElementById("dos"); if (g && g.focus) g.focus();
    });
    function openMenu(i, x, y) {
      const a = bar[i], items = [];
      menu.replaceChildren();
      const add = (text, fn, on) => { const b = document.createElement("button"); b.type = "button"; b.textContent = text; if (on) b.className = "on"; b.addEventListener("click", () => { menu.hidden = true; fn(); }); menu.appendChild(b); };
      const head = (t) => { const h = document.createElement("div"); h.className = "h"; h.textContent = t; menu.appendChild(h); };
      head(`Case ${i + 1}`);
      for (const p of partyNow()) add(`Attaque : ${p.name}`, () => { bar[i] = { k: "atk", c: p.slot }; saveBar(); }, a && a.k === "atk" && a.c === p.slot);
      if (a && a.k === "spell") {
        head("Lanceur");
        for (const p of partyNow()) add(p.name, () => { a.c = p.slot; saveBar(); }, a.c === p.slot);
      }
      if (a && a.k === "item") {
        head("Action");
        add("Prendre en main", () => { a.mode = "hand"; saveBar(); }, a.mode !== "use");
        add("Utiliser directement", () => { a.mode = "use"; saveBar(); }, a.mode === "use");
      }
      if (a && ((a.k === "item" && a.mode === "use") || (a.k === "spell" && a.s === HEAL_SPELL && a.l < 3))) {
        head(a.k === "item" ? "Utiliser sur" : "Soigner");
        add("Le plus blessé", () => { a.for = "auto"; saveBar(); }, a.for === undefined || a.for === "auto");
        for (const p of partyNow()) add(p.name, () => { a.for = p.slot; saveBar(); }, a.for === p.slot);
      }
      if (a) add("Vider la case", () => { bar[i] = null; saveBar(); });
      if (!partyNow().length && !a) head(`Glisser un objet depuis l'inventaire (${invKey() || "Gérer…"})`);
      menu.hidden = false;
      const z = menu.closest("dialog") ? 1 : UZ(), zd = menu.closest("dialog") ? UZ() : 1;   // dans une fenêtre zoomée : ses coordonnées
      menu.style.left = Math.min(innerWidth - menu.offsetWidth * z * zd - 4, x) / (z * zd) + "px";
      menu.style.top = Math.max(4, y - menu.offsetHeight * z * zd) / (z * zd) + "px";
    }
    const ctx = (e) => { const d = e.target.closest(".ab"); if (!d) return; e.preventDefault(); openMenu(+d.dataset.i, e.clientX, e.clientY); };
    el.addEventListener("contextmenu", ctx);
    if (invAbar) invAbar.addEventListener("contextmenu", (e) => {
      // dans la fenêtre d'inventaire (modale) : menu dans la fenêtre pour rester cliquable
      const dlg = document.getElementById("inv-dlg");
      if (menu.parentNode !== dlg) dlg.appendChild(menu);
      ctx(e);
    });
    el.addEventListener("contextmenu", () => { if (menu.parentNode !== document.body) document.body.appendChild(menu); }, true);
    addEventListener("pointerdown", (e) => { if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true; }, true);

    let pos = null, on = true;
    try { pos = JSON.parse(localStorage.getItem("actionBarPos") || "null"); on = localStorage.getItem("actionBar") !== "off"; } catch (e) {}
    function place() {
      if (document.body.classList.contains("ui-classic")) return;       // ancrée sur l'interface originale (classic.js)
      const r = el.getBoundingClientRect(), w = r.width || 420, h = r.height || 50;
      let x, y;
      if (pos) { x = pos.x; y = pos.y; }
      else { const g = document.getElementById("dos"), gr = g ? g.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
        // dans la bande libre sous la vue 3D s'il y en a une, sinon juste sous l'écran du jeu (sa rangée
        // d'objets est en bas), sinon en bas de la fenêtre
        const free = document.getElementById("v3d-free"), fr = free && free.offsetHeight >= h ? free.getBoundingClientRect() : null;
        x = gr.left + gr.width / 2 - w / 2;
        y = fr ? fr.top + (fr.height - h) / 2 : gr.top + gr.height + 6 + h <= innerHeight ? gr.top + gr.height + 6 : innerHeight - h - 8; }
      el.style.left = Math.max(0, Math.min(innerWidth - w, x)) / UZ() + "px"; el.style.top = Math.max(0, Math.min(innerHeight - h, y)) / UZ() + "px";
    }
    // cachée tant que la partie n'a pas commencé (introduction, menu principal : boutons du jeu dessous)
    const started = () => { try { const w = document.getElementById("dos").contentWindow; return !!(w.lolStarted && w.lolStarted()); } catch (e) { return false; } };
    function showBar(v) { on = v; try { localStorage.setItem("actionBar", on ? "on" : "off"); } catch (e) {} sync(); }
    function sync() { const vis = on && started(); if (el.hidden === !vis) return; el.hidden = !vis; if (vis) place(); }
    el.hidden = true;
    setInterval(sync, 500);
    addEventListener("resize", place);
    let drag = null;
    grip.addEventListener("pointerdown", (e) => {
      const r = el.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }; grip.setPointerCapture(e.pointerId); e.preventDefault();
    });
    grip.addEventListener("pointermove", (e) => { if (!drag) return; pos = { x: e.clientX - drag.dx, y: e.clientY - drag.dy }; place(); });
    grip.addEventListener("pointerup", () => {
      if (!drag) return; drag = null;
      try { localStorage.setItem("actionBarPos", JSON.stringify(pos)); } catch (e) {}
      const g = document.getElementById("dos"); if (g && g.focus) g.focus();
    });
    const waitItems = () => { if (itemInfo) { refresh(); showBar(on); } else setTimeout(waitItems, 300); };
    waitItems();
  }
  {
    const b = document.getElementById("inv-stacks");
    if (b) {
      const paint = () => { b.classList.toggle("on", stackView); b.textContent = stackView ? "Par piles ✓" : "Par piles"; };
      paint();
      b.addEventListener("click", () => {
        stackView = !stackView; paint(); b.blur();
        try { localStorage.setItem("invStacks", stackView ? "on" : "off"); } catch (e) {}
        lastInv = ""; updateInventory().catch(() => {});
      });
    }
  }

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
  const cheatAuto = document.getElementById("cheat-auto");
  if (!MANAGE) cheatAuto.parentNode.hidden = true;      // attaque auto : moteur ScummVM seulement
  for (const [box, key] of [[cheatHp, "cheatHp"], [cheatMp, "cheatMp"], [cheatAuto, "autoAttack"]]) {
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
    const mask = (cheatHp.checked ? 1 : 0) | (cheatMp.checked ? 2 : 0) | (cheatAuto.checked ? 4 : 0);
    if (mask === cheatSent && performance.now() - cheatSentAt < 3000) return;
    const r = await mem.cmd({ op: "cheat", a: mask }, 1500);
    if (r && r.code === 0) { cheatSent = mask; cheatSentAt = performance.now(); }
  }
  if (MANAGE) {
    for (const box of [cheatHp, cheatMp, cheatAuto]) box.addEventListener("change", () => { cheatSent = -1; sendCheats().catch(() => {}); });
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

  // --- Téléportation (version ScummVM ; grande carte, touche Tab) ----------------------------
  // Dans le niveau : commande « teleport » (case, comme olol_setGlobalVar(0) des scripts, direction
  // conservée) ; vers un autre niveau : « goto » (chargement du niveau, comme olol_loadNewLevel).
  // Renvoie le message à afficher.
  let tpBusy = false;
  async function teleport(level, block) {
    if (tpBusy) return "";
    tpBusy = true;
    try {
      const same = current && level === current.level;
      const r = await mem.cmd(same ? { op: "teleport", a: block, b: -1 } : { op: "goto", a: level, b: block }, same ? 3000 : 15000);
      return !r ? "Le jeu ne répond pas (menu ou dialogue ouvert ?)."
        : r.code ? "Impossible ici (case pleine, dialogue ou menu ouvert)." : `Téléporté : case ${block % 32},${block >> 5}.`;
    } finally { tpBusy = false; }
  }
  loadLevels().then(() => setInterval(tick, 200),
    (e) => { infoEl.textContent = "cartes introuvables (viewer/data) : " + e.message; });
})();
