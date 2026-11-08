"""Exporte les données du visualiseur 3D (web/public/viewer/data).

Usage : python3 -I tools/export_viewer.py <dossier LOLCD> <dossier maps> <dossier sortie>

Pour chaque niveau :
  levelNN.json       grille, types de murs, monstres, annotations, point de départ
  levelNN_walls.png  atlas des faces de mur vues de face (128x96 chacune)
  levelNN_bg.png     fond plafond/sol de la vue d'origine (176x120)
  levelNN_spr.png    atlas des sprites de monstres (face, profil, dos)
"""
import json, os, struct, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pak import read_pak
from wwcomp import cps
import lolgfx
import emc
import item_info
import locks as locks_mod
import fragile as fragile_mod

FACE_W, FACE_H = 128, 96
ATLAS_COLS = 16
FRONT_START = 431 - 192          # mur proche de face : 16x12 tuiles en fin de jeu de 431
TILESET_PAKS = ["KEEP", "FOREST1", "MANOR", "CAVE1", "SWAMP", "URBISH", "MINE1",
                "TOWER1", "YVEL", "CATWALK", "RUIN", "CIMMERIA"]


class Image:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.px = bytearray(w * h * 4)           # RGBA, transparent par défaut

    def put(self, x, y, rgb):
        if 0 <= x < self.w and 0 <= y < self.h:
            o = (y * self.w + x) * 4
            self.px[o:o + 3] = rgb
            self.px[o + 3] = 255

    def alpha(self, x, y):
        return self.px[(y * self.w + x) * 4 + 3]

    def blit(self, other, dx, dy):
        for y in range(other.h):
            for x in range(other.w):
                o = (y * other.w + x) * 4
                if other.px[o + 3]:
                    self.put(dx + x, dy + y, other.px[o:o + 3])

    def save(self, path):
        lolgfx.write_png_rgba(path, self.w, self.h, self.px)


class Tileset:
    def __init__(self, game_dir, name, playfld_pal):
        self.name = name
        self.files = None
        for p in TILESET_PAKS:
            f = read_pak(os.path.join(game_dir, p + ".PAK"))
            if name + ".VCN" in f:
                self.files = f
                break
        if self.files is None:
            raise KeyError(name)
        f = self.files
        self.vcn = lolgfx.VCN(f[name + ".VCN"])
        self.vmp = lolgfx.vmp(f[name + ".VMP"])
        self.base_pal = bytearray(playfld_pal)
        self.base_pal[0:384] = self.vcn.palette
        dat_name = name + ".DAT" if name + ".DAT" in f else next((k for k in f if k.endswith(".DAT")), None)
        self.decor = self._read_dat(f[dat_name]) if dat_name else []
        shp_name = name + ".SHP" if name + ".SHP" in f else next(
            (k for k in f if k.endswith(".SHP") and "DOOR" not in k and "DR." not in k), None)
        self.decor_shapes = lolgfx.shp_frames(f[shp_name]) if shp_name else []
        door = next((k for k in f if k.endswith(".SHP") and ("DOOR" in k or "DR." in k)), None)
        self.door_frames = [fr for fr in lolgfx.shp_frames(f[door]) if fr] if door else []

    @staticmethod
    def _read_dat(d):
        n = struct.unpack_from("<H", d)[0]
        out = []
        for i in range(n):
            o = 2 + i * 72
            out.append({
                "shape": struct.unpack_from("<10H", d, o),
                "x": struct.unpack_from("<10h", d, o + 30),
                "y": struct.unpack_from("<10h", d, o + 50),
                "next": struct.unpack_from("b", d, o + 70)[0],
                "flags": d[o + 71],
            })
        return out

    def palette(self, alt_pal=None):
        pal = bytearray(self.base_pal)
        if alt_pal:
            pal[0:384] = alt_pal[0:384]
        return pal


def rgb(pal, c):
    return bytes(min(255, pal[c * 3 + j] * 4 + pal[c * 3 + j] // 16) for j in range(3))


def frame_image(frame, pal):
    w, h, px = frame
    img = Image(w, h)
    for i, c in enumerate(px):
        if c is not None:
            img.put(i % w, i // w, rgb(pal, c))
    return img


def mirrored(src):
    out = Image(src.w, src.h)
    for y in range(src.h):
        for x in range(src.w):
            o = (y * src.w + x) * 4
            if src.px[o + 3]:
                out.put(src.w - 1 - x, y, src.px[o:o + 3])
    return out


def wall_set_face(ts, set_index, pal):
    img = Image(FACE_W, FACE_H)
    base = 330 + set_index * 431 + FRONT_START
    for i in range(192):
        t = ts.vmp[base + i]
        if t & 0x3FFF == 0:
            continue
        px = ts.vcn.tile(t & 0x3FFF, bool(t & 0x4000))
        for k, c in enumerate(px):
            if t & 0x8000 and c == 0:
                continue
            img.put((i % 16) * 8 + k % 8, (i // 16) * 8 + k // 8, rgb(pal, c))
    return img


def background(ts, pal):
    img = Image(176, 120)
    for i in range(330):
        t = ts.vmp[i]
        if t & 0x3FFF == 0:
            continue
        px = ts.vcn.tile(t & 0x3FFF, bool(t & 0x4000))
        for k, c in enumerate(px):
            img.put((i % 22) * 8 + k % 8, (i // 22) * 8 + k // 8, rgb(pal, c))
    return img


# Perspective de la vue d'origine (176x120), déduite du mur proche de face :
# 128 px pour une case à 0,5 case de distance -> focale 64 ; mur des lignes 0 à ~94
# -> horizon à y=47 et œil à mi-hauteur (0,367 case au-dessus du sol).
VIEW_CX, VIEW_HORIZON, VIEW_FOCAL, EYE_H = 88, 47, 64, 0.367
TEX = 64


def floor_ceiling(bg):
    """Textures vues de dessus (64x64, une case) du sol et du plafond.

    Projection inverse d'une case de profondeur dans l'image de fond d'origine
    (sol : de 0,34 à 1,34 case ; plafond : de 0,5 à 1,5), en regardant vers le nord ;
    u = est, v = sud dans la case. La pénombre peinte dans l'image d'origine est
    compensée ligne par ligne (le moteur applique son propre assombrissement)."""
    out = []
    for sign, z0 in ((1, 0.34), (-1, 0.5)):          # 1 = sol, -1 = plafond
        rows = []
        for v in range(TEX):
            z = z0 + (1 - (v + 0.5) / TEX)            # bas de la case = plus proche
            sy = round(VIEW_HORIZON + sign * EYE_H * VIEW_FOCAL / z)
            sy = min(bg.h - 1, max(0, sy))
            row = []
            for u in range(TEX):
                x = (u + 0.5) / TEX - 0.5
                sx = min(bg.w - 1, max(0, round(VIEW_CX + x * VIEW_FOCAL / z)))
                o = (sy * bg.w + sx) * 4
                row.append(tuple(bg.px[o:o + 3]))
            rows.append(row)
        lum = [sum(sum(p) for p in r) / (3 * TEX) + 1 for r in rows]
        ref = sorted(lum)[-TEX // 4]                  # luminosité des lignes les plus claires
        img = Image(TEX, TEX)
        for v, r in enumerate(rows):
            k = min(4.0, max(1.0, ref / lum[v]))
            for u, p in enumerate(r):
                img.put(u, v, bytes(min(255, round(c * k)) for c in p))
        out.append(img)
    return out


def opening_bbox(img):
    """Rectangle transparent (ouverture de porte) au-dessus de la dernière rangée de tuiles."""
    xs, ys = [], []
    for y in range(FACE_H - 8):
        for x in range(img.w):
            if not img.alpha(x, y):
                xs.append(x); ys.append(y)
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def face_texture(ts, wt, pal):
    """Texture 128x96 d'un type de mur, ou None si rien à dessiner."""
    vmp, shape, flags = wt["vmp"], wt["shape"], wt["flags"]
    nsets = (len(ts.vmp) - 330) // 431
    if vmp == 0 and shape <= 0:
        return None
    img = wall_set_face(ts, vmp - 1, pal) if 0 < vmp <= nsets else Image(FACE_W, FACE_H)
    if shape == -2 and flags & 1 and ts.door_frames:       # porte fermée : battant dans l'ouverture
        door = frame_image(ts.door_frames[0], pal)
        bb = opening_bbox(img)
        if bb:
            x0, y0, x1, y1 = bb
            dx = (x0 + x1 + 1 - door.w) // 2
            dy = y1 + 1 - door.h
        else:
            dx, dy = (FACE_W - door.w) // 2, FACE_H - 8 - door.h
        img.blit(door, dx, dy)
    seen = set()
    d = shape
    while 0 < d < len(ts.decor) and d not in seen:   # décoration (+ décorations chaînées)
        seen.add(d)
        dec = ts.decor[d]
        si = dec["shape"][1]
        if si != 0xFFFF and si < len(ts.decor_shapes) and ts.decor_shapes[si]:
            shape_img = frame_image(ts.decor_shapes[si], pal)
            img.blit(shape_img, dec["x"][1], dec["y"][1])
            if dec["flags"] & 1:
                # drapeau 1 : motif symétrique, seule une moitié est stockée ; on dessine aussi
                # l'image retournée, en miroir par rapport au centre du mur
                img.blit(mirrored(shape_img), FACE_W - dec["x"][1] - shape_img.w, dec["y"][1])
        d = dec["next"]
    return img


def is_opaque(img):
    return all(img.px[(y * img.w + x) * 4 + 3] for y in range(FACE_H - 8) for x in range(img.w))


def level_alt_palette(ts, ini):
    if b"TEXT" not in ini:
        return None
    t = ini.index(b"TEXT") + 8
    count = struct.unpack_from(">H", ini, t)[0] // 2
    for o in struct.unpack_from(f">{count}H", ini, t):
        name = ini[t + o:ini.index(b"\0", t + o)].decode("latin-1").upper()
        if name.endswith(".PAL") and name in ts.files:
            return ts.files[name]
    return None


def pick_start(level):
    """Case de sol la plus dégagée (somme des couloirs visibles dans les 4 directions), sans monstre."""
    cells = level["cells"]
    occupied = {(m["x"], m["y"]) for m in level["monsters"]}
    walkable = lambda x, y: 0 <= x < 32 and 0 <= y < 32 and cells[y][x] in ("floor", "floor_special")
    best = None
    for y in range(32):
        for x in range(32):
            if not walkable(x, y) or (x, y) in occupied:
                continue
            runs = []
            for dx, dy in [(0, -1), (1, 0), (0, 1), (-1, 0)]:
                n, cx, cy = 0, x + dx, y + dy
                while walkable(cx, cy):
                    n += 1; cx += dx; cy += dy
                runs.append(n)
            score = sum(runs) + max(runs)
            if best is None or score > best[0]:
                best = (score, x, y, runs.index(max(runs)))
    if best is None:
        return 16, 16, 0
    return best[1], best[2], best[3]


FN_LOAD_SCENE = 0x29   # (n° de texte de l'image .CPS, page) : image fixe d'un lieu


def scripted_cells(files, n):
    """Cases qui ont un script dans LEVELn.INF (entrées ORDR < 1024 différentes de 0xFFFF)."""
    ck = emc.chunks(files[f"LEVEL{n}.INF"])
    o = struct.unpack(f">{len(ck['ORDR']) // 2}H", ck["ORDR"])
    return [i for i, a in enumerate(o[:1024]) if a != 0xFFFF]


def level_scenes(files, n):
    """Case -> image du lieu, d'après les appels 0x29 du script d'événements (.INF).

    Le script de la case n (table ORDR) est celui exécuté quand le groupe s'y trouve ;
    pour les lieux, c'est la case devant l'entrée (second point x2/y2 de l'annotation)."""
    ck = emc.chunks(files[f"LEVEL{n}.INF"])
    T = emc.texts(ck)
    o = ck["ORDR"]
    entries = struct.unpack(f">{len(o) // 2}H", o)
    owners = sorted((addr, i) for i, addr in enumerate(entries) if addr != 0xFFFF and i < 1024)
    out = {}
    for addr, fn, args in emc.calls(ck):
        if fn & 0xFF != FN_LOAD_SCENE or not args or args[0] is None or not 0 <= args[0] < len(T):
            continue
        name = T[args[0]]
        if not name.upper().endswith(".CPS"):
            continue
        block = None
        for start, b in owners:
            if start <= addr:
                block = b
        if block is not None:
            out.setdefault(str(block), name.upper())
    return out


def scene_image(game_dir, name):
    """Décor du lieu : coin 176x120 de l'image .CPS, avec sa propre palette."""
    for pak in sorted(os.listdir(game_dir)):
        if not pak.upper().endswith(".PAK"):
            continue
        f = pak_cache(game_dir, pak)
        if f and name in f:
            d, pal = cps(f[name])
            if len(d) < 64000 or len(pal) < 768:
                return None
            img = Image(176, 120)
            for y in range(120):
                for x in range(176):
                    img.put(x, y, rgb(pal, d[y * 320 + x]))
            return img
    return None


_PAKS = {}


def pak_cache(game_dir, name):
    if name not in _PAKS:
        p = os.path.join(game_dir, name)
        _PAKS[name] = read_pak(p) if os.path.exists(p) else None
    return _PAKS[name]


def main(game_dir, maps_dir, out_dir):
    locks_by_level = locks_mod.all_locks(game_dir)
    fragile_by_level = fragile_mod.all_fragile(game_dir, maps_dir)
    os.makedirs(out_dir, exist_ok=True)
    playfld = cps(read_pak(os.path.join(game_dir, "GENERAL.PAK"))["PLAYFLD.CPS"])[1]
    tilesets, index = {}, []
    for name in sorted(os.listdir(maps_dir)):
        if not (name.startswith("level") and name.endswith(".json") and name[5:7].isdigit()):
            continue
        level = json.load(open(os.path.join(maps_dir, name), encoding="utf-8"))
        n = level["level"]
        tsname = level["tileset"]
        if tsname not in tilesets:
            tilesets[tsname] = Tileset(game_dir, tsname, playfld)
        ts = tilesets[tsname]
        files = read_pak(os.path.join(game_dir, f"L{n:02d}.PAK"))
        pal = ts.palette(level_alt_palette(ts, files.get(f"LEVEL{n}.INI", b"")))

        # textures des faces utilisées
        # tous les types de mur du niveau, pas seulement ceux de la grille de départ : en jeu,
        # une porte qui s'ouvre change d'identifiant (étapes d'ouverture, porte ouverte)
        used = sorted({w for row in level["blocks"] for cell in row for w in cell}
                      | {int(k) for k in level["wallTypes"]})
        textures, walls = [], {}
        for wid in used:
            wt = level["wallTypes"].get(str(wid))
            if wt is None:
                continue
            img = face_texture(ts, wt, pal)
            tex = -1
            if img is not None:
                tex = len(textures)
                textures.append(img)
            entry = {"tex": tex, "block": bool(wt["flags"] & 1),
                     "opaque": bool(img is not None and is_opaque(img)),
                     "door": wt["special"] == 5 or wt["automap"] == 13}
            if entry["door"] and entry["block"]:
                # variante ouverte : même mur sans battant de porte
                open_img = face_texture(ts, dict(wt, flags=wt["flags"] & ~1), pal)
                if open_img is not None:
                    entry["openTex"] = len(textures)
                    textures.append(open_img)
            walls[wid] = entry
        rows = max(1, (len(textures) + ATLAS_COLS - 1) // ATLAS_COLS)
        atlas = Image(FACE_W * ATLAS_COLS, FACE_H * rows)
        for k, img in enumerate(textures):
            atlas.blit(img, (k % ATLAS_COLS) * FACE_W, (k // ATLAS_COLS) * FACE_H)
        atlas.save(os.path.join(out_dir, f"level{n:02d}_walls.png"))
        bg = background(ts, pal)
        bg.save(os.path.join(out_dir, f"level{n:02d}_bg.png"))
        floor_img, ceil_img = floor_ceiling(bg)
        floor_img.save(os.path.join(out_dir, f"level{n:02d}_floor.png"))
        ceil_img.save(os.path.join(out_dir, f"level{n:02d}_ceil.png"))

        # sprites des monstres : images 0-15 (face, profil, dos par groupes de 4, puis attaque)
        sprite_names = sorted({s for m in level["monsters"] for s in m["sprites"]})
        sprite_sigs = {}
        sprites, sprite_imgs = {}, []
        for sname in sprite_names:
            data = None
            for pak in [f"L{n:02d}.PAK", "MONSTER.PAK"] + [f"L{k:02d}.PAK" for k in range(1, 30)]:
                f = pak_cache(game_dir, pak)
                if f and sname + ".SHP" in f:
                    data = f[sname + ".SHP"]; break
            if data is None:
                continue
            frames = lolgfx.shp_frames(data)
            # extrait de 32 octets du fichier décompressé : sert à savoir, en mémoire, lequel
            # des sprites possibles d'un type le jeu a chargé (ex. ORC ou THUG au niveau 2)
            raw = cps(data)[0] if struct.unpack_from("<H", data, 2)[0] == 4 else data
            if len(raw) >= 432:
                sprite_sigs[sname] = raw[400:432].hex()
            # 16 images : 0-3 face (marche), 4-7 profil, 8-11 dos, 12-15 attaque et coups
            entry = []
            for fi in range(16):
                if fi < len(frames) and frames[fi] and frames[fi][0] > 8:
                    entry.append(len(sprite_imgs))
                    sprite_imgs.append(frame_image(frames[fi], pal))
                else:                                   # image absente : première de son groupe
                    entry.append(entry[fi - fi % 4] if fi % 4 and entry else (entry[0] if entry else None))
            sprites[sname] = entry
        sx, rects = 0, []
        for img in sprite_imgs:
            rects.append([sx, 0, img.w, img.h]); sx += img.w + 1
        sheet = Image(max(1, sx), max([1] + [i.h for i in sprite_imgs]))
        for img, r in zip(sprite_imgs, rects):
            sheet.blit(img, r[0], 0)
        sheet.save(os.path.join(out_dir, f"level{n:02d}_spr.png"))

        # images des lieux (scènes fixes)
        scenes = level_scenes(files, n)
        os.makedirs(os.path.join(out_dir, "scenes"), exist_ok=True)
        for name in set(scenes.values()):
            path = os.path.join(out_dir, "scenes", name.replace(".CPS", ".png"))
            if not os.path.exists(path):
                img = scene_image(game_dir, name)
                if img:
                    img.save(path)
        scenes = {b: nm.replace(".CPS", ".png") for b, nm in scenes.items()
                  if os.path.exists(os.path.join(out_dir, "scenes", nm.replace(".CPS", ".png")))}

        sx_, sy_, sa_ = pick_start(level)
        out = {
            "level": n, "tileset": tsname,
            "faces": [w for row in level["blocks"] for cell in row for w in cell],
            "cells": [c for row in level["cells"] for c in row],
            "walls": {str(k): v for k, v in walls.items()},
            # tous les types de mur du niveau : [drapeaux, spécial, automap] (mini-carte du jeu)
            "wallTypes": {k: [v["flags"], v["special"], v["automap"]] for k, v in level["wallTypes"].items()},
            "atlasCols": ATLAS_COLS, "faceW": FACE_W, "faceH": FACE_H,
            "spriteRects": rects,
            "sprites": sprites,
            "monsters": [{k: m[k] for k in ("x", "y", "xOffs", "yOffs", "direction", "sprites", "spawn")}
                         for m in level["monsters"]],
            # type de monstre -> sprite (positions réelles lues en mémoire par la page du jeu)
            "monsterTypes": {str(m["type"]): m["sprites"] for m in level["monsters"]
                             if m["type"] is not None and m["sprites"]},
            "spriteSigs": sprite_sigs,
            "scenes": scenes,   # case -> image du lieu (data/scenes/)
            "locks": locks_by_level.get(n, []),   # serrures : case + clé (tools/locks.py)
            "fragile": fragile_by_level.get(n, []),   # murs fragiles (tools/fragile.py)
            "scripted": scripted_cells(files, n),  # cases dont le script réagit (clic sur un mur…)
            "labels": [{k: l[k] for k in ("x", "y", "text")} for l in level["labels"]],
            "items": [{k: it.get(k) for k in ("x", "y", "xOffs", "yOffs", "type", "name", "spawn", "container", "face")}
                      for it in level.get("items", [])],
            "start": {"x": sx_ + 0.5, "y": sy_ + 0.5, "dir": sa_},
        }
        with open(os.path.join(out_dir, f"level{n:02d}.json"), "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
        index.append({"level": n, "tileset": tsname,
                      "name": tsname + (" — " + ", ".join(dict.fromkeys(
                          l["text"].capitalize() for l in level["labels"]
                          if l["text"] and l["text"] != "ENDROIT INVALIDE"))
                          if any(l["text"] for l in level["labels"]) else "")})
        print(f"niveau {n:2d} {tsname:9s} textures={len(textures):3d} sprites={len(sprite_imgs)}")
    with open(os.path.join(out_dir, "levels.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False)
    # fiches des types d'objets (inventaire de la page du jeu) : nom, icône, effets
    table = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "items_fr.json")
    if os.path.exists(table):
        with open(os.path.join(out_dir, "items.json"), "w", encoding="utf-8") as fh:
            json.dump(item_info.build(game_dir, table), fh, ensure_ascii=False)
    # icônes d'inventaire (ITEMICN.SHP, 20x20) en planche de 16 colonnes ; couleurs : palette
    # de l'interface (PLAYFLD) + couleurs 0-127 du château (les icônes n'en dépendent pas)
    icons = lolgfx.shp_frames(read_pak(os.path.join(game_dir, "STARTUP.PAK"))["ITEMICN.SHP"])
    pal = bytearray(playfld)
    pal[0:384] = Tileset(game_dir, "KEEP", playfld).vcn.palette
    sheet = Image(16 * 20, ((len(icons) + 15) // 16) * 20)
    for k, f in enumerate(icons):
        if f:
            sheet.blit(frame_image(f, pal), (k % 16) * 20, (k // 16) * 20)
    sheet.save(os.path.join(out_dir, "item_icons.png"))


if __name__ == "__main__":
    main(*sys.argv[1:4])
