// Volume général (versions DOSBox et ScummVM) : tout son WebAudio de la page passe par un gain
// commun, inséré entre les nœuds et la sortie (AudioContext.destination). Réglage mémorisé.
// La version ScummVM charge ce script dans la page du jeu (cadre) et dans la page principale :
// le curseur de la page principale règle aussi le gain du cadre.
(() => {
  "use strict";
  const KEY = "lolVolume";
  let vol = 1;
  try { const v = parseFloat(localStorage.getItem(KEY)); if (v >= 0 && v <= 1) vol = v; } catch (e) {}
  const gains = new Set();
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (typeof AudioDestinationNode !== "undefined" && dest instanceof AudioDestinationNode) {
      const ctx = dest.context;
      let g = ctx.__lolGain;
      if (!g) {
        g = ctx.__lolGain = ctx.createGain();
        g.gain.value = vol;
        connect.call(g, dest);
        gains.add(g);
      }
      if (this !== g) return connect.call(this, g, ...rest);
    }
    return connect.call(this, dest, ...rest);
  };
  window.lolSetVolume = (v) => {
    vol = Math.max(0, Math.min(1, v));
    gains.forEach((g) => { g.gain.value = vol; });
    try { localStorage.setItem(KEY, String(vol)); } catch (e) {}
  };
  window.lolGetVolume = () => vol;

  // Curseur de la page (s'il existe) : règle cette page et le cadre du jeu (version ScummVM)
  function bind() {
    const r = document.getElementById("vol-range");
    if (!r) return;
    const label = document.getElementById("vol-label");
    const show = () => { if (label) label.textContent = vol === 0 ? "🔇" : vol < 0.5 ? "🔉" : "🔊"; r.title = `Volume général : ${Math.round(vol * 100)} %`; };
    r.value = Math.round(vol * 100);
    show();
    r.addEventListener("input", () => {
      const v = r.value / 100;
      window.lolSetVolume(v);
      const f = document.querySelector("iframe#dos");
      try { if (f && f.contentWindow && f.contentWindow.lolSetVolume) f.contentWindow.lolSetVolume(v); } catch (e) {}
      show();
    });
    // rendre le clavier au jeu après le réglage (les flèches ne doivent pas rester sur le curseur)
    r.addEventListener("change", () => {
      r.blur();
      const f = document.querySelector("iframe#dos");
      if (f) f.focus();
    });
    if (label) label.addEventListener("click", () => { r.value = vol > 0 ? 0 : 100; r.dispatchEvent(new Event("input")); r.dispatchEvent(new Event("change")); });
  }
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", bind); else bind();
})();
