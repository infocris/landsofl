// Fenêtre « Options » (docs/reverse-engineering.md § 10a) : afficher ou cacher les options de
// triche de la page (vie et magie infinies, attaque auto, couronnes, déblocages, création et
// destruction d'objets, montée de niveau, compagnons, téléportation). Cachées, celles qui étaient
// actives sont coupées, pour qu'aucune triche ne reste en marche sans être visible.
// Choix gardé (localStorage « showCheats »).
(() => {
  "use strict";
  const css = document.createElement("style");
  css.textContent = `
  #opt-open { position: fixed; right: 12px; bottom: 372px; z-index: 1000; font: 12px/1 system-ui, sans-serif; padding: 6px 10px;
    border: 1px solid #555; border-radius: 6px; background: rgba(0,0,0,.6); color: #ddd; cursor: pointer; }
  #opt-open:hover { background: #2a2217; }
  body:has(#mm:not(.hidden)) #opt-open { right: calc(var(--mm-w) + 12px); }
  @media (max-width: 800px) { #opt-open { right: 12px !important; } }
  #opt-dlg { width: min(420px, 94vw); padding: 0; border: 1px solid #6d5a3a; border-radius: 10px; color-scheme: dark;
    background: #110e0a; color: #e8dcc0; font: 14px/1.4 system-ui, sans-serif; box-shadow: 0 20px 60px rgba(0,0,0,.7); }
  #opt-dlg::backdrop { background: rgba(0, 0, 0, .65); }
  #opt-dlg .oh { display: flex; align-items: center; padding: 14px 16px 10px; border-bottom: 1px solid #3a3226; }
  #opt-dlg h2 { margin: 0; font-size: 20px; color: #c9a227; flex: 1; }
  #opt-dlg .ox { font-size: 18px; background: none; border: 0; color: #a39578; cursor: pointer; }
  #opt-dlg .ob { padding: 12px 16px 16px; }
  #opt-dlg label { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; }
  #opt-dlg input { accent-color: #c9a227; margin-top: 3px; }
  #opt-dlg small { display: block; color: #8a7f68; font-size: 12px; margin-top: 2px; }
  /* triches cachées */
  body.no-cheats #cheats, body.no-cheats #inv-clear, body.no-cheats #inv-add, body.no-cheats #cat-open,
  body.no-cheats .lvup, body.no-cheats #st-party, body.no-cheats #cat-list .add, body.no-cheats #inv-detail .acts .del,
  body.no-cheats #sp-learn, body.no-cheats #auto-cfg { display: none !important; }`;
  document.head.appendChild(css);

  const open = document.createElement("button");
  open.id = "opt-open"; open.type = "button"; open.textContent = "Options…"; open.title = "Options de la page";
  const dlg = document.createElement("dialog");
  dlg.id = "opt-dlg"; dlg.setAttribute("aria-label", "Options");
  dlg.innerHTML = `<div class="oh"><h2>Options</h2><button type="button" class="ox" title="Fermer (Échap)">✕</button></div>
    <div class="ob"><label><input type="checkbox" id="opt-cheats"><span>Afficher les options de triche
      <small>Vie et magie infinies, attaque auto, couronnes, déblocages, création et destruction d'objets, montée de niveau,
      compagnons, téléportation sur la carte. Cachées, les triches actives sont coupées.</small></span></label></div>`;
  document.body.append(open, dlg);
  const box = dlg.querySelector("#opt-cheats");

  let shown = true;
  try { shown = localStorage.getItem("showCheats") !== "off"; } catch (e) {}
  function apply() {
    document.body.classList.toggle("no-cheats", !shown);
    box.checked = shown;
    if (!shown) for (const id of ["cheat-hp", "cheat-mp", "cheat-auto"]) {
      const c = document.getElementById(id);
      if (c && c.checked) c.click();                 // coupe la triche (la page renvoie l'état au jeu)
    }
  }
  box.addEventListener("change", () => {
    shown = box.checked;
    try { localStorage.setItem("showCheats", shown ? "on" : "off"); } catch (e) {}
    apply();
  });
  open.addEventListener("click", () => { open.blur(); dlg.showModal(); });
  dlg.querySelector(".ox").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener("close", () => { const f = document.getElementById("dos"); if (f && f.focus) f.focus(); });
  for (const ev of ["keydown", "keyup", "keypress"]) dlg.addEventListener(ev, (e) => e.stopPropagation());
  window.lolCheatsShown = () => shown;
  // les cases de triche peuvent être cochées par la page après son chargement (réglages gardés) : on
  // recoupe un peu plus tard si les triches sont cachées
  apply();
  setTimeout(apply, 3000);
})();
