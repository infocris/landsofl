"""Exporte les données du visualiseur 3D (web/public/viewer/data).

Usage : python3 -I tools/export_viewer.py <dossier LOLCD> <dossier maps> <dossier sortie>

Pour chaque niveau :
  levelNN.json       grille, types de murs, monstres, annotations, point de départ
  levelNN_walls.png  atlas des faces de mur vues de face (128x96 chacune)
  levelNN_bg.png     fond plafond/sol de la vue d'origine (176x120)
  levelNN_floor.png  sol vu de dessus, une case (motif répété 3 × 3 pour un sol pavé,
                     demi-case proche en damier 1 2 / 2 1 pour un sol peint)
  levelNN_floor_motif.png  motif du sol pavé (KEEP, TOWER1), reconstitué depuis le fond
  levelNN_floor_wang.png   sol peint : 16 tuiles de Wang (4 × 4), pour un sol sans répétition
  levelNN_spr.png    atlas des sprites de monstres (face, profil, dos)
"""
import json, os, struct, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pak import read_pak, read_strings
from wwcomp import cps
import lolgfx
import emc
import item_info
import chests
import hidden_walls
ITEM_NAMES = [i["name"] for i in json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "items_fr.json"), encoding="utf-8"))["items"]]
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

    def put_rgba(self, x, y, rgb, a):
        if 0 <= x < self.w and 0 <= y < self.h:
            o = (y * self.w + x) * 4
            self.px[o:o + 3] = rgb
            self.px[o + 3] = a

    def alpha(self, x, y):
        return self.px[(y * self.w + x) * 4 + 3]

    def blit(self, other, dx, dy):
        for y in range(other.h):
            for x in range(other.w):
                o = (y * other.w + x) * 4
                if other.px[o + 3]:
                    self.put_rgba(dx + x, dy + y, other.px[o:o + 3], other.px[o + 3])

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


# Monstres translucides (propriété 0x800, ex. TCABAL) : le jeu (drawShapePlotType21) prend la
# couleur c du sprite comme indice de transparence t = T1[c] (couleurs 2 à 20 -> t = 1 à 19 ;
# t >= 0x80 : couleur opaque) et affiche T2[t * 256 + couleur du décor]. Tables du niveau :
# LEVELnn.TLC (T1 : 256 octets, T2 : 20 × 256). Pour la vue 3D, chaque t est approché par un
# mélange « teinte + opacité » : résultat = (1 - a) × décor + a × teinte (moindres carrés sur les
# 256 couleurs du décor, a commun aux trois composantes).
def transparency_fit(tlc, pal):
    t1, t2 = tlc[:256], tlc[256:]
    P = [rgb(pal, c) for c in range(256)]
    fit = {}
    for t in range(1, 20):
        xs = P; ys = [P[t2[t * 256 + bg]] for bg in range(256)]
        n = len(xs)
        mx = [sum(p[c] for p in xs) / n for c in range(3)]
        my = [sum(p[c] for p in ys) / n for c in range(3)]
        num = sum((xs[i][c] - mx[c]) * (ys[i][c] - my[c]) for i in range(n) for c in range(3))
        den = sum((xs[i][c] - mx[c]) ** 2 for i in range(n) for c in range(3)) or 1
        k = max(0.0, min(1.0, num / den)); a = 1 - k
        tint = bytes(max(0, min(255, round((my[c] - k * mx[c]) / a))) if a > 1e-3 else 0 for c in range(3))
        fit[t] = (tint, max(1, min(255, round(a * 255))))
    return t1, fit


def ghost_image(frame, pal, t1, fit):
    """Image du sprite telle que le jeu la dessine en translucide (drawShapePlotType21) : indice de
    transparence -> teinte semi-opaque (mélangée au décor par la vue 3D) ; sinon couleur opaque.
    La surcouche de luminosité (distance) s'applique ensuite au résultat, dans le jeu comme dans la
    vue 3D (assombrissement par la distance)."""
    w, h, px = frame
    img = Image(w, h)
    for i, c in enumerate(px):
        if not c:
            continue
        t = t1[c]
        if t < 0x80 and t in fit:
            img.put_rgba(i % w, i // w, *fit[t])
        else:
            img.put(i % w, i // w, rgb(pal, c))
    return img


# Sprites dont le type a le drapeau translucide 0x800, vérifié dans le moteur (ScummVM : drapeaux
# publiés en 0x7F000900) : TCABAL (niveau 27, type 1 : 0xF810). La version DOSBox n'a pas ce
# drapeau ; elle s'appuie sur cette liste. (HATCHETS, entièrement dans les mêmes couleurs, n'est
# pas translucide : 0xE000 ; le drapeau, calculé dans le script du niveau, ne se lit pas en statique.)
TRANSLUCENT_KNOWN = {"TCABAL"}


def translucent_share(frames):
    """Part des pixels du sprite (images 0-15) dans les couleurs d'indice de transparence (2 à 20)."""
    tot = tr = 0
    for f in frames[:16]:
        if not f:
            continue
        for c in f[2]:
            if c:
                tot += 1; tr += 2 <= c <= 20
    return tr / tot if tot else 0


def loaded_monster_types(files, n):
    """Types de monstres du niveau d'après ses scripts, même sans monstre placé par une constante
    (ex. squelettes MOLDER du Haut du Bois d'Opin, niveau 17, type 2) :
    fonction 0x0B (olol_loadMonsterShapes : fichier .SHP, emplacement) et fonction 0x3F
    (olol_loadMonsterProperties : type, emplacement). -> {type: [noms de sprites]}"""
    slots, types = {}, {}
    for kind in ("INI", "INF"):
        if f"LEVEL{n}.{kind}" not in files:
            continue
        ck = emc.chunks(files[f"LEVEL{n}.{kind}"])
        T = emc.texts(ck)
        for _, fn, a in emc.calls(ck):
            fn &= 0xFF
            if fn == 0x0B and len(a) >= 2 and a[0] is not None and a[1] is not None and a[0] < len(T):
                name = T[a[0]].rsplit(".", 1)[0]
                lst = slots.setdefault(a[1], [])
                if name not in lst:
                    lst.append(name)
            elif fn == 0x3F and len(a) >= 2 and a[0] is not None and a[1] is not None:
                types[a[0]] = a[1]
    return {t: slots[s] for t, s in types.items() if s in slots}


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


TEX = 64                          # texture d'une case (plafond)


# Sol du fond d'origine, vu de dessus (docs/reverse-engineering.md § 9.3c, mesuré sur les sols
# à motif de KEEP et TOWER1). Le sol peint n'obéit pas à la perspective des murs :
# - en largeur, le motif rétrécit vers un point de fuite à y = hx (39 pour KEEP, 42,5 pour
#   TOWER1) : le point x de la ligne y est à X = (x − 88) / (0,75 · (y − hx)) « unités » ;
# - en profondeur, K = ak / (y − hk) unités, avec un horizon propre à chaque sol (hk) ;
# - une case fait 3,1 unités de large (mur proche : 128 px à la ligne 94, où l'unité fait 41 px).
FLOOR_CX, FLOOR_HX, FLOOR_SX = 88, 39, 0.75
CELL_UNITS = 3.1
FLOOR_DEPTH = (24, 376)          # hk, ak mesurés sur les joints des dalles de TOWER1
# Sols pavés d'un motif répété : maille (px × pk unités), décalage d'une rangée sur deux (sh,
# en fraction de px : quinconce) et origine (x0, k0) du motif. Les autres sols sont peints
# sans répétition : on n'en redresse qu'une case.
FLOOR_LATTICES = {
    # octogones clairs et sombres en damier, rangées en quinconce (deux par motif) ;
    # profondeur ajustée sur les rangées de pixels qui se ressemblent
    "KEEP": dict(hk=34.5, ak=354.25, px=1.0, pk=1.0, sh=0.0, x0=0.0, k0=0.0),
    # dalles carrées : joints horizontaux à K entier + 0,37 ; joints verticaux droits vers
    # y = 42,5, à X = ±0,545
    "TOWER1": dict(hx=42.5, hk=24.0, ak=376.0, px=1.09, pk=1.0, sh=0.0, x0=0.545, k0=0.37),
}
MOTIF = 48                        # pixels par motif


def floor_motif(bg, tsname):
    """Sol vu de dessus, reconstitué depuis le fond d'origine.

    Chaque pixel du sol (découpé en 6 × 2 sous-pixels) est projeté dans le plan du sol puis,
    pour un sol pavé, replié dans une maille du motif : toutes les répétitions visibles
    s'accumulent, pondérées par leur résolution à l'écran. La pénombre peinte est compensée
    par la luminosité moyenne de la bande de profondeur. Renvoie (motif, répété) : le motif
    seul (MOTIF × MOTIF) et un booléen ; pour un sol non pavé, l'image d'une case."""
    lat = FLOOR_LATTICES.get(tsname)
    hk, ak = (lat["hk"], lat["ak"]) if lat else FLOOR_DEPTH
    # sol peint : seulement la moitié proche (une demi-case), nette ; plus loin, la pénombre
    # ou la brume (Yvel) efface le pavage
    px, pk = (lat["px"], lat["pk"]) if lat else (CELL_UNITS / 2, CELL_UNITS / 2)
    size = MOTIF if lat else 64
    k_of = lambda y: ak / (y - hk)
    hx = lat.get("hx", FLOOR_HX) if lat else FLOOR_HX
    y_min = int(max(hx, hk)) + 2
    k_near = k_of(bg.h)
    span = 4.0 if lat else pk                          # profondeur utilisée (unités)
    lum = [sum(bg.px[(y * bg.w + x) * 4 + c] for x in range(bg.w) for c in range(3)) / bg.w + 1
           for y in range(bg.h)]
    rows = [y for y in range(y_min, bg.h) if k_of(y + 0.5) - k_near <= span]
    smooth = {}
    for y in rows:                                     # ± une demi-unité de profondeur
        band = [lum[t] for t in rows if abs(k_of(t + 0.5) - k_of(y + 0.5)) < 0.5]
        smooth[y] = sum(band) / len(band)
    ref = sorted(smooth[y] for y in rows[-15:])[len(rows[-15:]) // 2]
    acc = [[0.0, 0.0, 0.0, 0.0] for _ in range(size * size)]
    for y in rows:
        if smooth[y] < 0.12 * ref:
            continue
        gain = min(4.0, ref / smooth[y])
        wgt = FLOOR_SX * (y + 0.5 - hx)                # pixels par unité : résolution
        for sy in range(6):
            yy = y + (sy + 0.5) / 6
            K = k_of(yy)
            if lat:
                kk = (K - lat["k0"]) / pk
                row = kk // 1
                v = kk - row
            else:
                v, row = (K - k_near) / pk, 0
                if not 0 <= v < 1:
                    continue
            iv = min(size - 1, int((1 - v) * size))     # rangée 0 = le plus loin
            scale = FLOOR_SX * (yy - hx)
            for x in range(bg.w):
                o = (y * bg.w + x) * 4
                col = bg.px[o:o + 3]
                for sx in (0.25, 0.75):
                    X = (x + sx - FLOOR_CX) / scale
                    if lat:
                        u = ((X - lat["x0"]) / px - lat["sh"] * row) % 1
                    else:
                        u = X / px + 0.5
                        if not 0 <= u < 1:
                            continue
                    a = acc[iv * size + min(size - 1, int(u * size))]
                    a[0] += col[0] * gain * wgt; a[1] += col[1] * gain * wgt
                    a[2] += col[2] * gain * wgt; a[3] += wgt
    return acc_image(acc, size), bool(lat)


def acc_image(acc, size):
    """Image d'un accumulateur [r, g, b, poids] par texel ; les trous (texels jamais vus,
    comme les coins d'une case peinte) prennent la moyenne de leurs voisins, de proche en
    proche."""
    for _ in range(size):
        holes = [i for i, a in enumerate(acc) if not a[3]]
        if not holes:
            break
        for i in holes:
            x, y = i % size, i // size
            nb = [acc[(y + dy) % size * size + (x + dx) % size] for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))]
            nb = [a for a in nb if a[3]]
            if nb:
                acc[i] = [sum(a[c] / a[3] for a in nb) / len(nb) for c in range(3)] + [1.0]
    img = Image(size, size)
    for i, a in enumerate(acc):
        img.put(i % size, i // size, bytes(min(255, round(a[c] / max(a[3], 1e-9))) for c in range(3)))
    return img


# Plafond du fond d'origine, vu de dessous (docs/reverse-engineering.md § 9.3f), mesuré sur les
# charpentes de KEEP, TOWER1, MANOR et URBISH :
# - en largeur, les poutres longitudinales fuient vers y = 39, comme le sol : le point x de la
#   ligne y est à X = (x − 88) / (4 · (39 − y)) cases ;
# - en profondeur, K = 145,3 / (55,15 − y) cases : les poutres transversales (lignes 0-4,
#   14-17, 23-25, 29-30) tombent à K entier + 0,66, une par case ;
# - un caisson par case, poutres sur les bords de la case (longitudinales à X = ±0,5).
CEIL_HX, CEIL_SX = 39, 4.0
CEIL_DEPTH = (55.15, 145.3)
CEIL_EDGE_K = 0.97               # bord de case : milieu de la poutre (dessous clair + face)
CEIL_COFFERED = {"KEEP", "TOWER1", "MANOR", "URBISH", "MINE1"}


def ceiling_cell(bg, tsname):
    """Plafond d'une case (TEX × TEX, rangée 0 = nord en regardant vers le nord).

    Charpente à caissons : tout le plafond visible est replié dans une case (somme pondérée
    par la résolution à l'écran, symétrisée gauche-droite puisque le jeu retourne le fond à
    chaque pas). Autres plafonds (roche, racines…) : la case la plus proche, redressée."""
    hk, ak = CEIL_DEPTH
    k_of = lambda y: ak / (hk - y)
    fold = tsname in CEIL_COFFERED
    y_max = int(min(CEIL_HX, hk)) - 4
    k_near = k_of(0)
    lum = [sum(bg.px[(y * bg.w + x) * 4 + c] for x in range(bg.w) for c in range(3)) / bg.w + 1
           for y in range(y_max)]
    smooth = []
    for y in range(y_max):                             # ± une demi-case de profondeur
        band = [lum[t] for t in range(y_max) if abs(k_of(t + 0.5) - k_of(y + 0.5)) < 0.5]
        smooth.append(sum(band) / len(band))
    ref = sorted(smooth[:8])[4]
    acc = [[0.0, 0.0, 0.0, 0.0] for _ in range(TEX * TEX)]
    for sy in range(y_max * 8):
        yy = (sy + 0.5) / 8
        y0 = min(y_max - 1, max(0, int(yy - 0.5)))
        y1 = min(y_max - 1, y0 + 1)
        f = min(1.0, max(0.0, yy - 0.5 - y0))
        sm = smooth[y0] * (1 - f) + smooth[y1] * f
        if sm < 0.12 * ref:
            continue
        K = k_of(yy)
        if fold:
            v = 1 - (K - CEIL_EDGE_K) % 1
        else:
            v = 1 - (K - k_near)
            if not 0 < v <= 1:
                continue
        iv = min(TEX - 1, int(v * TEX)) % TEX           # rangée 0 = le plus loin
        scale = CEIL_SX * (CEIL_HX - yy)                # pixels par case : résolution
        g = min(4.0, max(1.0, ref / sm)) * scale
        for x in range(bg.w):
            o0, o1 = (y0 * bg.w + x) * 4, (y1 * bg.w + x) * 4
            col = [(bg.px[o0 + c] * (1 - f) + bg.px[o1 + c] * f) * g for c in range(3)]
            for sx in (0.125, 0.375, 0.625, 0.875):
                u = (x + sx - FLOOR_CX) / scale + 0.5
                if fold:
                    u %= 1
                elif not 0 <= u < 1:
                    continue
                iu = min(TEX - 1, int(u * TEX))
                for j in ((iu, TEX - 1 - iu) if fold else (iu,)):
                    a = acc[iv * TEX + j]
                    a[0] += col[0]; a[1] += col[1]; a[2] += col[2]; a[3] += scale
    return acc_image(acc, TEX)


# Tuiles de Wang du sol peint (docs/reverse-engineering.md § 9.3e). Une tuile = une demi-case
# (WANG_T pixels pour CELL_UNITS / 2 unités). Chaque bord porte une couleur 0/1 ; la tuile
# d'indice n + 2·e + 4·s + 8·w a ces couleurs au nord, à l'est, au sud et à l'ouest.
WANG_T = 64
WANG_DEPTH = 1.8                 # profondeur utilisée depuis le bas de l'image (unités)
WANG_BAND = 10                   # écart maximal de la découpe à la diagonale (pixels)


def floor_source(bg):
    """Sol peint redressé vu de dessus, sur la bande proche : (pixels RGB ou None, largeur,
    hauteur). Même projection que floor_motif (FLOOR_DEPTH, hx = 39), pénombre compensée ;
    rangée 0 = le plus loin. None hors du champ de la vue d'origine."""
    hk, ak = FLOOR_DEPTH
    res = WANG_T / (CELL_UNITS / 2)                   # pixels par unité
    k_near = ak / (bg.h - hk)
    w, h = int(4.6 * res), int(WANG_DEPTH * res)
    lum = [sum(bg.px[(y * bg.w + x) * 4 + c] for x in range(bg.w) for c in range(3)) / bg.w + 1
           for y in range(bg.h)]
    ys = [y for y in range(int(max(FLOOR_HX, hk)) + 2, bg.h)]
    k_of = lambda y: ak / (y + 0.5 - hk)
    smooth = {y: sum(lum[t] for t in ys if abs(k_of(t) - k_of(y)) < 0.5) /
                 max(1, sum(1 for t in ys if abs(k_of(t) - k_of(y)) < 0.5)) for y in ys}
    ref = sorted(smooth[y] for y in ys[-15:])[len(ys[-15:]) // 2]
    out = [None] * (w * h)
    for j in range(h):
        K = k_near + WANG_DEPTH - (j + 0.5) / res
        y = hk + ak / K - 0.5
        yi = int(round(y))
        if not ys[0] <= yi < bg.h:
            continue
        gain = min(4.0, ref / smooth[yi])
        for i in range(w):
            X = (i + 0.5) / res - 2.3
            x = FLOOR_CX + X * FLOOR_SX * (y + 0.5 - FLOOR_HX) - 0.5
            if not 0 <= x <= bg.w - 1:
                continue
            x0 = int(x); f = x - x0; x1 = min(bg.w - 1, x0 + 1)
            a, b = (yi * bg.w + x0) * 4, (yi * bg.w + x1) * 4
            out[j * w + i] = tuple(min(255.0, (bg.px[a + c] * (1 - f) + bg.px[b + c] * f) * gain) for c in range(3))
    return out, w, h


def wang_tiles(bg):
    """16 tuiles de Wang (atlas 4 × 4 de WANG_T px) tirées de la bande proche du sol peint.

    Quatre échantillons T × T de la source (deux par orientation de bord, choisis les plus
    éloignés possible, le second de chaque paire en miroir) ; un bord de couleur c est
    centré sur l'échantillon c : de part et d'autre du bord, les deux tuiles voisines en
    montrent les deux moitiés, donc le raccord est continu. Dans une tuile, les quatre
    triangles (vers chaque bord) se fondent le long des diagonales."""
    src, sw, sh = floor_source(bg)
    T = WANG_T
    cands = []
    for j in range(0, sh - T + 1, 4):
        for i in range(0, sw - T + 1, 4):
            if all(src[(j + y) * sw + i + x] is not None for y in (0, T // 2, T - 1) for x in (0, T // 2, T - 1)) \
               and all(src[(j + y) * sw + i + x] is not None for y in range(0, T, 8) for x in range(0, T, 8)):
                cands.append((i, j))
    if not cands:
        return None
    picks = [min(cands, key=lambda p: abs(p[0] - (sw - T) / 2))]  # le plus central, puis les plus éloignés
    while len(picks) < 4:
        picks.append(max(cands, key=lambda p: min((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 for q in picks)))

    def sample(k, x, y):
        i, j = picks[k]
        x = min(T - 1, max(0, x)); y = min(T - 1, max(0, y))
        if k % 2:                                     # second échantillon : en miroir
            x = T - 1 - x
        v = src[(j + y) * sw + i + x]
        return v if v is not None else (0.0, 0.0, 0.0)

    half = T // 2

    def cut(fa, fb, rows, diag):
        """Découpe à erreur minimale entre deux échantillons (image quilting) : pour chaque
        rangée, colonne c à partir de laquelle on passe de fa à fb, à au plus WANG_BAND pixels
        de la diagonale et décalée d'au plus 1 d'une rangée à l'autre."""
        cost, back = {}, {}
        prev = None
        for y in rows:
            cur = {}
            for c in range(max(0, diag(y) - WANG_BAND), min(T, diag(y) + WANG_BAND + 1)):
                p, q = fa(c, y), fb(c, y)
                e = sum((p[k] - q[k]) ** 2 for k in range(3))
                if prev is None:
                    cur[c] = e
                else:
                    best = min((prev[c2], c2) for c2 in (c - 1, c, c + 1) if c2 in prev) if any(
                        c2 in prev for c2 in (c - 1, c, c + 1)) else (1e18, c)
                    cur[c] = e + best[0]; back[(y, c)] = best[1]
            cost[y] = cur; prev = cur
        c = min(prev, key=prev.get)
        path = {}
        for y in reversed(rows):
            path[y] = c
            c = back.get((y, c), c)
        return path

    atlas = Image(4 * T, 4 * T)
    for idx in range(16):
        n, e, s_, w_ = idx & 1, (idx >> 1) & 1, (idx >> 2) & 1, (idx >> 3) & 1
        ox, oy = (idx % 4) * T, (idx // 4) * T
        # bords nord et sud sur les échantillons 0/1, bords ouest et est sur 2/3 ; chaque
        # échantillon est centré sur son bord
        fn = lambda x, y, k=n: sample(k, x, y + half)
        fs = lambda x, y, k=s_: sample(k, x, y - half)
        fw = lambda x, y, k=2 + w_: sample(k, x + half, y)
        fe = lambda x, y, k=2 + e: sample(k, x - half, y)
        top, bot = list(range(half)), list(range(half, T))
        # par quart : (rangées, échantillon à gauche de la coupe, à droite, diagonale)
        quarters = ((top, fw, fn, lambda y: y), (top, fn, fe, lambda y: T - 1 - y),
                    (bot, fw, fs, lambda y: T - 1 - y), (bot, fs, fe, lambda y: y))
        for rows, fa, fb, diag in quarters:
            path = cut(fa, fb, rows, diag)
            right = rows is top and fb is fe or rows is bot and fb is fe
            for y in rows:
                c = path[y]
                lo, hi = (half, T) if right else (0, half)
                for x in range(lo, hi):
                    # fondu sur 2 pixels de part et d'autre de la coupe
                    t = min(1.0, max(0.0, (x - c + 2.5) / 5))
                    p, q = fa(x, y), fb(x, y)
                    atlas.put(ox + x, oy + y, bytes(min(255, round(p[k] * (1 - t) + q[k] * t)) for k in range(3)))
    return atlas


def floor_cell(motif, repeated):
    """Texture d'une case : le motif répété (3 × 3 motifs ≈ 3,1 unités) pour un sol pavé ;
    pour un sol peint, la demi-case proche en damier 1 2 / 2 1, 2 étant 1 en miroir (le
    miroir de la case entière, une case sur deux dans la vue 3D, redonne la même case)."""
    if not repeated:
        img = Image(motif.w * 2, motif.h * 2)
        flipped = mirrored(motif)
        for k, part in enumerate((motif, flipped, flipped, motif)):
            img.blit(part, (k % 2) * motif.w, (k // 2) * motif.h)
        return img
    n = round(CELL_UNITS / 1.0)
    img = Image(motif.w * n, motif.h * n)
    for k in range(n * n):
        img.blit(motif, (k % n) * motif.w, (k // n) * motif.h)
    return img


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


# Étage au-dessus des murs (docs/reverse-engineering.md § 9.3g). Certaines décorations (ville
# d'Yvel) sont dessinées au-dessus du mur, à y < 0 : le jeu montre ainsi le bas de l'étage,
# d'autant plus haut que le mur est loin (vue du haut : 8 px au-dessus du mur proche, 20 au-dessus
# du mur à 2 cases, 27 au-dessus du mur à 3 cases). Échelles des positions 1 à 3 de face : murs
# de 128 × 96, 80 × 64 et 48 × 40 pixels.
UPPER_SIZE = {1: (128, 96), 2: (80, 64), 3: (48, 40)}
# décors extérieurs où la vue 3D bâtit des étages (la forêt a déjà ses cimes, § 9.3d ; CIMMERIA
# n'est pas un extérieur)
UPPER_TILESETS = {"YVEL1"}


def upper_layers(ts, pal, dec):
    """Les vues 1 à 3 d'une décoration ramenées à l'échelle du mur proche, sur un calque de
    128 × 120 pixels (ligne 96 = haut du mur ; au-dessus, l'étage). None si la décoration ne
    dépasse pas au-dessus du mur à 3 cases."""
    s3 = dec["shape"][3]
    if s3 == 0xFFFF or dec["y"][3] >= 0 or not (s3 < len(ts.decor_shapes) and ts.decor_shapes[s3]):
        return None
    layers = {}
    for p, (pw, ph) in UPPER_SIZE.items():
        si = dec["shape"][p]
        if si == 0xFFFF or si >= len(ts.decor_shapes) or not ts.decor_shapes[si]:
            continue
        fw, fh, fpx = ts.decor_shapes[si]
        sx, sy = FACE_W / pw, FACE_H / ph
        lay = [None] * (FACE_W * 120)
        places = [(dec["x"][p], False)] + ([(pw - dec["x"][p] - fw, True)] if dec["flags"] & 1 else [])
        y0 = FACE_H + round(dec["y"][p] * sy)
        for x0, flip in places:
            for Y in range(max(0, y0), min(120, y0 + round(fh * sy))):
                fy = min(fh - 1, int((Y - y0) / sy))
                for X in range(max(0, round(x0 * sx)), min(FACE_W, round((x0 + fw) * sx))):
                    fx = min(fw - 1, int((X - x0 * sx) / sx))
                    c = fpx[fy * fw + (fw - 1 - fx if flip else fx)]
                    if c is not None:
                        lay[Y * FACE_W + X] = rgb(pal, c)
        layers[p] = lay
    return layers


def upper_storeys(ts, pal, used_decors):
    """Images de l'étage (128 × 96, transparent là où rien n'est connu), une par décoration.

    Les vues lointaines sont peintes dans la brume. Vue à 2 cases : correction linéaire par
    composante, ajustée (moyenne, écart type) sur les pixels qu'elle partage avec la vue proche,
    toutes décorations confondues. Vue à 3 cases, presque grise : on garde sa luminosité et on
    reprend les couleurs de la vue à 2 cases corrigée, par tranche de luminosité, là où elles se
    recouvrent."""
    all_layers = {d: upper_layers(ts, pal, ts.decor[d]) for d in used_decors if 0 < d < len(ts.decor)}
    all_layers = {d: l for d, l in all_layers.items() if l}
    if not all_layers:
        return {}
    # correction de la vue à 2 cases
    pairs = [(a, b) for l in all_layers.values() if 1 in l and 2 in l
             for a, b in zip(l[2], l[1]) if a is not None and b is not None]
    fix = []
    for c in range(3):
        if len(pairs) < 16:
            fix.append((1.0, 0.0)); continue
        xs = [a[c] for a, _ in pairs]; ys = [b[c] for _, b in pairs]
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        sx_ = (sum((v - mx) ** 2 for v in xs) / len(xs)) ** 0.5 or 1
        sy_ = (sum((v - my) ** 2 for v in ys) / len(ys)) ** 0.5
        fix.append((sy_ / sx_, my - sy_ / sx_ * mx))
    out = {}
    for d, l in all_layers.items():
        if 2 in l:
            l[2] = [None if p is None else tuple(min(255, max(0, round(p[c] * fix[c][0] + fix[c][1])))
                                                  for c in range(3)) for p in l[2]]
        lay3 = l[3]
        ref = l.get(2) or l.get(1)
        if ref:                                    # couleurs de la vue à 3 cases
            lum = lambda p: (p[0] + p[1] + p[2]) / 3
            bins = {}
            for a, b in zip(lay3, ref):
                if a is not None and b is not None:
                    e = bins.setdefault(int(lum(a) // 12), [0, 0, 0, 0, 0])
                    e[0] += b[0]; e[1] += b[1]; e[2] += b[2]; e[3] += lum(a); e[4] += 1
            pts = sorted((e[3] / e[4], [e[c] / e[4] for c in range(3)]) for e in bins.values() if e[4] >= 4)
            if pts:
                def colour(v):
                    if v <= pts[0][0]:
                        return pts[0][1]
                    for (l0, c0), (l1, c1) in zip(pts, pts[1:]):
                        if v <= l1:
                            t = (v - l0) / (l1 - l0)
                            return [c0[c] + (c1[c] - c0[c]) * t for c in range(3)]
                    return pts[-1][1]
                lay3 = [None if p is None else tuple(round(v) for v in colour(lum(p))) for p in lay3]
        img = Image(FACE_W, FACE_H)
        for i in range(FACE_W * FACE_H):
            p = None
            for lay in (l.get(1), l.get(2), lay3):    # la vue la plus proche l'emporte
                if lay and lay[i] is not None:
                    p = lay[i]; break
            if p is not None:
                img.put(i % FACE_W, i // FACE_W, bytes(p))
        out[d] = img
    return out


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


def sprite_conditions(ini):
    """Sprite -> condition d'histoire qui le fait charger (script .INI du niveau).

    Forme rencontrée : testGameFlag(N) (fonction 0x08) [== V] ; ifNotJmp ; loadMonsterShapes
    (fonction 0x0B, branche « vrai ») ; jmp ; loadMonsterShapes (branche « faux »).
    Renvoie {nom: {"flag": N, "eq": V ou None (= drapeau non nul), "when": True/False}}."""
    ck = emc.chunks(ini)
    ins, T = emc.disasm(ck), emc.texts(ck)
    out = {}
    for k, (a, op, p) in enumerate(ins):
        if op != 14 or p & 0xFF != 0x0B or ins[k - 1][1] not in (3, 4):
            continue
        t = ins[k - 1][2]
        if not 0 <= t < len(T):
            continue
        name = T[t].upper().rsplit(".", 1)[0]
        seen_jmp, jmp_target = False, None
        for j in range(k - 2, max(0, k - 80), -1):
            o, q = ins[j][1], ins[j][2]
            if o == 14 and q & 0xFF == 0x0B and not seen_jmp:
                break                                      # chargement inconditionnel avant
            if o == 0 and not seen_jmp:
                seen_jmp, jmp_target = True, q
            if o == 15:                                    # ifNotJmp : la condition est avant
                target = q & 0x7FFF                        # début de la branche « faux »
                if not seen_jmp and target <= a:
                    break                                  # k est après le bloc : sans condition
                if seen_jmp and not (target <= a < (jmp_target or 0)):
                    break
                eq = None
                m = j - 1
                if ins[m][1] == 17 and ins[m][2] == 2 and ins[m - 1][1] in (3, 4):
                    eq, m = ins[m - 1][2], m - 2
                while m > 0 and ins[m][1] == 2:             # pushRetOrPos 0
                    m -= 1
                while m > 0 and ins[m][1] == 12:            # addSP
                    m -= 1
                if ins[m][1] == 14 and ins[m][2] & 0xFF == 0x08 and ins[m - 1][1] in (3, 4):
                    out[name] = {"flag": ins[m - 1][2], "eq": eq, "when": not seen_jmp}
                break
    return out


def level_exits(files, n):
    """Passages scriptés (fonction 0x3C : niveau, case, direction), par case de déclenchement.

    Les arguments sont des constantes dans le script de la case, ou des paramètres d'un
    sous-programme du niveau (pushBPAdd n = n-ième valeur empilée par l'appelant, la dernière
    étant n = 1). Destination dans le même niveau = téléporteur ("teleport": True)."""
    ck = emc.chunks(files[f"LEVEL{n}.INF"])
    ins = emc.disasm(ck)
    o = struct.unpack(f">{len(ck['ORDR']) // 2}H", ck["ORDR"])
    starts = sorted((a, i) for i, a in enumerate(o[:1024]) if a != 0xFFFF)

    def owner(addr):
        b = None
        for s0, i in starts:
            if s0 > addr:
                break
            b = i
        return b

    calls = [(k, ins[k + 1][2]) for k, (a, op, p) in enumerate(ins)
             if op == 2 and p == 1 and k + 1 < len(ins) and ins[k + 1][1] == 0]
    targets = sorted({t for _, t in calls})
    found = []                                         # (case de déclenchement, niveau, case)
    for k, (addr, op, p) in enumerate(ins):
        if op != 14 or p & 0xFF != 0x3C:
            continue
        src = emc.call_args(ins, k, 3)
        if all(o_ in (3, 4) for o_, _ in src[:2]):
            found.append((owner(addr), src[0][1], src[1][1]))
            continue
        sub = max([t for t in targets if t <= addr], default=None)
        for kk, t in calls:
            if t != sub:
                continue
            g, j = [], kk - 1
            while j >= 0 and ins[j][1] in (3, 4):
                g.append(ins[j][2]); j -= 1
            vals = [q if o_ in (3, 4) else g[q - 1] if o_ == 7 and 1 <= q <= len(g) else None for o_, q in src[:2]]
            found.append((owner(ins[kk][0]), *vals))
    out = []
    for b, lvl, blk in found:
        if b is None or not isinstance(lvl, int) or not isinstance(blk, int) or not 0 <= blk < 1024 or not 1 <= lvl < 30:
            continue
        e = {"x": b % 32, "y": b // 32, "level": lvl, "tx": blk % 32, "ty": blk // 32}
        if lvl == n:
            e["teleport"] = True
        if e not in out:
            out.append(e)
    return out


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
    locks_by_level = locks_mod.all_locks(game_dir, maps_dir)
    fragile_by_level = fragile_mod.all_fragile(game_dir, maps_dir)
    os.makedirs(out_dir, exist_ok=True)
    playfld = cps(read_pak(os.path.join(game_dir, "GENERAL.PAK"))["PLAYFLD.CPS"])[1]
    tilesets, index = {}, []
    level_names = read_strings(read_pak(os.path.join(game_dir, "STARTUP.PAK"))["LANDS.FRE"])
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
        # étage au-dessus des murs, d'après les vues lointaines des décorations (§ 9.3g)
        chains = {}
        for wid in walls:
            wt = level["wallTypes"].get(str(wid))
            d, seen = (wt["shape"] if wt else 0), set()
            while 0 < d < len(ts.decor) and d not in seen:
                seen.add(d)
                d = ts.decor[d]["next"]
            chains[wid] = seen
        uppers = upper_storeys(ts, pal, set().union(*chains.values())) if tsname in UPPER_TILESETS and chains else {}
        upper_ids = sorted(uppers)
        for wid, seen in chains.items():
            hit = [upper_ids.index(d) for d in upper_ids if d in seen]
            if hit:
                walls[wid]["upper"] = hit[0]
        if upper_ids:
            ua = Image(FACE_W * ATLAS_COLS, FACE_H * ((len(upper_ids) + ATLAS_COLS - 1) // ATLAS_COLS))
            for k, d in enumerate(upper_ids):
                ua.blit(uppers[d], (k % ATLAS_COLS) * FACE_W, (k // ATLAS_COLS) * FACE_H)
            ua.save(os.path.join(out_dir, f"level{n:02d}_upper.png"))
        bg = background(ts, pal)
        bg.save(os.path.join(out_dir, f"level{n:02d}_bg.png"))
        ceil_img = ceiling_cell(bg, tsname)
        motif, floor_repeated = floor_motif(bg, tsname)
        floor_cell(motif, floor_repeated).save(os.path.join(out_dir, f"level{n:02d}_floor.png"))
        if floor_repeated:
            motif.save(os.path.join(out_dir, f"level{n:02d}_floor_motif.png"))
        wang = None if floor_repeated else wang_tiles(bg)
        if wang is not None:
            wang.save(os.path.join(out_dir, f"level{n:02d}_floor_wang.png"))
        ceil_img.save(os.path.join(out_dir, f"level{n:02d}_ceil.png"))

        # sprites des monstres : images 0-15 (face, profil, dos par groupes de 4, puis attaque)
        # types du niveau : monstres placés, plus ceux que les scripts chargent sans en placer
        mtypes = {str(m["type"]): list(m["sprites"]) for m in level["monsters"] if m["type"] is not None and m["sprites"]}
        for t, names in loaded_monster_types(files, n).items():
            cur = mtypes.setdefault(str(t), [])
            cur.extend(x for x in names if x not in cur)
        sprite_names = sorted({s for m in level["monsters"] for s in m["sprites"]} | {s for v in mtypes.values() for s in v})
        sprite_sigs, sprite_variants, sprite_equip = {}, {}, {}
        sprites, sprite_imgs = {}, []
        sprite_ghost, ghost_auto = {}, []
        tlc = files.get(f"LEVEL{n}.TLC")
        tfit = transparency_fit(tlc, pal) if tlc and len(tlc) >= 256 + 20 * 256 else None
        ghost_imgs = []                  # images de la planche translucide (levelNN_ghost.png)
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
            # version translucide (propriété 0x800 : dite par le moteur sous ScummVM ; sous DOSBox,
            # liste TRANSLUCENT_KNOWN). Exportée pour les sprites surtout en couleurs d'indice de transparence.
            share = translucent_share(frames)
            if tfit and share >= 0.5:
                ghost = []
                for fi in range(16):
                    if fi < len(frames) and frames[fi] and frames[fi][0] > 8:
                        ghost.append(len(ghost_imgs))
                        ghost_imgs.append(ghost_image(frames[fi], pal, *tfit))
                    else:
                        ghost.append(ghost[fi - fi % 4] if fi % 4 and ghost else (ghost[0] if ghost else None))
                sprite_ghost[sname] = ghost
                if sname in TRANSLUCENT_KNOWN:
                    ghost_auto.append(sname)
            # variantes de couleurs (image 16, comme LoLEngine::loadMonsterShapes) : colonne 0 =
            # couleurs d'origine, colonne d = remplacements de la variante d (drapeaux du monstre & 7)
            if len(frames) > 16 and frames[16]:
                w16, h16, px16 = frames[16]
                variants = {}
                for d in range(1, min(8, w16)):
                    pairs = []
                    for r in range(h16):
                        a, b = px16[r * w16], px16[r * w16 + d]
                        if a and b and a != b:
                            pairs.append(list(rgb(pal, a)) + list(rgb(pal, b)))
                    if pairs:
                        variants[str(d)] = pairs
                if variants:
                    sprite_variants[sname] = variants
            # équipement dessiné par-dessus le corps (LoLEngine::drawMonster) : 4 jeux × 16 images,
            # image 17 + jeu * 16 + image du corps ; jeu = equipmentShapes[i] - 1
            equip = []
            for v in range(4):
                row = []
                for fi in range(16):
                    k = 17 + v * 16 + fi
                    if k < len(frames) and frames[k] and frames[k][0] > 1 and any(c is not None for c in frames[k][2]):
                        row.append(len(sprite_imgs))
                        sprite_imgs.append(frame_image(frames[k], pal))
                    else:
                        row.append(None)
                equip.append(row)
            if any(x is not None for row in equip for x in row):
                sprite_equip[sname] = equip
        sx, rects = 0, []
        for img in sprite_imgs:
            rects.append([sx, 0, img.w, img.h]); sx += img.w + 1
        sheet = Image(max(1, sx), max([1] + [i.h for i in sprite_imgs]))
        for img, r in zip(sprite_imgs, rects):
            sheet.blit(img, r[0], 0)
        sheet.save(os.path.join(out_dir, f"level{n:02d}_spr.png"))
        # planche translucide
        ghost_rects = []
        gp = f"level{n:02d}_ghost.png"
        if ghost_imgs:
            gx = 0
            for v in ghost_imgs:
                ghost_rects.append([gx, 0, v.w, v.h]); gx += v.w + 1
            gsheet = Image(max(1, gx), max(v.h for v in ghost_imgs))
            for v, rc in zip(ghost_imgs, ghost_rects):
                gsheet.blit(v, rc[0], 0)
            gsheet.save(os.path.join(out_dir, gp))
        elif os.path.exists(os.path.join(out_dir, gp)):
            os.remove(os.path.join(out_dir, gp))

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
            "monsterTypes": mtypes,
            "spriteSigs": sprite_sigs,
            "spriteVariants": sprite_variants,     # nom -> {variante: [[r, g, b, r2, g2, b2]…]}
            "spriteEquip": sprite_equip,           # nom -> 4 jeux × 16 numéros d'image (ou null)
            "spriteGhost": sprite_ghost,           # nom -> 16 numéros d'image de levelNN_ghost.png (ghostRects)
            "ghostRects": ghost_rects,
            "spriteGhostAuto": ghost_auto,         # translucides connus (version DOSBox, sans drapeau du moteur)
            "spriteConds": sprite_conditions(files[f"LEVEL{n}.INI"]) if f"LEVEL{n}.INI" in files else {},
            "scenes": scenes,   # case -> image du lieu (data/scenes/)
            "locks": locks_by_level.get(n, []),   # serrures : case + clé (tools/locks.py)
            "fragile": fragile_by_level.get(n, []),   # murs fragiles (tools/fragile.py)
            "scripted": scripted_cells(files, n),
            "exits": level_exits(files, n),        # passages vers un autre niveau (fonction 0x3C)
            "labels": [{k: l[k] for k in ("x", "y", "x2", "y2", "text")} for l in level["labels"]],
            "items": [{k: it.get(k) for k in ("x", "y", "xOffs", "yOffs", "type", "name", "spawn", "container", "face")}
                      for it in level.get("items", [])],
            "start": {"x": sx_ + 0.5, "y": sy_ + 0.5, "dir": sa_},
            # sol pavé d'un motif (texture sans raccord) : pas de miroir une case sur deux
            "floorMirror": not floor_repeated,
            # sol peint : tuiles de Wang (levelNN_floor_wang.png), une tuile par demi-case
            "floorWang": {"tile": WANG_T, "perCell": 2} if wang is not None else None,
        }
        # contenu des coffres (tools/chests.py) : objets donnés par le script à l'ouverture
        out["chestItems"] = chests.chest_contents(files[f"LEVEL{n}.INF"], out, ITEM_NAMES) if f"LEVEL{n}.INF" in files else {}
        out["secrets"] = hidden_walls.secret_walls(files[f"LEVEL{n}.INF"], out) if f"LEVEL{n}.INF" in files else []
        with open(os.path.join(out_dir, f"level{n:02d}.json"), "w", encoding="utf-8") as fh:
            json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
        index.append({"level": n, "tileset": tsname,
                      # nom français du niveau : texte 528 + n de LANDS.FRE (§ 7)
                      "frName": level_names[528 + n].strip() if 528 + n < len(level_names) else "",
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

    # objets posés au sol (vue 3D) : image du jeu pour chaque type d'objet (LoLEngine::drawObjects).
    # Drapeau 0x40 du type : image shpIndex de GAMESHP.SHP ; sinon ITEMSHP.SHP, image
    # _gameShapeMap[shpIndex * 2] (table de 276 octets de MAIN.EXE, en 0x2B35C dans la version CD).
    if os.path.exists(table):
        startup = read_pak(os.path.join(game_dir, "STARTUP.PAK"))
        item_shp = lolgfx.shp_frames(startup["ITEMSHP.SHP"])
        game_shp = lolgfx.shp_frames(startup["GAMESHP.SHP"])
        exe = open(os.path.join(game_dir, "MAIN.EXE"), "rb").read()
        at = exe.find(bytes([0x15, 0x5A, 0x05, 0x37, 0x09, 0x38, 0x00, 0x36, 0x00, 0x36]))
        shape_map = exe[at:at + 276] if at >= 0 else b""
        rows = json.load(open(table, encoding="utf-8"))["items"]
        cache, imgs, types = {}, [], []
        for it in rows:
            raw = bytes.fromhex(it["raw"])
            shp, flags = raw[2], raw[3] | raw[4] << 8
            if flags & 0x40:
                key, frames = ("G", shp), game_shp
            else:
                idx = shape_map[shp * 2] if shp * 2 < len(shape_map) else 255
                idx = idx - 256 if idx > 127 else idx
                key, frames = ("I", idx), item_shp
            k = key[1]
            if key not in cache:
                f = frames[k] if 0 <= k < len(frames) else None
                cache[key] = len(imgs) if f and f[0] > 0 else -1
                if cache[key] >= 0:
                    imgs.append(frame_image(f, pal))
            types.append(cache[key])
        # giclée d'un coup reçu par un monstre (LoLEngine::drawMonster) : image 6 de GAMESHP.SHP,
        # couleurs 2-7 décalées selon les drapeaux & 0xC000 du monstre : +0, +63, +15, +74
        blood = []
        w6, h6, px6 = game_shp[6]
        for shift in (0, 63, 15, 74):
            blood.append(len(imgs))
            imgs.append(frame_image((w6, h6, [c + shift if c is not None and 2 <= c <= 7 else c for c in px6]), pal))
        sx, rects = 0, []
        for img in imgs:
            rects.append([sx, 0, img.w, img.h]); sx += img.w + 1
        floor_sheet = Image(max(1, sx), max([1] + [i.h for i in imgs]))
        for img, r in zip(imgs, rects):
            floor_sheet.blit(img, r[0], 0)
        floor_sheet.save(os.path.join(out_dir, "item_floor.png"))
        with open(os.path.join(out_dir, "item_floor.json"), "w", encoding="utf-8") as fh:
            json.dump({"rects": rects, "types": types, "blood": blood}, fh)
        print(f"objets au sol : {len(imgs)} images pour {len(types)} types")

        # emplacements d'équipement vides (LoLEngine::gui_drawCharInventoryItem, version CD) : image
        # slotShapes[emplacement] de GAMESHP.SHP — arme 0x30, bouclier 0x34, tête 0x2E, corps 0x2F,
        # cou 0x32, poignets 0x33, pieds 0x31, anneaux 0x35 (emplacements 0 à 10)
        slot_shapes = [0x30, 0x34, 0x30, 0x34, 0x2E, 0x2F, 0x32, 0x33, 0x31, 0x35, 0x35]
        # une case de 22 × 22 par image, image centrée (les anneaux font 12 × 11) : pas de débordement
        order = sorted(set(slot_shapes))
        C = max(max(game_shp[k][0], game_shp[k][1]) for k in order)
        at = {k: i * (C + 1) for i, k in enumerate(order)}
        sheet = Image(len(order) * (C + 1), C)
        for k in order:
            w_, h_ = game_shp[k][0], game_shp[k][1]
            sheet.blit(frame_image(game_shp[k], pal), at[k] + (C - w_) // 2, (C - h_) // 2)
        sheet.save(os.path.join(out_dir, "slot_shapes.png"))
        with open(os.path.join(out_dir, "slot_shapes.json"), "w", encoding="utf-8") as fh:
            json.dump({"w": len(order) * (C + 1), "h": C, "slots": [[at[k], 0, C, C] for k in slot_shapes]}, fh)


if __name__ == "__main__":
    main(*sys.argv[1:4])
