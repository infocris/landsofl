"""Animations de faces jouées par les scripts de niveau, pour la vue 3D (docs/reverse-engineering.md § 9.3k).

Le script d'une case de sortie peut jouer une WSA par-dessus la face devant le groupe
(olol_initAnimStruct puis olol_playAnimationPart), avant de changer de niveau. La WSA est posée à
l'écran en (x, y) ; la face voisine du groupe y est dessinée en (112 + 24, 8), à l'échelle 1 : la
WSA couvre donc les pixels (x - 136, y - 8) de la texture de la face.

Usage : python3 -I tools/export_anims.py <dossier du jeu> <dossier de sortie>
Sortie : anims.json + anim_<nom>.png (images côte à côte)."""
import json, os, sys
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
    with open(os.path.join(out_dir, "anims.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh)


if __name__ == "__main__":
    main(*sys.argv[1:3])
