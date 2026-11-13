// Moteur d'émulation : affiche le moteur de la page (DOSBox ou ScummVM) et permet de basculer.
//   DOSBox  : index.html (web/public, port 8000 : web/serve.sh ; aussi servie par le serveur ScummVM)
//   ScummVM : lol.html   (web/scummvm, port 8001 : tools/scummvm_web.py)
// La page ScummVM est générée à partir de index.html et définit window.LOL_ENGINE = "scummvm".
(() => {
  "use strict";
  const SCUMMVM_PORT = 8001;
  const current = window.LOL_ENGINE === "scummvm" ? "scummvm" : "dosbox";
  const LABEL = { dosbox: "DOSBox", scummvm: "ScummVM" };
  const box = document.createElement("div");
  box.id = "engine";
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", "Moteur d'émulation");
  box.innerHTML = '<span class="eng-title">Moteur</span>' +
    Object.keys(LABEL).map((k) => `<button type="button" data-engine="${k}">${LABEL[k]}</button>`).join("");
  document.body.appendChild(box);

  const target = { dosbox: "index.html", scummvm: null };   // null : en cours de recherche
  const buttons = box.querySelectorAll("button");
  function render() {
    buttons.forEach((b) => {
      const k = b.dataset.engine, on = k === current;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on);
      b.disabled = !on && !target[k];
      b.title = on ? `Moteur actuel : ${LABEL[k]}`
        : target[k] ? `Basculer vers ${LABEL[k]} (les sauvegardes ne sont pas partagées entre les moteurs)`
        : k === "scummvm" ? `Serveur ScummVM non lancé : python3 -I tools/scummvm_web.py (port ${SCUMMVM_PORT})`
        : `${LABEL[k]} indisponible`;
    });
  }
  render();

  // Page ScummVM : même serveur si elle y est (serveur ScummVM), sinon le port 8001
  if (current === "dosbox") {
    fetch("lol.html", { method: "HEAD", cache: "no-store" })
      .then((r) => { if (r.ok) return "lol.html"; throw 0; })
      .catch(() => {
        const url = `${location.protocol}//${location.hostname}:${SCUMMVM_PORT}/lol.html`;
        return fetch(url, { mode: "no-cors", cache: "no-store" }).then(() => url, () => null);
      })
      .then((url) => { target.scummvm = url; render(); });
  }

  box.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    const k = b.dataset.engine;
    b.blur();
    if (k === current) return;
    if (!confirm(`Basculer vers ${LABEL[k]} ?\n\nLa partie en cours redémarre : sauvegarde d'abord dans le jeu. ` +
      "Chaque moteur garde ses propres sauvegardes.")) return;
    location.href = target[k];
  });
})();
