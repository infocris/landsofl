// Interface originale dans la vue 3D (version ScummVM ; docs/reverse-engineering.md § 10a).
// Mode « moderne » : barre d'actions et portraits flottants, vue 3D seule. Mode « originale » :
// la zone de la vue 3D montre l'écran du jeu en direct (flux vidéo du canevas de ScummVM,
// captureStream), et seule la fenêtre de scène du jeu (112, 0, 176 × 120) est remplacée par le
// rendu 3D (le cadre de la vue posé dessus). Les clics sur le reste de l'écran (portraits, sac,
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
  body.ui-classic #party-float, body.ui-classic #action-bar { display: none !important; }`;
  document.head.appendChild(css);

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
    if (m !== "originale") { frame.style.left = frame.style.top = frame.style.width = frame.style.height = ""; frame.classList.remove("off"); }
    dispatchEvent(new Event("resize"));
  }
  btn.addEventListener("click", () => { setMode(mode === "moderne" ? "originale" : "moderne"); btn.blur(); if (game.focus) game.focus(); });
  setMode(mode);

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
    if (video.readyState < 2 || !video.videoWidth) return;
    const g = cv.getContext("2d");
    g.imageSmoothingEnabled = false;
    g.fillStyle = "#000"; g.fillRect(0, 0, W, H);
    const V = fit(video.videoWidth, video.videoHeight);
    g.drawImage(video, V.x, V.y, V.w, V.h, L.x * dpr, L.y * dpr, L.w * dpr, L.h * dpr);
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
  window.lolClassic = () => ({ mode, layout, video: [video.videoWidth, video.videoHeight], frame: frame.getBoundingClientRect() });   // débogage
})();
