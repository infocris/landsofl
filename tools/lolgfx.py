"""Graphismes des décors de Lands of Lore : VCN (tuiles 8x8) et VMP (assemblages)."""
import struct, zlib
from wwcomp import cps


def write_png(path, w, h, rgb):
    raw = b"".join(b"\0" + bytes(rgb[y * w * 3:(y + 1) * w * 3]) for y in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def write_png_rgba(path, w, h, rgba):
    raw = b"".join(b"\0" + bytes(rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
                           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


class VCN:
    def __init__(self, data):
        v, _ = cps(data)
        n = struct.unpack_from("<H", v)[0]
        o = 2
        self.n = n
        self.shift = v[o:o + n]; o += n
        self.coltable = v[o:o + 128]; o += 128
        self.palette = v[o:o + 384]; o += 384    # 128 couleurs VGA 6 bits
        self.blocks = v[o:o + 32 * n]

    def tile(self, idx, flip=False):
        """64 index de couleur (0-255) de la tuile idx."""
        b = self.blocks[idx * 32:(idx + 1) * 32]
        sh = self.shift[idx]
        out = []
        for y in range(8):
            row = []
            for x in range(4):
                c = b[y * 4 + x]
                row += [self.coltable[sh + (c >> 4)], self.coltable[sh + (c & 15)]]
            if flip:
                row.reverse()
            out += row
        return out


def vmp(data):
    m, _ = cps(data)
    n = struct.unpack_from("<H", m)[0]
    return list(struct.unpack_from(f"<{n}H", m, 2))


def shp_frames(data):
    """Images d'un fichier .SHP (Kyra 2 / Lands of Lore) : [(w, h, pixels)], pixel None = transparent.

    Fichier : éventuellement CPS ; u16 nombre, u32 offsets (relatifs à l'octet 2).
    Image : u16 drapeaux, u8 hauteur, u16 largeur, u8 hauteur, u16 taille, u16 taille décompressée ;
      si drapeaux & 1 : table de couleurs (u8 taille si drapeaux & 4, sinon 16) ;
      données LCW (sauf drapeaux & 2) puis RLE : 0, n = n pixels transparents."""
    from wwcomp import lcw
    if struct.unpack_from("<H", data, 2)[0] == 4:          # conteneur CPS
        data, _ = cps(data)
    n = struct.unpack_from("<H", data)[0]
    offs = struct.unpack_from(f"<{n + 1}I", data, 2)
    frames = []
    for k in range(n):
        if offs[k] == 0:
            frames.append(None); continue
        o = offs[k] + 2
        flags, h, w, _, _, usize = struct.unpack_from("<HBHBHH", data, o)
        p = o + 10
        table = None
        if flags & 1:
            tsz = data[p] if flags & 4 else 16
            p += 1 if flags & 4 else 0
            table = data[p:p + tsz]; p += tsz
        raw = data[p:] if flags & 2 else lcw(data[p:], usize)
        px, i = [], 0
        while len(px) < w * h and i < len(raw):
            b = raw[i]; i += 1
            if b == 0:
                px += [None] * raw[i]; i += 1
            else:
                px.append(table[b] if table is not None and b < len(table) else b)
        px += [None] * (w * h - len(px))
        frames.append((w, h, px[:w * h]))
    return frames
