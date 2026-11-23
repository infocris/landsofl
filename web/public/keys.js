// Touches réglables (docs/reverse-engineering.md § 10a) : une touche par action, choisie dans la
// fenêtre « Touches… » et gardée dans le navigateur (localStorage « lol-keys », par version : DOSBox
// et ScummVM sont servies sur deux ports, donc deux réglages). Les touches sont repérées par leur
// position physique (event.code) et affichées avec la lettre du clavier de l'utilisateur.
//
// Actions du jeu : la page traduit la touche choisie en touche fixe du jeu.
// - ScummVM : flèches, Origine, Page↑, F1-F3 (seules touches de scummvm.ini) ; écouteur dans la
//   fenêtre du jeu (cadre #dos), coupé pendant le menu du jeu (saisie d'un nom de sauvegarde).
// - DOSBox : codes js-dos envoyés par le script de la page (index.html).
// Raccourcis de la page : mini-carte, vue 3D, carte, inventaire, interrupteur.
(() => {
  "use strict";
  const ENGINE = window.LOL_ENGINE || (/\/lol(-game)?\.html$/.test(location.pathname) ? "scummvm" : "dosbox");
  const SCUMM = ENGINE === "scummvm";
  // Q / D tournent et A / E font un pas de côté sous ScummVM ; l'inverse sous DOSBox (choix de 2026-11-09)
  const ACTIONS = [
    { id: "MVF", group: "jeu", label: "Avancer", def: "KeyW" },
    { id: "MVB", group: "jeu", label: "Reculer", def: "KeyS" },
    { id: "TL", group: "jeu", label: "Tourner à gauche", def: SCUMM ? "KeyA" : "KeyQ" },
    { id: "TR", group: "jeu", label: "Tourner à droite", def: SCUMM ? "KeyD" : "KeyE" },
    { id: "SLL", group: "jeu", label: "Pas à gauche", def: SCUMM ? "KeyQ" : "KeyA" },
    { id: "SLR", group: "jeu", label: "Pas à droite", def: SCUMM ? "KeyE" : "KeyD" },
    // sous ScummVM, 1 à 9 vont à la barre d'actions (minimap.js) ; les attaques gardent F1-F3
    { id: "AT1", group: "jeu", label: "Attaque, personnage 1", def: SCUMM ? "" : "Digit1" },
    { id: "AT2", group: "jeu", label: "Attaque, personnage 2", def: SCUMM ? "" : "Digit2" },
    { id: "AT3", group: "jeu", label: "Attaque, personnage 3", def: SCUMM ? "" : "Digit3" },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ id: "bar" + n, group: "barre", label: `Case ${n}`, def: "Digit" + n, scumm: true })),
    { id: "map", group: "page", label: "Grande carte", def: "Tab" },
    { id: "inv", group: "page", label: "Inventaire", def: "KeyI" },
    { id: "switch", group: "page", label: "Actionner l'interrupteur devant le groupe", def: "Space", scumm: true },
    { id: "minimap", group: "page", label: "Afficher/masquer le panneau", def: "F9" },
    { id: "view3d", group: "page", label: "Afficher/masquer la vue 3D", def: "F10" },
    { id: "party", group: "page", label: "Afficher/masquer les portraits", def: "F7" },
    { id: "bar", group: "page", label: "Afficher/masquer la barre d'actions", def: "F6", scumm: true },
    { id: "zqsd", group: "page", label: "Activer/désactiver les touches du jeu", def: "F8", dosbox: true },
  ].filter((a) => !(a.scumm && !SCUMM) && !(a.dosbox && SCUMM));
  // touches fixes du jeu sous ScummVM (keymap de scummvm.ini, tools/scummvm_web.py)
  const FIXED = { MVF: ["ArrowUp", 38], MVB: ["ArrowDown", 40], TL: ["Home", 36], TR: ["PageUp", 33],
    SLL: ["ArrowLeft", 37], SLR: ["ArrowRight", 39], AT1: ["F1", 112], AT2: ["F2", 113], AT3: ["F3", 114] };
  const FIXED_LABEL = { MVF: "↑", MVB: "↓", TL: SCUMM ? "Origine" : "pavé 4", TR: SCUMM ? "Page↑" : "pavé 6",
    SLL: SCUMM ? "←" : "pavé 7", SLR: SCUMM ? "→" : "pavé 9", AT1: "F1", AT2: "F2", AT3: "F3" };
  const STORE = "lol-keys";

  let custom = {};
  try { custom = JSON.parse(localStorage.getItem(STORE) || "{}") || {}; } catch (e) { custom = {}; }
  const listeners = new Set();
  const codeOf = (id) => (id in custom ? custom[id] : (ACTIONS.find((a) => a.id === id) || {}).def) || null;
  function actionFor(code, group) {
    for (const a of ACTIONS) if ((!group || a.group === group) && codeOf(a.id) === code) return a.id;
    return null;
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(custom)); } catch (e) {}
    for (const f of listeners) try { f(); } catch (e) {}
  }
  // une touche déjà prise est retirée à l'action qui l'avait, qui reste sans touche ("")
  function assign(id, code) {
    const other = code && ACTIONS.find((a) => a.id !== id && codeOf(a.id) === code);
    if (other) custom[other.id] = "";
    custom[id] = code;
    for (const a of ACTIONS) if (custom[a.id] === a.def) delete custom[a.id];
    save();
  }
  function reset() { custom = {}; save(); }

  // nom affiché : lettre du clavier de l'utilisateur (API Keyboard de Chrome), sinon nom générique
  let layout = null;
  try { if (navigator.keyboard && navigator.keyboard.getLayoutMap) navigator.keyboard.getLayoutMap().then((m) => { layout = m; for (const f of listeners) try { f(); } catch (e) {} }, () => {}); } catch (e) {}
  const NAMES = { Space: "Espace", Tab: "Tab", Enter: "Entrée", Backspace: "Retour arr.", Escape: "Échap",
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Home: "Origine", End: "Fin", PageUp: "Page↑",
    PageDown: "Page↓", Insert: "Inser", Delete: "Suppr", ShiftLeft: "Maj gauche", ShiftRight: "Maj droite",
    ControlLeft: "Ctrl gauche", ControlRight: "Ctrl droite", AltLeft: "Alt", AltRight: "Alt Gr", CapsLock: "Verr. maj" };
  // repli : clavier AZERTY (celui de l'utilisateur), positions physiques QWERTY
  const AZERTY = { KeyQ: "A", KeyW: "Z", KeyA: "Q", KeyZ: "W", KeyM: "?", Semicolon: "M", Digit1: "1", Digit2: "2",
    Digit3: "3", Digit4: "4", Digit5: "5", Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9", Digit0: "0" };
  function keyName(code) {
    if (!code) return "—";
    if (NAMES[code]) return NAMES[code];
    if (/^Numpad/.test(code)) return "pavé " + code.slice(6).replace("Add", "+").replace("Subtract", "−").replace("Multiply", "×").replace("Divide", "/").replace("Decimal", ",").replace("Enter", "Entrée");
    if (/^F\d+$/.test(code)) return code;
    const l = layout && layout.get(code);
    if (l && l.trim()) return /^Digit/.test(code) ? code.slice(5) : l.toUpperCase();
    if (AZERTY[code]) return AZERTY[code];
    return code.replace(/^Key/, "").replace(/^Digit/, "");
  }

  // e correspond-il à l'action (sans modificateur) ?
  const is = (e, id) => !!e && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === codeOf(id) && !!e.code;
  const typing = (t) => !!(t && t.closest && t.closest("input, textarea, select, [contenteditable]"));

  // appui sur la touche fixe d'une action du jeu (ScummVM), p. ex. une attaque depuis la barre d'actions
  function pressGame(id) {
    const f = document.getElementById("dos"), k = FIXED[id];
    let win; try { win = f && f.contentWindow; } catch (e) { return; }
    if (!win || !k) return;
    for (const type of ["keydown", "keyup"]) {
      const ev = new win.KeyboardEvent(type, { key: k[0], code: k[0], keyCode: k[1], which: k[1], bubbles: true, cancelable: true });
      ev.lolMapped = true;
      (win.document.body || win.document).dispatchEvent(ev);
    }
  }
  window.LoLKeys = { ACTIONS, FIXED, ENGINE, codeOf, actionFor, assign, reset, keyName, is, typing, pressGame,
    onChange: (f) => listeners.add(f), fixedLabel: (id) => FIXED_LABEL[id] || "" };

  // --- ScummVM : traduction dans la fenêtre du jeu ---------------------------------------------------
  if (SCUMM && window === window.top) {
    const held = new Map();                       // code physique -> [key, keyCode] envoyé
    const send = (win, type, [key, keyCode]) => {
      const ev = new win.KeyboardEvent(type, { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true });
      ev.lolMapped = true;                        // ne pas retraduire
      (win.document.body || win.document).dispatchEvent(ev);
    };
    const hook = () => {
      const f = document.getElementById("dos");
      let win;
      try { win = f && f.contentWindow; if (!win || win.__lolKeys) return; win.__lolKeys = true; } catch (e) { return; }
      const menu = () => { try { return !!(win.lolMenuOpen && win.lolMenuOpen()); } catch (e) { return false; } };
      const on = (e) => {
        if (e.lolMapped) return;
        const down = e.type === "keydown";
        if (!down && held.has(e.code)) {
          send(win, "keyup", held.get(e.code)); held.delete(e.code);
          e.preventDefault(); e.stopImmediatePropagation(); return;
        }
        if (!down || e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || menu()) return;
        const id = actionFor(e.code, "jeu");
        if (!id) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.repeat && held.has(e.code)) return;
        held.set(e.code, FIXED[id]); send(win, "keydown", FIXED[id]);
      };
      win.addEventListener("keydown", on, true);
      win.addEventListener("keyup", on, true);
      win.addEventListener("blur", () => { for (const k of held.values()) send(win, "keyup", k); held.clear(); });
    };
    const start = () => {
      const f = document.getElementById("dos");
      if (!f) return;
      hook(); f.addEventListener("load", hook);
    };
    if (document.readyState === "loading") addEventListener("DOMContentLoaded", start); else start();
  }

  // --- Fenêtre de réglage ---------------------------------------------------------------------------
  if (window !== window.top) return;
  const CSS = `
  #keys-open { position: fixed; right: 12px; bottom: 300px; z-index: 1000; font: 12px/1 system-ui, sans-serif; padding: 6px 10px;
    border: 1px solid #555; border-radius: 6px; background: rgba(0,0,0,.6); color: #ddd; cursor: pointer; }
  #keys-open:hover { background: #2a2217; }
  body:has(#mm:not(.hidden)) #keys-open { right: calc(var(--mm-w) + 12px); }
  @media (max-width: 800px) { #keys-open { right: 12px !important; } }
  #keys-dlg { width: min(520px, 94vw); max-height: 88vh; padding: 0; border: 1px solid #6d5a3a; border-radius: 10px; color-scheme: dark;
    background: #110e0a; color: #e8dcc0; font: 14px/1.4 system-ui, sans-serif; box-shadow: 0 20px 60px rgba(0,0,0,.7); }
  #keys-dlg[open] { display: flex; flex-direction: column; }
  #keys-dlg::backdrop { background: rgba(0, 0, 0, .65); }
  #keys-dlg .kh { display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px; border-bottom: 1px solid #3a3226; }
  #keys-dlg h2 { margin: 0; font-size: 20px; color: #c9a227; flex: 1; }
  #keys-dlg .kx { font-size: 18px; background: none; border: 0; color: #a39578; cursor: pointer; padding: 0 4px; }
  #keys-dlg .kb { overflow: auto; padding: 6px 16px 10px; }
  #keys-dlg h3 { margin: 12px 0 4px; font-size: 13px; color: #a39578; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  #keys-dlg .kr { display: grid; grid-template-columns: 1fr 100px 26px 112px; align-items: center; gap: 6px; padding: 3px 0; }
  #keys-dlg .kr button.kc { padding: 2px 0; background: none; border-color: transparent; color: #8a7f68; }
  #keys-dlg .kr button.kc:hover { color: #fff; border-color: #555; }
  #keys-dlg .kr button.kc:disabled { visibility: hidden; }
  #keys-dlg .kr button.none { color: #8a7f68; }
  #keys-dlg .kr button { font: 13px system-ui, sans-serif; padding: 4px 8px; border: 1px solid #555; border-radius: 5px;
    background: #1b1610; color: #fff; cursor: pointer; min-height: 26px; }
  #keys-dlg .kr button:hover { border-color: #c9a227; }
  #keys-dlg .kr button.wait { border-color: #c9a227; color: #c9a227; }
  #keys-dlg .kr button.changed { color: #f0d070; }
  #keys-dlg .kf { color: #8a7f68; font-size: 12px; }
  #keys-dlg .kn { color: #8a7f68; font-size: 12px; padding: 8px 16px 0; }
  #keys-dlg .kt { display: flex; align-items: center; gap: 10px; padding: 10px 16px 14px; border-top: 1px solid #3a3226; margin-top: 6px; }
  #keys-dlg .kt span { flex: 1; color: #a39578; font-size: 12px; }
  #keys-dlg .kt button { font: 13px system-ui, sans-serif; padding: 5px 10px; border: 1px solid #555; border-radius: 5px; background: none; color: #ddd; cursor: pointer; }`;
  function build() {
    const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
    const open = document.createElement("button");
    open.id = "keys-open"; open.type = "button"; open.textContent = "Touches…"; open.title = "Régler les touches du clavier";
    const dlg = document.createElement("dialog");
    dlg.id = "keys-dlg"; dlg.setAttribute("aria-label", "Touches du clavier");
    dlg.innerHTML = `<div class="kh"><h2>Touches du clavier</h2><button type="button" class="kx" title="Fermer (Échap)">✕</button></div>
      <div class="kn">Cliquer une touche puis appuyer sur la nouvelle (Échap : annuler). ✕ : aucune touche.
      Une touche déjà prise est retirée à l'action qui l'avait, qui reste sans touche.</div>
      <div class="kb"></div>
      <div class="kt"><span></span><button type="button" class="kreset">Touches par défaut</button></div>`;
    document.body.append(open, dlg);
    const body = dlg.querySelector(".kb"), status = dlg.querySelector(".kt span");
    let waiting = null;
    function render() {
      body.innerHTML = "";
      for (const [group, title, note] of [["jeu", "Jeu", "en plus de"], ["barre", "Barre d'actions", ""], ["page", "Page", ""]]) {
        if (!ACTIONS.some((q) => q.group === group)) continue;
        const h = document.createElement("h3"); h.textContent = title; body.appendChild(h);
        for (const a of ACTIONS.filter((q) => q.group === group)) {
          const row = document.createElement("div"); row.className = "kr";
          const l = document.createElement("span"); l.textContent = a.label;
          const b = document.createElement("button"); b.type = "button"; b.dataset.id = a.id;
          b.textContent = waiting === a.id ? "appuyer…" : codeOf(a.id) ? keyName(codeOf(a.id)) : "aucune";
          b.classList.toggle("wait", waiting === a.id); b.classList.toggle("changed", a.id in custom);
          b.classList.toggle("none", !codeOf(a.id));
          const x = document.createElement("button"); x.type = "button"; x.className = "kc"; x.dataset.clear = a.id;
          x.textContent = "✕"; x.title = "Aucune touche pour cette action"; x.disabled = !codeOf(a.id);
          if (a.id in custom) b.title = "Par défaut : " + keyName(a.def);
          const f = document.createElement("span"); f.className = "kf";
          f.textContent = note && FIXED_LABEL[a.id] ? `${note} ${FIXED_LABEL[a.id]}` : "";
          row.append(l, b, x, f); body.appendChild(row);
        }
      }
      status.textContent = SCUMM ? "Appliqué tout de suite, sauf dans le menu du jeu." : "Appliqué tout de suite.";
    }
    body.addEventListener("click", (e) => {
      const x = e.target.closest("button[data-clear]");
      if (x) { waiting = null; assign(x.dataset.clear, ""); render(); return; }
      const b = e.target.closest("button[data-id]");
      if (!b) return;
      waiting = waiting === b.dataset.id ? null : b.dataset.id; render();
    });
    const capture = (e) => {
      if (!dlg.open) return;
      e.stopPropagation();
      if (!waiting) return;            // Échap ferme la fenêtre
      e.preventDefault();
      if (["ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "MetaLeft", "MetaRight", "AltLeft"].includes(e.code)) return;
      if (e.code === "Escape") { waiting = null; render(); return; }
      const id = waiting; waiting = null;
      assign(id, e.code === "Delete" || e.code === "Backspace" ? "" : e.code);
      render();
    };
    dlg.addEventListener("keydown", capture);
    for (const ev of ["keyup", "keypress"]) dlg.addEventListener(ev, (e) => e.stopPropagation());
    dlg.addEventListener("cancel", (e) => { if (waiting) { e.preventDefault(); waiting = null; render(); } });
    dlg.querySelector(".kx").addEventListener("click", () => dlg.close());
    dlg.querySelector(".kreset").addEventListener("click", () => { reset(); waiting = null; render(); });
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener("close", () => { waiting = null; const f = document.getElementById("dos"); if (f && f.focus) f.focus(); });
    open.addEventListener("click", () => { render(); dlg.showModal(); open.blur(); });
    listeners.add(() => { if (dlg.open) render(); });
  }
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", build); else build();
})();
