"""ScummVM web (WebAssembly), à part de la version DOSBox : prépare le jeu et sert la page.

Prérequis : ScummVM compilé pour le web dans third_party/scummvm/build-emscripten
(moteur Kyra seul, voir docs/retro-conception.md, § 10 bis) :
  ./dists/emscripten/build.sh setup configure make dist --disable-all-engines --enable-engine=kyra,lol

ScummVM attend la disposition du CD d'origine : fichiers de l'intro dans un dossier par langue
(FRE/GENERAL.PAK, FRE/STARTUP.PAK, INTRO1-9.PAK…). L'installation (extracted-cd/app/C/LOLCD)
les a mis à plat et a séparé les polices de l'intro dans STARTIN.PAK. On construit donc, dans
build-emscripten/data/games/lol, des liens vers les fichiers du jeu, plus un dossier FRE/ dont
le STARTUP.PAK réunit STARTUP.PAK et STARTIN.PAK. Le dossier du jeu n'est pas modifié.

Déplacements ZQSD : le scummvm.ini servi (copié dans le navigateur au premier lancement, puis
gardé dans IndexedDB) déclare la cible « lol-fr » et ajoute aux actions de déplacement du jeu
(clavier « lolkeyb » de ScummVM) les touches aux positions ZQSD d'un clavier AZERTY : Z avancer,
S reculer, Q / D tourner, A / E pas de côté, en plus des touches d'origine. Le jeu désactive lui-même ce clavier pendant la
saisie d'un nom de sauvegarde (gui_lol.cpp), et ses actions ne servent qu'en exploration.

Le navigateur ne télécharge scummvm.ini qu'une fois : s'il en garde déjà un (IndexedDB, base
« /home/web_user »), la cible lol-fr peut y manquer et ScummVM s'arrête (exit 1). La page
lol.html, générée à partir de scummvm.html, remplace donc la section [lol-fr] du fichier gardé
par celle du serveur avant de charger scummvm.js. Le reste du fichier (réglages) est conservé.

Usage : python3 -I tools/scummvm_web.py [port]   (8001 par défaut)
Puis : http://localhost:8001/lol.html
"""
import functools, http.server, os, struct, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from pak import read_pak

GAME = os.path.join(ROOT, "extracted-cd", "app", "C", "LOLCD")
SVM = os.path.join(ROOT, "third_party", "scummvm")
BUILD = os.path.join(SVM, "build-emscripten")
DEST = os.path.join(BUILD, "data", "games", "lol")
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
    with open(os.path.join(BUILD, "scummvm.ini"), "w") as f:
        f.write("\n".join(lines) + "\n")


# Lanceur : met à jour la section [lol-fr] du scummvm.ini gardé par le navigateur, puis charge ScummVM
LAUNCH_JS = r"""<script>
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
</script>"""


def write_launcher():
    html = open(os.path.join(BUILD, "scummvm.html"), encoding="utf-8").read()
    tag = "<script async src=scummvm.js></script>"
    if tag not in html:
        sys.exit("scummvm.html : balise de chargement de scummvm.js introuvable.")
    html = html.replace(tag, LAUNCH_JS.replace("__TARGET__", TARGET))
    html = html.replace("<title>ScummVM</title>", "<title>Lands of Lore (ScummVM)</title>")
    open(os.path.join(BUILD, "lol.html"), "w", encoding="utf-8").write(html)


def prepare():
    if not os.path.exists(os.path.join(BUILD, "scummvm.wasm")):
        sys.exit("ScummVM web n'est pas compilé (voir l'en-tête de ce script).")
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
    subprocess.run([sys.executable, os.path.join(SVM, "dists", "emscripten", "build-make_http_index.py"),
                    os.path.join(BUILD, "data")], check=True, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8001
    prepare()
    print(f"http://localhost:{port}/lol.html")
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=BUILD)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
