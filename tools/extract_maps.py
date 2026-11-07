"""Extrait les cartes des niveaux de Lands of Lore (version CD).

Usage : python3 -I tools/extract_maps.py <dossier LOLCD> <dossier de sortie>

Pour chaque niveau Lxx.PAK, produit dans <sortie> :
  raw/LEVELn.*     fichiers d'origine du niveau (grille, murs, scripts, textes)
  levelNN.json     grille décodée + table des murs + annotations
  levelNN.png      rendu de la carte (une case = 12 px)

Format de la grille (LEVELn.CMZ, conteneur CPS compressé LCW) :
  u16 largeur (32), u16 hauteur (32), u16 octets par case (4, ou 9 au niveau 24)
  puis largeur*hauteur cases ; les 4 premiers octets sont les identifiants de mur
  des faces Nord, Est, Sud, Ouest. Case (x, y) = index y*32 + x.

Table des murs (LEVELn.WLL) : u16 inconnu puis entrées de 12 octets
  u16 id, u16 vmp, s16 forme, u16 type spécial, u16 drapeaux, s16 code automap.
  Drapeau 0x01 = bloque le groupe ; 0x80 = case vide (sol).

Annotations (LEVELn.XXX) : entrées de 12 octets
  u16 x, u16 y, u16 icône, u16 x2, u16 y2, u16 n° de texte (0x4000 + index dans LANDS.xxx).
"""
import json, os, struct, sys, zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pak import read_pak
from wwcomp import cps
import emc

CELL = 12
COLORS = {
    "wall":        (43, 43, 43),
    "floor":       (216, 207, 184),
    "door":        (160, 82, 45),
    "wall_special": (85, 90, 128),   # mur bloquant avec élément (levier, niche, décor…)
    "floor_special": (150, 185, 120),  # case franchissable particulière (décor, passage…)
    "unknown":     (255, 0, 255),
}
GRID = (120, 112, 96)
MARK = (210, 30, 30)
MONSTER_INI = (255, 140, 0)   # présent au chargement du niveau
MONSTER_INF = (255, 230, 40)  # apparaît sur un événement
DIRECTIONS = ["N", "E", "S", "O"]

FN_LOAD_SHAPES = 0x0B      # (texte fichier .SHP, emplacement, anim)
FN_MONSTER_PROPS = 0x3F    # (type, emplacement de forme, caractéristiques…)
FN_INIT_MONSTER = 0x38     # (case, dx, dy, direction, type, ?, mode, équipements…)


def level_monsters(files, n):
    """Monstres placés par les scripts du niveau (constantes uniquement)."""
    sprites, types, out = {}, {}, []
    scripts = {kind: emc.chunks(files[f"LEVEL{n}.{kind}"]) for kind in ("INI", "INF")}
    for kind, ck in scripts.items():
        T = emc.texts(ck)
        for _, fn, a in emc.calls(ck):
            fn &= 0xFF
            if fn == FN_LOAD_SHAPES and len(a) >= 2 and a[0] is not None and a[0] < len(T):
                lst = sprites.setdefault(a[1], [])
                name = T[a[0]].rsplit(".", 1)[0]
                if name not in lst:
                    lst.append(name)
            elif fn == FN_MONSTER_PROPS and len(a) >= 2 and a[0] is not None:
                types[a[0]] = a[1]
    for kind, ck in scripts.items():
        for _, a in emc.resolved_calls(ck, FN_INIT_MONSTER):
            a = a + [None] * (11 - len(a))
            block, dx, dy, d, typ, _, mode = a[:7]
            if block is None or not 0 <= block < 1024:
                continue
            out.append({
                "x": block % 32, "y": block // 32, "block": block,
                "xOffs": dx, "yOffs": dy,
                "direction": DIRECTIONS[d & 3] if d is not None else None,
                "type": typ,
                "sprites": sprites.get(types.get(typ), []),
                "mode": mode,
                "equipment": [e for e in a[7:11] if e],
                "spawn": "initial" if kind == "INI" else "event",
            })
    return out


def strings(blob, enc="cp850"):
    n = struct.unpack_from("<H", blob)[0] // 2
    offs = struct.unpack_from(f"<{n}H", blob)
    return [blob[o:blob.index(b"\0", o)].decode(enc) for o in offs]


def wall_table(wll):
    tab = {}
    for o in range(2, len(wll) - 11, 12):
        idx, vmp, shp, spec, flags, am = struct.unpack_from("<HHhHHh", wll, o)
        tab[idx] = {"vmp": vmp, "shape": shp, "special": spec, "flags": flags, "automap": am}
    return tab


def classify(wid, tab):
    t = tab.get(wid)
    if t is None:
        return "unknown"
    if t["automap"] == 13 or t["special"] == 5:
        return "door"
    if t["flags"] & 1:
        plain = t["special"] == 0 and t["automap"] in (-1, 63)
        return "wall" if plain else "wall_special"
    if t["flags"] == 0x80 and t["automap"] == 63 and t["special"] == 0:
        return "floor"
    return "floor_special"


PRIORITY = ["unknown", "door", "wall_special", "floor_special", "wall", "floor"]


def cell_class(faces, tab):
    classes = {classify(w, tab) for w in faces}
    for c in PRIORITY:
        if c in classes:
            return c


def write_png(path, w, h, pixels):
    raw = b"".join(b"\0" + bytes(pixels[y * w * 3:(y + 1) * w * 3]) for y in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    open(path, "wb").write(png)


def render(grid_cls, labels, W, H, path, monsters=()):
    pw, ph = W * CELL, H * CELL
    px = bytearray(pw * ph * 3)
    def put(x, y, c):
        i = (y * pw + x) * 3
        px[i:i + 3] = bytes(c)
    for cy in range(H):
        for cx in range(W):
            col = COLORS[grid_cls[cy][cx]]
            for y in range(CELL):
                for x in range(CELL):
                    edge = x == 0 or y == 0
                    put(cx * CELL + x, cy * CELL + y, GRID if edge else col)
    for lab in labels:
        cx, cy = lab["x"], lab["y"]
        if not (0 <= cx < W and 0 <= cy < H):
            continue
        for y in range(3, CELL - 2):
            for x in range(3, CELL - 2):
                if (x - 6.5) ** 2 + (y - 6.5) ** 2 <= 9:
                    put(cx * CELL + x, cy * CELL + y, MARK)
    for m in monsters:
        dx = m["xOffs"] if m["xOffs"] is not None else 128
        dy = m["yOffs"] if m["yOffs"] is not None else 128
        mx = m["x"] * CELL + 1 + round(dx / 256 * (CELL - 2))
        my = m["y"] * CELL + 1 + round(dy / 256 * (CELL - 2))
        col = MONSTER_INI if m["spawn"] == "initial" else MONSTER_INF
        for y in range(my - 2, my + 2):
            for x in range(mx - 2, mx + 2):
                if 0 <= x < pw and 0 <= y < ph:
                    put(x, y, col)
    write_png(path, pw, ph, px)


def level_tileset(ini):
    tileset = None
    if b"TEXT" in ini:
        # Chunk IFF « TEXT » : table d'offsets u16 big-endian, puis chaînes ;
        # la première qui n'est pas une palette est le décor (KEEP, FOREST1…).
        t = ini.index(b"TEXT") + 8
        count = struct.unpack_from(">H", ini, t)[0] // 2
        for o in struct.unpack_from(f">{count}H", ini, t):
            name = ini[t + o:ini.index(b"\0", t + o)].decode("latin-1")
            if not name.upper().endswith(".PAL"):
                tileset = name
                break

    return tileset


def main(game_dir, out_dir):
    os.makedirs(os.path.join(out_dir, "raw"), exist_ok=True)
    gstr = strings(read_pak(os.path.join(game_dir, "STARTUP.PAK"))["LANDS.FRE"])
    paks = {}
    for n in range(1, 100):
        pak = os.path.join(game_dir, f"L{n:02d}.PAK")
        if os.path.exists(pak):
            paks[n] = read_pak(pak)
    tilesets = {n: level_tileset(f.get(f"LEVEL{n}.INI", b"")) for n, f in paks.items()}
    tables = {n: wall_table(f[f"LEVEL{n}.WLL"]) for n, f in paks.items()}

    summary = []
    for n, files in paks.items():
        for name, data in files.items():
            if not name.endswith(".SHP"):
                open(os.path.join(out_dir, "raw", name), "wb").write(data)
        grid_raw, _ = cps(files[f"LEVEL{n}.CMZ"])
        W, H, B = struct.unpack_from("<HHH", grid_raw)
        tab = dict(tables[n])
        tileset = tilesets[n]
        # Certains niveaux utilisent des murs définis dans le .WLL d'un autre niveau
        # du même décor (forêts 2/3, tour 21) : on les y emprunte.
        used = {grid_raw[6 + i * B + k] for i in range(W * H) for k in range(4)}
        borrowed = {}
        for wid in sorted(used - tab.keys()):
            for m in sorted(paks, key=lambda m: abs(m - n)):
                if m != n and tilesets[m] == tileset and wid in tables[m]:
                    tab[wid] = tables[m][wid]
                    borrowed[str(wid)] = m
                    break

        blocks, extra, cls = [], [], []
        for y in range(H):
            row, xrow, crow = [], [], []
            for x in range(W):
                o = 6 + (y * W + x) * B
                faces = list(grid_raw[o:o + 4])
                row.append(faces)
                xrow.append(list(grid_raw[o + 4:o + B]))
                crow.append(cell_class(faces, tab))
            blocks.append(row); extra.append(xrow); cls.append(crow)

        labels = []
        xxx = files.get(f"LEVEL{n}.XXX", b"")
        for o in range(0, len(xxx) - 11, 12):
            x, y, icon, x2, y2, sid = struct.unpack_from("<6H", xxx, o)
            if sid == 0xFFFF:  # emplacement vide
                continue
            i = sid & 0x3FFF
            labels.append({"x": x, "y": y, "icon": icon, "x2": x2, "y2": y2,
                           "stringId": sid, "text": gstr[i] if i < len(gstr) else None})

        monsters = level_monsters(files, n)
        level = {
            "level": n, "tileset": tileset, "width": W, "height": H, "bytesPerBlock": B,
            "faceOrder": ["N", "E", "S", "W"],
            "blocks": blocks,
            "cells": cls,
            "wallTypes": {str(k): v for k, v in sorted(tab.items())},
            "wallTypesBorrowedFrom": borrowed,  # id de mur -> niveau d'où vient sa définition
            "labels": labels,
            "monsters": monsters,
        }
        if B > 4:
            level["extraBlockBytes"] = extra
        with open(os.path.join(out_dir, f"level{n:02d}.json"), "w", encoding="utf-8") as f:
            json.dump(level, f, ensure_ascii=False, separators=(",", ":"))
        render(cls, labels, W, H, os.path.join(out_dir, f"level{n:02d}.png"), monsters)
        counts = {c: sum(r.count(c) for r in cls) for c in COLORS}
        kinds = {}
        for m in monsters:
            k = "/".join(m["sprites"]) or f"type {m['type']}"
            kinds.setdefault(k, {"initial": 0, "event": 0})[m["spawn"]] += 1
        on_wall = sum(1 for m in monsters if cls[m["y"]][m["x"]] in ("wall",))
        summary.append({"level": n, "tileset": tileset, "labels": [l["text"] for l in labels],
                        "monsters": kinds, "monstersOnWallCells": on_wall, **counts})
        print(f"niveau {n:2d} {tileset or '':10s} sol={counts['floor']:4d} portes={counts['door']:3d} "
              f"inconnu={counts['unknown']:2d} annotations={len(labels)} monstres={len(monsters)} (sur mur: {on_wall})")
    with open(os.path.join(out_dir, "levels.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
