"""Animations de faces jouées par les scripts de niveau, pour la vue 3D (docs/reverse-engineering.md § 9.3k).

Le script d'une case de sortie peut jouer une WSA par-dessus la face devant le groupe
(olol_initAnimStruct puis olol_playAnimationPart), avant de changer de niveau. La WSA est posée à
l'écran en (x, y) ; la face voisine du groupe y est dessinée en (112 + 24, 8), à l'échelle 1 : la
WSA couvre donc les pixels (x - 136, y - 8) de la texture de la face.

Scènes de script (« cutscenes » dans anims.json) : images que le script d'une case montre en plein
cadre (fenêtre de scène 176 × 120) quand l'export des lieux ne les trouve pas (chargées par une
sous-routine). Une case a une liste de variantes ; la première dont le drapeau du jeu a l'état voulu
est montrée. Une variante animée (WSA) donne ses images côte à côte, la séquence de départ (« seq »)
puis la boucle (« loop »), en indices d'image, et la durée d'une image.

Usage : python3 -I tools/export_anims.py <dossier du jeu> <dossier de sortie>
Sortie : anims.json + anim_<nom>.png (images côte à côte) + scenes/<nom>.png."""
import json, os, struct, sys
sys.path.insert(0, os.path.dirname(__file__))
from pak import read_pak
from wwcomp import cps, wsa_frames
import lolgfx
import export_viewer as ev

# niveau, texture de la face, fichier WSA, position à l'écran, images jouées, ticks par image
# - niveau 1, case 13,19 (porte de Gladstone vers la forêt), LEVEL1.INF 0x12F0 : initAnimStruct
#   (« PORTCLLS », index 0, x 0x70 + 0x41 = 177, y 23, délai 0, drapeaux 0x20 | 8) puis
#   playAnimationPart(0, 1, 12, 5) : images 1 à 12, 5 ticks chacune, puis loadNewLevel(2, 106, 2).
ANIMS = [
    {"level": 1, "tex": 46, "wsa": "PORTCLLS", "pak": "O01D.PAK", "tileset": "KEEP", "sx": 177, "sy": 23, "first": 1, "last": 12, "tick": 5},
]

# Forêt du Nord (niveau 2), devant Gladstone (docs/reverse-engineering.md § 9.3l) :
# - case 106 (10,3), face au nord : LEVEL2.INF 0x58C, testGameFlag(67) ; sans le drapeau, la
#   sous-routine 0x109 montre KEEP.CPS (le château) ; avec, KEEPBRN.CPS (le château en flammes).
# - case 74 (10,2) : sous-routine 0x16A, sans le drapeau 67 : GUARD.WSA en (112, 0), plein cadre,
#   piloté par GUARD4.TIM : image 3, puis 6 5 1 2 3 4 5 6 1 2 3 4 2 3 4 tant que le garde parle,
#   8 ticks par image (l'image 6 est l'image de boucle, identique à l'image 0) ; puis loadNewLevel(1, 589, 0).
CUTSCENES = {
    2: {
        106: [{"cps": "KEEPBRN.CPS", "flag": 67, "when": 1}, {"cps": "KEEP.CPS"}],
        74: [{"wsa": "GUARD", "pak": "O01D.PAK", "flag": 67, "when": 0, "seq": [3],
              "loop": [6, 5, 1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 2, 3, 4], "tick": 8}],
    },
}


def wsa_palette(data):
    n, _xa, _ya, _w, _h, _d, fl = struct.unpack_from("<HhhHHHH", data)
    return data[14 + 4 * (n + 2):14 + 4 * (n + 2) + 768] if fl & 1 else None


def cutscenes(game_dir, out_dir):
    os.makedirs(os.path.join(out_dir, "scenes"), exist_ok=True)
    out = {}
    for level, cells in CUTSCENES.items():
        for cell, variants in cells.items():
            lst = []
            for v in variants:
                e = {k: v[k] for k in ("flag", "when") if k in v}
                if "cps" in v:
                    name = v["cps"].lower().replace(".cps", ".png")
                    img = ev.scene_image(game_dir, v["cps"])
                    img.save(os.path.join(out_dir, "scenes", name))
                    e["img"] = name
                else:
                    data = read_pak(os.path.join(game_dir, v["pak"]))[v["wsa"] + ".WSA"]
                    w, h, frames = wsa_frames(data)
                    pal = wsa_palette(data)
                    W = w * len(frames)
                    rgb = bytearray(W * h * 3)
                    for k, fr in enumerate(frames):
                        for y in range(h):
                            for x in range(w):
                                o = (y * W + k * w + x) * 3
                                rgb[o:o + 3] = ev.rgb(pal, fr[y * w + x])
                    name = f"anim_{v['wsa'].lower()}.png"
                    lolgfx.write_png(os.path.join(out_dir, "scenes", name), W, h, bytes(rgb))
                    n = len(frames)
                    e.update({"img": name, "w": w, "h": h, "n": n, "seq": [f % n for f in v["seq"]],
                              "loop": [f % n for f in v["loop"]], "ms": round(v["tick"] * 1000 / 60)})
                lst.append(e)
            out.setdefault(str(level), {})[str(cell)] = lst
    return out


def main(game_dir, out_dir):
    playfld = cps(read_pak(os.path.join(game_dir, "GENERAL.PAK"))["PLAYFLD.CPS"])[1]
    out = {}
    for a in ANIMS:
        w, h, frames = wsa_frames(read_pak(os.path.join(game_dir, a["pak"]))[a["wsa"] + ".WSA"])
        frames = frames[a["first"] - 1:a["last"]]
        pal = ev.Tileset(game_dir, a["tileset"], playfld).palette()
        W = w * len(frames)
        rgb = bytearray(W * h * 3)
        for k, fr in enumerate(frames):
            for y in range(h):
                for x in range(w):
                    o = (y * W + k * w + x) * 3
                    rgb[o:o + 3] = ev.rgb(pal, fr[y * w + x])
        name = f"anim_{a['wsa'].lower()}.png"
        lolgfx.write_png(os.path.join(out_dir, name), W, h, bytes(rgb))
        out.setdefault(str(a["level"]), {})[str(a["tex"])] = {
            "img": name, "x": a["sx"] - 136, "y": a["sy"] - 8, "w": w, "h": h, "n": len(frames), "ms": round(a["tick"] * 1000 / 60)}
    out["cutscenes"] = cutscenes(game_dir, out_dir)
    with open(os.path.join(out_dir, "anims.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh)


if __name__ == "__main__":
    main(*sys.argv[1:3])
