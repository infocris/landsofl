// Interface originale dans la vue 3D (version ScummVM ; docs/reverse-engineering.md § 10a).
// Mode « moderne » : barre d'actions et portraits flottants, vue 3D seule. Mode « originale » :
// l'interface du jeu est reconstruite dans la zone de la vue 3D : fond PLAYFLD.CPS, rendu 3D dans
// la fenêtre de scène (112, 0, 176 × 120 ; le cadre de la vue posé dessus), portraits redessinés,
// barre d'actions sur la rangée d'objets. Quelques éléments vivants sont repris de l'image du jeu
// (flux vidéo du canevas de ScummVM, captureStream) : messages, couronnes, boutons d'arme et de
// magie, et la scène du jeu quand il en montre une. Les clics sur le reste de l'écran (portraits, sac,
// flèches, boussole…) sont rejoués sur le canevas du jeu aux mêmes coordonnées : on joue entièrement
// depuis là. Pendant une scène du jeu (dialogue, lieu plein écran, menu, sort…), lolView() demande
// l'image du jeu : le rendu 3D s'efface. Choix gardé (localStorage « uiMode »).
(() => {
  "use strict";
  if (window.LOL_ENGINE !== "scummvm") return;
  const SCENE = [112, 0, 176, 120];
  const box = document.getElementById("v3d"), frame = document.getElementById("v3d-frame"), game = document.getElementById("dos");
  if (!box || !frame || !game) return;

  const css = document.createElement("style");
  css.textContent = `
  #ui-mode { position: fixed; right: 12px; bottom: 336px; z-index: 1000; font: 12px/1 system-ui, sans-serif; padding: 6px 10px;
    border: 1px solid #555; border-radius: 6px; background: rgba(0,0,0,.6); color: #ddd; cursor: pointer; }
  #ui-mode:hover { background: #2a2217; }
  body:has(#mm:not(.hidden)) #ui-mode { right: calc(var(--mm-w) + 12px); }
  @media (max-width: 800px) { #ui-mode { right: 12px !important; } }
  #v3d-classic { position: absolute; inset: 0; width: 100%; height: 100%; display: none; image-rendering: pixelated; cursor: default; }
  body.ui-classic #v3d-classic { display: block; }
  body.ui-classic #v3d-frame { position: absolute; z-index: 1; }
  body.ui-classic #v3d-frame.off { visibility: hidden; }
  body.ui-classic #party-float { display: none !important; }
  /* barre d'actions ancrée sur la rangée d'objets du jeu (9 cases : x = 106 + 21 i, y = 179) */
  body.ui-classic #action-bar { position: absolute; z-index: 2; padding: 0; gap: 0; border: 0; border-radius: 0; background: none; box-shadow: none; }
  body.ui-classic #action-bar .grip { display: none; }
  body.ui-classic #action-bar .ab { border-radius: 1px; border-color: #5a4a30; font-size: 9px; }
  body.ui-classic #action-bar .ab .k { font-size: 9px; }
  body.ui-classic #action-bar .ab .atk { font-size: 7px; gap: 0; overflow: hidden; }
  body.ui-classic #action-bar .ab .atk b { font-size: 11px; }`;
  document.head.appendChild(css);

  // portraits du groupe redessinés (comme gui_drawCharPortraitWithStats) : visage (faces.png,
  // image choisie comme gui_drawCharFaceShape), barres verticales de magie (M) et de vie (V)
  const faces = new Image();
  faces.src = "viewer/data/faces.png?v=20261123a";
  let party = [];
  const mem = window.LoLMem ? new LoLMem.RemoteMemory() : null;
  setInterval(async () => {
    if (mode !== "originale" || !mem) return;
    const r = await mem.read([[0x3389F - 2, 4 * 130]]);
    if (!r) return;
    const b = r[0], out = [];
    for (let i = 0; i < 4; i++) {
      const o = i * 130, u16 = (k) => b[o + k] | b[o + k + 1] << 8, s16 = (k) => (u16(k) << 16) >> 16;
      const flags = u16(0);
      if (!(flags & 1)) continue;
      const id = Math.abs(s16(14)), cur = b[o + 16], temp = b[o + 17];
      const hp = s16(57), hpMax = u16(59), mp = s16(61), mpMax = u16(63);
      let f = cur < 7 && temp ? temp : temp === 0 && cur > 1 && cur < 7 ? 0 : cur;
      if (flags & 0x1108 && f < 7) f = 1;
      if (hp <= hpMax >> 1) f += 14;
      out.push({ id, f: Math.max(0, Math.min(27, f)), hp, hpMax, mp, mpMax, ko: !!(flags & 8) });
    }
    party = out;
  }, 200);
  function drawPortraits(g, L, dpr, live) {
    const n = party.length;
    if (!n || !faces.complete || !faces.naturalWidth) return;
    const kx = L.w / 320 * dpr, ky = L.h / 200 * dpr, ox = L.x * dpr, oy = L.y * dpr;
    const t = Math.floor((235 - n * 66) / (n + 1));
    const R = (x, y, w, h, c) => { g.fillStyle = c; g.fillRect(ox + x * kx, oy + y * ky, w * kx, h * ky); };
    party.forEach((c, i) => {
      const x = i * 66 + t * (i + 1) + 83, y = 143;
      R(x, y, 66, 34, "#000");
      g.drawImage(faces, c.f * 32, (Math.min(9, Math.max(1, c.id)) - 1) * 32, 32, 32, ox + x * kx, oy + (y + 1) * ky, 32 * kx, 32 * ky);
      live(x + 44, y, 22, 34);                    // boutons d'arme et de magie (main, recharge) : ceux du jeu
      if (c.ko) R(x, y + 1, 32, 32, "rgba(40,40,40,.55)");
      const bar = (bx, cur, max, col) => {
        R(x + bx - 1, y + 1, 6, 32, "#000");
        const q = max > 0 ? Math.max(0, Math.min(1, cur / max)) : 0, hh = Math.max(q > 0 ? 1 : 0, Math.round(31 * q));
        if (hh) R(x + bx, y + 32 - hh, 5, hh, col);
      };
      bar(33, c.mp, c.mpMax, "#3c5cd8");
      const q = c.hpMax > 0 ? c.hp / c.hpMax : 0;
      bar(39, c.hp, c.hpMax, q < 0.25 ? "#d83c2c" : q < 0.5 ? "#e0c030" : "#3cb83c");
      g.fillStyle = "#fff"; g.font = `bold ${Math.round(6 * ky)}px system-ui, sans-serif`; g.textBaseline = "top";
      g.fillText("M", ox + (x + 33) * kx, oy + (y + 1.5) * ky); g.fillText("V", ox + (x + 39) * kx, oy + (y + 1.5) * ky);
    });
  }

  // fond de l'interface (PLAYFLD.CPS exporté) : l'écran du jeu n'est plus recopié en entier ;
  // seuls quelques éléments vivants en sont repris (zones en coordonnées du jeu)
  const bg = new Image();
  bg.src = "viewer/data/playfld.png?v=20261123a";
  const LIVE = [
    [84, 121, 204, 18],          // bande des messages
    [288, 90, 32, 40],           // pile de couronnes (nombre au-dessus)
  ];
  const cv = document.createElement("canvas");
  cv.id = "v3d-classic";
  box.insertBefore(cv, frame);
  const btn = document.createElement("button");
  btn.id = "ui-mode"; btn.type = "button";
  btn.title = "Interface moderne (barre d'actions, portraits flottants) ou interface originale du jeu autour de la vue 3D";
  document.body.appendChild(btn);

  let mode = "moderne";
  try { mode = localStorage.getItem("uiMode") === "originale" ? "originale" : "moderne"; } catch (e) {}
  function setMode(m) {
    mode = m;
    try { localStorage.setItem("uiMode", m); } catch (e) {}
    btn.textContent = "Interface : " + m;
    document.body.classList.toggle("ui-classic", m === "originale");
    if (m !== "originale") { frame.style.left = frame.style.top = frame.style.width = frame.style.height = ""; frame.classList.remove("off"); if (typeof undock === "function") undock(); }
    dispatchEvent(new Event("resize"));
  }
  btn.addEventListener("click", () => { setMode(mode === "moderne" ? "originale" : "moderne"); btn.blur(); if (game.focus) game.focus(); });

  // flux vidéo du canevas du jeu
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true;
  let stream = null;
  const gameWin = () => { try { return game.contentWindow; } catch (e) { return null; } };
  const gameCanvas = () => { const w = gameWin(); try { return w && w.document.getElementById("canvas"); } catch (e) { return null; } };
  // écran du jeu (320 × 200, affiché en 4:3 par la correction d'aspect) dans une surface w × h
  function fit(w, h) {
    const R = 4 / 3;
    const aw = w / h > R ? h * R : w, ah = aw / R;
    return { x: (w - aw) / 2, y: (h - ah) / 2, w: aw, h: ah };
  }
  let layout = null;                      // position de l'écran du jeu dans la zone (pixels CSS)
  function tick() {
    requestAnimationFrame(tick);
    if (mode !== "originale" || box.classList.contains("hidden")) return;
    const src = gameCanvas();
    if (!src) return;
    if (!stream || stream.__canvas !== src) {
      try { stream = src.captureStream(30); stream.__canvas = src; video.srcObject = stream; video.play().catch(() => {}); } catch (e) { return; }
    }
    const dpr = window.devicePixelRatio || 1, BW = box.clientWidth, BH = box.clientHeight;
    const W = Math.round(BW * dpr), H = Math.round(BH * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const L = fit(BW, BH);
    layout = L;
    // fenêtre de scène : le cadre de la vue 3D posé dessus
    const sx = L.x + SCENE[0] / 320 * L.w, sy = L.y + SCENE[1] / 200 * L.h, sw = SCENE[2] / 320 * L.w, sh = SCENE[3] / 200 * L.h;
    const px = (v) => Math.round(v) + "px";
    if (frame.style.left !== px(sx) || frame.style.width !== px(sw) || frame.style.top !== px(sy) || frame.style.height !== px(sh)) {
      frame.style.left = px(sx); frame.style.top = px(sy); frame.style.width = px(sw); frame.style.height = px(sh);
    }
    let st = null;
    try { const w = gameWin(); st = w && w.lolView ? w.lolView() : null; } catch (e) {}
    const showGameScene = !st || (st.mirror && !st.overlay) || !(gameWin() && gameWin().lolStarted && gameWin().lolStarted());
    frame.classList.toggle("off", showGameScene);
    if (video.readyState < 2 || !video.videoWidth || !bg.complete || !bg.naturalWidth) return;
    const g = cv.getContext("2d");
    g.imageSmoothingEnabled = false;
    g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
    const V = fit(video.videoWidth, video.videoHeight);
    // région du jeu (x, y, w, h en pixels du jeu) recopiée depuis son image
    const live = (x, y, w, h) => g.drawImage(video, V.x + x / 320 * V.w, V.y + y / 200 * V.h, w / 320 * V.w, h / 200 * V.h,
      (L.x + x / 320 * L.w) * dpr, (L.y + y / 200 * L.h) * dpr, w / 320 * L.w * dpr, h / 200 * L.h * dpr);
    g.drawImage(bg, 0, 0, 320, 200, L.x * dpr, L.y * dpr, L.w * dpr, L.h * dpr);
    if (showGameScene) {
      // scène du jeu (dialogue, lieu, menu, introduction) : la région qu'il demande, ou tout l'écran
      const c = st && st.crop ? st.crop : [0, 0, 320, 200];
      live(...c);
    }
    for (const r of LIVE) live(...r);
    if (!showGameScene || !(st && st.crop && st.crop[2] >= 320)) drawPortraits(g, L, dpr, live);
    dockBar(L);
  }
  // barre d'actions sur la rangée d'objets du jeu (cachée pendant les scènes : celle du jeu reste visible)
  let dockKey = "";
  function dockBar(L) {
    const bar = document.getElementById("action-bar");
    if (!bar) return;
    if (bar.parentNode !== box) box.appendChild(bar);
    const step = 21 / 320 * L.w, size = Math.floor(step - 1), x = L.x + 106 / 320 * L.w, y = L.y + 179 / 200 * L.h;
    const key = [Math.round(x), Math.round(y), size].join();
    if (key === dockKey) return;
    dockKey = key;
    bar.style.left = Math.round(x) + "px"; bar.style.top = Math.round(y) + "px";
    bar.style.gap = (step - size) + "px";
    bar.style.setProperty("--ab-size", size + "px");
    if (window.lolActionBarRefresh) window.lolActionBarRefresh();
  }
  function undock() {
    const bar = document.getElementById("action-bar");
    if (!bar) return;
    dockKey = "";
    bar.style.removeProperty("--ab-size"); bar.style.gap = "";
    if (bar.parentNode !== document.body) document.body.appendChild(bar);
    if (window.lolActionBarRefresh) window.lolActionBarRefresh();
    dispatchEvent(new Event("resize"));
  }
  requestAnimationFrame(tick);

  // clics et mouvements sur l'interface : rejoués sur le canevas du jeu aux mêmes coordonnées
  function forward(type, e) {
    const src = gameCanvas();
    if (!src || !layout) return;
    const r = box.getBoundingClientRect();
    const gx = (e.clientX - r.left - layout.x) / layout.w, gy = (e.clientY - r.top - layout.y) / layout.h;
    if (gx < 0 || gx > 1 || gy < 0 || gy > 1) return;
    const cr = src.getBoundingClientRect(), A = fit(cr.width, cr.height);
    const x = cr.left + A.x + gx * A.w, y = cr.top + A.y + gy * A.h;
    const W = gameWin();
    src.dispatchEvent(new W.MouseEvent(type, { clientX: x, clientY: y, screenX: x, screenY: y, button: e.button, buttons: e.buttons, bubbles: true, cancelable: true, view: W }));
  }
  cv.addEventListener("mousemove", (e) => forward("mousemove", e));
  cv.addEventListener("mousedown", (e) => { e.preventDefault(); forward("mousedown", e); });
  cv.addEventListener("mouseup", (e) => { forward("mouseup", e); if (game.focus) game.focus(); });
  cv.addEventListener("contextmenu", (e) => e.preventDefault());
  setMode(mode);
  window.lolClassic = () => ({ mode, layout, video: [video.videoWidth, video.videoHeight], frame: frame.getBoundingClientRect() });   // débogage
})();
