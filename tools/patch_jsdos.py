"""Ajoute aux workers de js-dos le canal « lol-mem » de lecture de la RAM émulée.

Usage : python3 -I tools/patch_jsdos.py web/public/emulators

Pour chaque variante (wdosbox.js, wdosbox-x.js, -jspi, -dbg) : garde l'original en
<nom>.orig.js (une seule fois), puis régénère le fichier modifié à partir de l'original.
La page lit la mémoire via LoLMem.RemoteMemory (web/public/memscan.js) ; voir
docs/retro-conception.md, § 12.1.
"""
import os, sys

VARIANTS = ["wdosbox.js", "wdosbox-x.js", "wdosbox-x-jspi.js", "wdosbox-x-dbg.js"]
HOOK = 'Module["HEAPU8"]=HEAPU8=new Uint8Array(b);'
MARK = "/* --- Ajout Lands of Lore"

CHANNEL = r'''
/* --- Ajout Lands of Lore (tools/patch_jsdos.py) : lecture de la RAM émulée depuis la page.
   La page envoie {id, ranges:[[adresse physique, longueur], …]} sur le canal « lol-mem » ;
   le worker répond {id, data:[Uint8Array…]}. L'émulateur reste dans son worker. */
;(function () {
  if (!globalThis.WorkerGlobalScope || typeof BroadcastChannel === "undefined") return;
  var ch = new BroadcastChannel("lol-mem"), base = -1, nextTry = 0;
  var SIG = [73, 66, 77, 32, 67, 79, 77, 80, 65, 84, 73, 66, 76, 69]; /* "IBM COMPATIBLE" */
  function findBase(h) {
    outer: for (var i = 0; i < h.length - SIG.length; i++) {
      if (h[i] !== SIG[0]) continue;
      for (var k = 1; k < SIG.length; k++) if (h[i + k] !== SIG[k]) continue outer;
      var b = i - 0xFE00E;
      if (b >= 0 && h[b + 0xFFFF0] === 0xEA && (h[b + 0x400] | h[b + 0x401] << 8) === 0x3F8) return b;
    }
    return -1;
  }
  ch.onmessage = function (e) {
    var m = globalThis.__lolModule, req = e.data;
    if (!m || !m.HEAPU8 || !req || !req.ranges) return;
    var h = m.HEAPU8;
    if (base < 0) {
      var now = Date.now();
      if (now < nextTry) { ch.postMessage({ id: req.id, error: "base" }); return; }
      nextTry = now + 2000;
      base = findBase(h);
      if (base < 0) { ch.postMessage({ id: req.id, error: "base" }); return; }
    }
    ch.postMessage({ id: req.id, data: req.ranges.map(function (r) { return h.slice(base + r[0], base + r[0] + r[1]); }) });
  };
})();
'''


def main(emu_dir):
    for name in VARIANTS:
        path = os.path.join(emu_dir, name)
        orig = path[:-3] + ".orig.js"
        if not os.path.exists(path):
            continue
        if not os.path.exists(orig):
            src = open(path, encoding="utf-8").read()
            if MARK in src:
                sys.exit(f"{name} est déjà modifié et {os.path.basename(orig)} manque : réinstaller js-dos")
            open(orig, "w", encoding="utf-8").write(src)
        src = open(orig, encoding="utf-8").read()
        if src.count(HOOK) != 1:
            sys.exit(f"{name} : point d'accroche introuvable (version de js-dos différente ?)")
        out = src.replace(HOOK, HOOK + "globalThis.__lolModule=Module;", 1) + CHANNEL
        open(path, "w", encoding="utf-8").write(out)
        print("modifié :", name)


if __name__ == "__main__":
    main(sys.argv[1])
