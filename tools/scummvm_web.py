"""ScummVM web (WebAssembly), à part de la version DOSBox : prépare le jeu et sert la page.

Prérequis : ScummVM compilé pour le web dans third_party/scummvm/build-emscripten
(moteur Kyra seul, voir docs/retro-conception.md, § 10 bis) :
  ./dists/emscripten/build.sh setup configure make dist --disable-all-engines --enable-engine=kyra,lol

ScummVM attend la disposition du CD d'origine : fichiers de l'intro dans un dossier par langue
(FRE/GENERAL.PAK, FRE/STARTUP.PAK, INTRO1-9.PAK…). L'installation (extracted-cd/app/C/LOLCD)
les a mis à plat et a séparé les polices de l'intro dans STARTIN.PAK. On construit donc, dans
build-emscripten/data/games/lol, des liens vers les fichiers du jeu, plus un dossier FRE/ dont
le STARTUP.PAK réunit STARTUP.PAK et STARTIN.PAK. Le dossier du jeu n'est pas modifié.

Usage : python3 -I tools/scummvm_web.py [port]   (8001 par défaut)
Puis : http://localhost:8001/scummvm.html#--path=/data/games/lol --language=fr --auto-detect
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
    subprocess.run([sys.executable, os.path.join(SVM, "dists", "emscripten", "build-make_http_index.py"),
                    os.path.join(BUILD, "data")], check=True, stdout=subprocess.DEVNULL)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8001
    prepare()
    print(f"http://localhost:{port}/scummvm.html#--path=/data/games/lol%20--language=fr%20--auto-detect")
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=BUILD)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
