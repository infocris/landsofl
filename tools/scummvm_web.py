"""ScummVM web (WebAssembly), à part de la version DOSBox : prépare le jeu et sert la page.

Le site ScummVM est versionné dans web/scummvm (comme les émulateurs de la version DOSBox dans
web/public/emulators) : scummvm.wasm/.js, données de ScummVM, licences (doc/), pages générées.
Origine exacte : web/scummvm/VERSION.txt. Les fichiers du jeu (data/games) ne sont pas versionnés.

Recompiler (facultatif) : dans third_party/scummvm (clone de github.com/scummvm/scummvm, branche
locale lol-web = commit noté dans VERSION.txt + tools/scummvm/lol-web-state.patch), moteur Kyra seul
(voir docs/retro-conception.md, § 10 bis) :
  ./dists/emscripten/build.sh setup configure make dist --disable-all-engines --enable-engine=kyra,lol
puis copier le résultat dans web/scummvm : python3 -I tools/scummvm_web.py import

ScummVM attend la disposition du CD d'origine : fichiers de l'intro dans un dossier par langue
(FRE/GENERAL.PAK, FRE/STARTUP.PAK, INTRO1-9.PAK…). L'installation (extracted-cd/app/C/LOLCD)
les a mis à plat et a séparé les polices de l'intro dans STARTIN.PAK. On construit donc, dans
web/scummvm/data/games/lol, des liens vers les fichiers du jeu, plus un dossier FRE/ dont
le STARTUP.PAK réunit STARTUP.PAK et STARTIN.PAK. Le dossier du jeu n'est pas modifié.

Déplacements ZQSD : le scummvm.ini servi (copié dans le navigateur au premier lancement, puis
gardé dans IndexedDB) déclare la cible « lol-fr » et ajoute aux actions de déplacement du jeu
(clavier « lolkeyb » de ScummVM) les touches aux positions ZQSD d'un clavier AZERTY : Z avancer,
S reculer, Q / D tourner, A / E pas de côté, en plus des touches d'origine. Le jeu désactive lui-même ce clavier pendant la
saisie d'un nom de sauvegarde (gui_lol.cpp), et ses actions ne servent qu'en exploration.

Le navigateur ne télécharge scummvm.ini qu'une fois : s'il en garde déjà un (IndexedDB, base
« /home/web_user »), la cible lol-fr peut y manquer et ScummVM s'arrête (exit 1). La page
lol-game.html, générée à partir de scummvm.html, remplace donc la section [lol-fr] du fichier gardé
par celle du serveur avant de charger scummvm.js. Le reste du fichier (réglages) est conservé.

Mini-carte, vue 3D et panneau, comme la version DOSBox : le moteur, modifié par
tools/scummvm/lol-web-state.patch (déjà compilé dans web/scummvm/scummvm.wasm),
publie toutes les 150 ms l'état du jeu rangé comme dans la mémoire du jeu DOS, aux mêmes
adresses (grille, monstres, objets, groupe, drapeaux…). La page du jeu (lol-game.html) répond
avec ces octets sur le canal « lol-mem », comme l'émulateur DOSBox : minimap.js fonctionne sans
changement. La page lol.html reprend web/public/index.html (panneau, vue 3D), avec ScummVM dans
un cadre à la place de js-dos. Les fichiers absents de web/scummvm sont servis depuis web/public.
L'inventaire et les triches passent par des commandes exécutées par le moteur (déplacer, supprimer,
créer, vie / magie infinies, couronnes) : pas d'écriture directe en mémoire.

Usage : python3 -I tools/scummvm_web.py [port]   (8001 par défaut)
        python3 -I tools/scummvm_web.py import   (copie un nouveau build dans web/scummvm)
Puis : http://localhost:8001/lol.html  (jeu seul : lol-game.html)
"""
import datetime, functools, http.server, json, os, re, shutil, struct, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from pak import read_pak

GAME = os.path.join(ROOT, "extracted-cd", "app", "C", "LOLCD")
SVM = os.path.join(ROOT, "third_party", "scummvm")
BUILD = os.path.join(SVM, "build-emscripten")
SITE = os.path.join(ROOT, "web", "scummvm")          # version servie et versionnée
DEST = os.path.join(SITE, "data", "games", "lol")
PATCH = os.path.join(ROOT, "tools", "scummvm", "lol-web-state.patch")
PUBLIC = os.path.join(ROOT, "web", "public")
INTRO = ["GENERAL.PAK", "INTROVOC.PAK", "INTRO1.PAK", "INTRO2.PAK", "INTRO3.PAK", "INTRO4.PAK", "INTRO5.PAK",
         "INTRO6.PAK", "INTRO7.PAK", "INTRO8.PAK", "INTRO9.PAK", "HISTORY.PAK"]


def link(src, dst):
    if os.path.lexists(dst):
        os.remove(dst)
    os.symlink(src, dst)


def write_pak(path, files):
    """PAK Westwood : (décalage u32, nom\\0)…, puis (taille du fichier u32, \\0), puis les données."""
    head_size = sum(4 + len(n) + 1 for n in files) + 5
    head, body, off = b"", b"", head_size
    for n, d in files.items():
        head += struct.pack("<I", off) + n.encode("latin-1") + b"\0"
        body += d
        off += len(d)
    with open(path, "wb") as f:
        f.write(head + struct.pack("<I", off) + b"\0" + body)


# Touches ajoutées aux actions de déplacement (identifiants des actions : engines/kyra/engine/lol.cpp)
# ScummVM web lit la position physique des touches avec des noms QWERTY : sur un clavier AZERTY,
# Z arrive comme « w », Q comme « a », A comme « q ». On nomme donc les touches en QWERTY pour
# garder les positions ZQSD (comme la version DOSBox, qui se fonde sur event.code).
# Q / D (AZERTY) tournent, A / E font un pas de côté (choix de l'utilisateur, 2026-11-09).
ZQSD = {"MVF": "UP w", "MVB": "DOWN s", "TL": "HOME a", "TR": "PAGEUP d", "SLL": "LEFT q", "SLR": "RIGHT e"}
TARGET = "lol-fr"


def write_ini():
    lines = ["[scummvm]", "", f"[{TARGET}]", "gameid=lol", "engineid=kyra",
             "description=Lands of Lore: The Throne of Chaos (CD/DOS/French)",
             "path=/data/games/lol", "language=fr", "platform=pc"]
    lines += [f"keymap_lolkeyb_{a}={keys}" for a, keys in ZQSD.items()]
    with open(os.path.join(SITE, "scummvm.ini"), "w") as f:
        f.write("\n".join(lines) + "\n")


# Lanceur : met à jour la section [lol-fr] du scummvm.ini gardé par le navigateur, puis charge ScummVM
LAUNCH_JS = r"""<script src="volume.js"></script>
<script>
// SDL3 (emscripten) s'abonne au clavier de window à chaque création de fenêtre sans retirer l'abonnement
// précédent : un appui arrive plusieurs fois (le jeu voit des répétitions : Échap ouvre puis referme le
// menu, lettres en double dans les noms de sauvegarde). Seul le dernier abonnement (fenêtre active) est
// appelé ; les anciens, liés à des fenêtres détruites, n'envoient pas le texte tapé.
(() => {
  const KEY = new Set(["keydown", "keyup", "keypress"]), live = window.__sdlKeyHandlers = {}, wrap = new WeakMap();
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opt) {
    if (this !== window || !KEY.has(type) || typeof fn !== "function" || !/scummvm\.js/.test(new Error().stack || ""))
      return add.call(this, type, fn, opt);                      // seuls les abonnements de ScummVM (SDL) sont filtrés
    const list = live[type] = live[type] || [];
    let w = wrap.get(fn);
    if (!w) { w = function (e) { if (list[list.length - 1] === fn) return fn.call(this, e); }; wrap.set(fn, w); }
    list.push(fn);
    return add.call(this, type, w, opt);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opt) {
    if (this === window && KEY.has(type) && wrap.has(fn)) {
      const list = live[type] || [], i = list.lastIndexOf(fn);
      if (i >= 0) list.splice(i, 1);
      return rem.call(this, type, wrap.get(fn), opt);
    }
    return rem.call(this, type, fn, opt);
  };
})();
(() => {
  if (!location.hash) history.replaceState(null, "", "#__TARGET__");
  const DB = "/home/web_user", KEY = DB + "/scummvm.ini", SEC = "[__TARGET__]";
  const start = () => { const s = document.createElement("script"); s.src = "scummvm.js"; document.body.appendChild(s); };
  const section = (t) => { const i = t.indexOf(SEC); if (i < 0) return ""; const j = t.indexOf("\n[", i + 1); return j < 0 ? t.slice(i) : t.slice(i, j + 1); };
  fetch("scummvm.ini", { cache: "no-store" }).then((r) => r.text()).then((ini) => new Promise((done) => {
    const ours = section(ini);
    const req = indexedDB.open(DB);
    req.onupgradeneeded = () => req.transaction.abort();          // pas encore de réglages : ScummVM téléchargera le fichier
    req.onerror = () => done();
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("FILE_DATA")) { db.close(); return done(); }
      const st = db.transaction("FILE_DATA", "readwrite").objectStore("FILE_DATA");
      const get = st.get(KEY);
      get.onsuccess = () => {
        const rec = get.result;
        if (rec && rec.contents && ours) {
          const old = new TextDecoder().decode(rec.contents);
          const cur = section(old);
          const txt = cur ? old.replace(cur, ours) : old.replace(/\n*$/, "\n\n") + ours;
          if (txt !== old) st.put({ ...rec, timestamp: new Date(), contents: new TextEncoder().encode(txt) }, KEY);
        }
      };
      st.transaction.oncomplete = st.transaction.onerror = () => { db.close(); done(); };
    };
  })).catch(() => {}).then(start);
})();
// Mémoire du jeu pour la mini-carte : le moteur (lol-web-state.patch) envoie des zones
// (adresse u32, longueur u32, octets) ; on répond aux lectures du canal « lol-mem » comme
// l'émulateur DOSBox (zéros hors des zones). Recherches : rien trouvé ; écritures : refusées.
(() => {
  let zones = null;
  // État d'affichage du jeu (débogage ; la page ne recopie plus l'image du jeu dans la vue 3D,
  // à la demande de l'utilisateur, 2026-11-10). Ce que serait la zone à montrer :
  // - copie de l'image du jeu (mirror) : introduction, lieux plein écran, dialogues, séquences ;
  //   seulement la fenêtre de scène (112, 0, 176 × 120 : la vue), sauf séquence plein écran ;
  // - superposition (overlay) : la vue 3D reste affichée et seuls les pixels que l'animation
  //   ajoute à la fenêtre de scène (sorts, effets) sont dessinés par-dessus ; pendant un sort
  //   (_webCasting) ou quand la boucle principale est arrêtée depuis 0,5 s hors dialogue ;
  // - rien : exploration, menu, changement de niveau.
  const view = { loops: -1, at: 0, scene: false, upd: 0, seq: [0, 0, 0, 0], menu: false, loading: false, casting: false };
  const SCENE = [112, 0, 176, 120];
  window.lolView = () => {
    if (!zones || view.loops <= 0) return { mirror: true, crop: [0, 0, 320, 200] };   // avant la partie (introduction)
    if (view.menu || view.loading) return { mirror: false };
    if (view.casting) return { mirror: true, overlay: true, crop: SCENE };
    const special = view.scene || (view.upd & 1), stale = performance.now() - view.at > 500;
    const [x1, y1, x2, y2] = view.seq;
    if (special && x2 > x1 && y2 > y1) {
      if (x2 - x1 >= 320) return { mirror: true, crop: [0, 0, 320, Math.min(200, y2 - y1 || 200)] };   // plein écran
      return { mirror: true, crop: [x1, y1, x2 - x1, y2 - y1] };
    }
    if (special) return { mirror: true, crop: SCENE };
    if (stale) return { mirror: true, overlay: true, crop: SCENE };
    return { mirror: false };
  };
  Module.lolCmdDone = (id, code) => ch.postMessage({ id, data: { code } });
  Module.lolState = (bytes) => {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = [];
    for (let o = 0; o + 8 <= bytes.length; ) {
      const a = dv.getUint32(o, true), n = dv.getUint32(o + 4, true);
      out.push([a, bytes.subarray(o + 8, o + 8 + n)]); o += 8 + n;
    }
    zones = out;
    // affichage (zone 0x7F000100) : scène spéciale, _updateFlags, fenêtre de séquence, menu, tours de boucle
    const z = out.find((q) => q[0] === 0x7F000100);
    if (z && z[1].length >= 18) {
      const b = z[1], w = (o) => b[o] | b[o + 1] << 8;
      const loops = (b[12] | b[13] << 8 | b[14] << 16) + b[15] * 16777216;
      if (loops !== view.loops) { view.loops = loops; view.at = performance.now(); }
      view.scene = !!b[0]; view.upd = w(1); view.seq = [w(3), w(5), w(7), w(9)]; view.menu = !!b[11]; view.loading = !!b[16]; view.casting = !!b[17];
    }
  };
  const ch = new BroadcastChannel("lol-mem");
  ch.onmessage = (e) => {
    const d = e.data;
    if (!d || !d.id) return;
    if (d.ranges && zones) {
      const data = d.ranges.map(([a, n]) => {
        const buf = new Uint8Array(n);
        for (const [za, zb] of zones) {
          const s = Math.max(a, za), t = Math.min(a + n, za + zb.length);
          if (s < t) buf.set(zb.subarray(s - za, t - za), s - a);
        }
        return buf;
      });
      ch.postMessage({ id: d.id, data });
    } else if (d.find && zones) ch.postMessage({ id: d.id, found: d.find.map(() => -1) });
    else if (d.cmd && zones) {
      // commandes d'inventaire : exécutées par le moteur dans sa boucle (webRunCommands)
      const op = { move: 1, delete: 2, create: 3, goto: 4, cheat: 5, money: 6, hurt: 7, spend: 8, cast: 9, levelup: 10, learn: 11, volume: 12 }[d.cmd.op] || 0;
      (Module.lolCmds = Module.lolCmds || []).push([op, d.cmd.a | 0, d.cmd.b | 0, d.id]);
    }
    else ch.postMessage({ id: d.id, error: zones ? "non disponible avec ScummVM" : "jeu pas encore lancé" });
  };
})();
</script>"""

# Page principale : celle de la version DOSBox (web/public/index.html), ScummVM dans un cadre
PAGE_JS = r"""<script>
window.LOL_ENGINE = "scummvm";   // minimap.js : inventaire géré par commandes au moteur
(() => {
  // Mini-carte et vue 3D : affichage mémorisé (mêmes réglages que la version DOSBox)
  const mm = document.getElementById("mm"), v3d = document.getElementById("v3d");
  const game = document.getElementById("dos");
  function toggle(el, key, force) {
    const show = force !== undefined ? force : el.classList.contains("hidden");
    el.classList.toggle("hidden", !show);
    try { localStorage.setItem(key, show ? "on" : "off"); } catch (e) {}
    window.dispatchEvent(new Event("resize"));
  }
  try { if (localStorage.getItem("minimap") === "off") mm.classList.add("hidden"); } catch (e) {}
  try { if (localStorage.getItem("view3d") === "off") v3d.classList.add("hidden"); } catch (e) {}
  const toggleMap = (f) => toggle(mm, "minimap", f), toggle3d = (f) => toggle(v3d, "view3d", f);
  // Boutons : on rend ensuite la main au jeu (sinon le clavier reste sur la page)
  const back = (e) => { e.currentTarget.blur(); game.focus(); };
  document.getElementById("mmtoggle").addEventListener("click", (e) => { toggleMap(); back(e); });
  document.getElementById("v3dtoggle").addEventListener("click", (e) => { toggle3d(); back(e); });
  // F9 / F10 aussi depuis le jeu (le cadre a le clavier) : écouteur ajouté dans sa fenêtre
  const keys = (e) => {
    if (e.code === "F9") { toggleMap(); e.preventDefault(); e.stopPropagation(); }
    if (e.code === "F10") { toggle3d(); e.preventDefault(); e.stopPropagation(); }
  };
  addEventListener("keydown", keys, true);
  game.addEventListener("load", () => { try { game.contentWindow.addEventListener("keydown", keys, true); } catch (e) {} game.focus(); });
  // Perspective de la vue 3D : « jeu » ou « réelle »
  const perspBtn = document.getElementById("persp");
  let perspMode = "jeu";
  try { perspMode = localStorage.getItem("persp") || "jeu"; } catch (e) {}
  function sendPersp() {
    perspBtn.textContent = "Perspective : " + (perspMode === "jeu" ? "jeu" : "réelle");
    const f = document.getElementById("v3d-frame");
    if (f && f.contentWindow) f.contentWindow.postMessage({ type: "lol-persp", mode: perspMode }, location.origin);
  }
  perspBtn.addEventListener("click", (e) => {
    perspMode = perspMode === "jeu" ? "reelle" : "jeu";
    try { localStorage.setItem("persp", perspMode); } catch (err) {}
    sendPersp(); back(e);
  });
  document.getElementById("v3d-frame").addEventListener("load", sendPersp);
  sendPersp();
})();
</script>"""

PAGE_CSS = """<style>
  /* version ScummVM : jeu dans un cadre ; inventaire et triches par commandes au moteur */
  iframe#dos { border: 0; display: block; width: 100%; background: #000; }
  #zqsd, #qload { display: none !important; }
</style>
</head>"""


def write_launcher():
    html = open(os.path.join(SITE, "scummvm.html"), encoding="utf-8").read()
    tag = "<script async src=scummvm.js></script>"
    if tag not in html:
        sys.exit("scummvm.html : balise de chargement de scummvm.js introuvable.")
    html = html.replace(tag, LAUNCH_JS.replace("__TARGET__", TARGET))
    html = html.replace("<title>ScummVM</title>", "<title>Lands of Lore (ScummVM)</title>")
    open(os.path.join(SITE, "lol-game.html"), "w", encoding="utf-8").write(html)


def write_page():
    """lol.html : web/public/index.html sans js-dos, avec ScummVM (lol-game.html) dans un cadre."""
    html = open(os.path.join(PUBLIC, "index.html"), encoding="utf-8").read()
    steps = [
        (r'<link rel="stylesheet" href="js-dos\.css">\n', ""),
        (r'<script src="js-dos\.js"></script>\n', ""),
        (r"<title>[^<]*</title>", "<title>Lands of Lore (ScummVM)</title>"),
        (r"</head>", PAGE_CSS),
        (r'<div id="dos"></div>', f'<iframe id="dos" src="lol-game.html#{TARGET}" title="Lands of Lore (ScummVM)" allow="autoplay; fullscreen"></iframe>'),
        # script de la page DOSBox (ZQSD, pause, js-dos, sauvegardes…) : remplacé
        (r"<script>\n\(\(\) => \{\n  // --- Déplacement ZQSD.*?\n</script>", PAGE_JS),
    ]
    for pat, rep in steps:
        html, n = re.subn(pat, lambda m: rep, html, count=1, flags=re.S)
        if n != 1:
            sys.exit(f"web/public/index.html : motif introuvable ({pat[:40]}…)")
    open(os.path.join(SITE, "lol.html"), "w", encoding="utf-8").write(html)


class Handler(http.server.SimpleHTTPRequestHandler):
    """Fichiers de web/scummvm, sinon ceux de web/public (version DOSBox, mini-carte, vue 3D, données)."""
    def translate_path(self, path):
        p = super().translate_path(path)
        # « / » (dossier sans index.html) : page DOSBox de web/public ; ScummVM sur /lol.html
        if not os.path.exists(p) or (os.path.isdir(p) and not os.path.exists(os.path.join(p, "index.html"))):
            alt = os.path.join(PUBLIC, os.path.relpath(p, SITE))
            if os.path.exists(alt):
                return alt
        return p


def prepare():
    if not os.path.exists(os.path.join(SITE, "scummvm.wasm")):
        sys.exit("web/scummvm/scummvm.wasm absent (voir l'en-tête de ce script : import).")
    if os.path.islink(DEST):
        os.remove(DEST)
    os.makedirs(os.path.join(DEST, "FRE"), exist_ok=True)
    for name in os.listdir(GAME):
        link(os.path.join(GAME, name), os.path.join(DEST, name))
    for name in INTRO:
        link(os.path.join(GAME, name), os.path.join(DEST, "FRE", name))
    merged = dict(read_pak(os.path.join(GAME, "STARTUP.PAK")))
    for n, d in read_pak(os.path.join(GAME, "STARTIN.PAK")).items():
        merged.setdefault(n, d)
    out = os.path.join(DEST, "FRE", "STARTUP.PAK")
    if os.path.lexists(out):
        os.remove(out)
    write_pak(out, merged)
    # index.json de chaque dossier, lus par le système de fichiers HTTP de ScummVM
    write_ini()
    write_launcher()
    write_page()
    write_http_index(os.path.join(SITE, "data"))


def write_http_index(folder):
    """index.json de chaque dossier (nom -> taille, ou {} pour un sous-dossier), comme
    dists/emscripten/build-make_http_index.py : lu par le système de fichiers HTTP de ScummVM."""
    tree = {}
    for name in sorted(os.listdir(folder)):
        if name == "index.json" or name.startswith("."):
            continue
        path = os.path.join(folder, name)
        if os.path.isdir(path):
            write_http_index(path)
            tree[name] = {}
        else:
            tree[name] = os.stat(path).st_size
    with open(os.path.join(folder, "index.json"), "w", encoding="utf-8") as f:
        json.dump(tree, f)


GENERATED = {"lol.html", "lol-game.html", "scummvm.ini", "index.json", "VERSION.txt"}


def import_build():
    """Copie le build de third_party/scummvm/build-emscripten dans web/scummvm (sans les jeux)."""
    if not os.path.exists(os.path.join(BUILD, "scummvm.wasm")):
        sys.exit("third_party/scummvm/build-emscripten/scummvm.wasm absent : compiler d'abord.")
    for dirpath, dirnames, filenames in os.walk(BUILD):
        rel = os.path.relpath(dirpath, BUILD)
        if rel == os.path.join("data", "games") or rel.startswith(os.path.join("data", "games") + os.sep):
            dirnames[:] = []
            continue
        os.makedirs(os.path.join(SITE, rel), exist_ok=True)
        for name in filenames:
            if name in GENERATED:
                continue
            shutil.copy2(os.path.join(dirpath, name), os.path.join(SITE, rel, name))
    git = lambda *a: subprocess.run(["git", "-C", SVM, *a], capture_output=True, text=True).stdout.strip()
    base = git("merge-base", "HEAD", "origin/master")
    with open(os.path.join(SITE, "VERSION.txt"), "w", encoding="utf-8") as f:
        f.write("ScummVM (GPL v3, licences dans doc/), portage WebAssembly, moteur Kyra seul.\n"
                f"Source : https://github.com/scummvm/scummvm, commit {base} "
                f"({git('log', '-1', '--format=%cs', base)})\n"
                f"Modification : tools/scummvm/lol-web-state.patch (branche locale {git('rev-parse', '--abbrev-ref', 'HEAD')}, "
                f"commit {git('rev-parse', '--short', 'HEAD')})\n"
                "Compilation : dists/emscripten/build.sh setup configure make dist --disable-all-engines "
                "--enable-engine=kyra,lol (Emscripten 4.0.10)\n"
                f"Importé le {datetime.date.today().isoformat()}\n")
    print("build copié dans web/scummvm ; vérifier VERSION.txt")


if __name__ == "__main__":
    if sys.argv[1:] == ["import"]:
        import_build()
        sys.exit()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8001
    prepare()
    print(f"http://localhost:{port}/lol.html")
    handler = functools.partial(Handler, directory=SITE)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
