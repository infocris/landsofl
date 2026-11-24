"""Décompression Westwood : LCW (« format 80 ») et conteneur CPS."""
import struct

def lcw(src, size):
    dst = bytearray()
    i = 0
    while len(dst) < size and i < len(src):
        c = src[i]; i += 1
        if c & 0x80 == 0:                      # copie relative courte
            n = (c >> 4) + 3
            rel = ((c & 0x0F) << 8) | src[i]; i += 1
            for _ in range(n): dst.append(dst[-rel])
        elif c & 0x40 == 0:                    # littéraux
            if c == 0x80: break
            n = c & 0x3F
            dst += src[i:i + n]; i += n
        else:
            if c == 0xFE:                      # remplissage
                n, v = struct.unpack_from("<HB", src, i); i += 3
                dst += bytes([v]) * n
            elif c == 0xFF:                    # copie absolue longue
                n, pos = struct.unpack_from("<HH", src, i); i += 4
                for k in range(n): dst.append(dst[pos + k])
            else:                              # copie absolue courte
                n = (c & 0x3F) + 3
                pos = struct.unpack_from("<H", src, i)[0]; i += 2
                for k in range(n): dst.append(dst[pos + k])
    return bytes(dst[:size])

def cps(data):
    """Renvoie (données décompressées, palette éventuelle)."""
    _, comp, usize, palsize = struct.unpack_from("<HHIH", data, 0)
    pal = data[10:10 + palsize]
    body = data[10 + palsize:]
    if comp == 0: return body[:usize], pal
    if comp == 4: return lcw(body, usize), pal
    raise ValueError(f"compression CPS {comp} non gérée")


def frame_delta(dst, src):
    """Delta « format 40 » appliqué en XOR sur dst (Screen::decodeFrameDelta de ScummVM)."""
    i = p = 0
    while True:
        c = src[i]; i += 1
        if c == 0:                                     # répétition courte d'une valeur
            n, v = src[i], src[i + 1]; i += 2
            for _ in range(n): dst[p] ^= v; p += 1
        elif c & 0x80:
            c -= 0x80
            if c:                                      # saut court
                p += c
                continue
            sc = src[i] | src[i + 1] << 8; i += 2
            if sc == 0:                                # fin
                break
            if not sc & 0x8000:                        # saut long
                p += sc
            elif sc & 0x4000:                          # répétition longue
                v = src[i]; i += 1
                for _ in range(sc - 0xC000): dst[p] ^= v; p += 1
            else:                                      # copie longue
                for _ in range(sc - 0x8000): dst[p] ^= src[i]; i += 1; p += 1
        else:                                          # copie courte
            for _ in range(c): dst[p] ^= src[i]; i += 1; p += 1


def wsa_frames(data):
    """Animation WSA v2 (WSAMovie_v2::open) -> (largeur, hauteur, [images en index de palette]).

    En-tête : images, décalage x, décalage y, largeur, hauteur, taille du tampon delta, drapeaux
    (bit 0 : palette de 768 octets après la table) ; table de (images + 2) décalages u32, comptés
    sans la palette. Chaque image : LCW -> delta XOR appliqué à l'image précédente."""
    n, _xa, _ya, w, h, dsz, fl = struct.unpack_from("<HhhHHHH", data)
    offs = struct.unpack_from(f"<{n + 2}I", data, 14)
    base = 14 + 4 * (n + 2) + (768 if fl & 1 else 0)
    buf, out = bytearray(w * h), []
    for k in range(n):
        if offs[k] == 0:
            continue
        a, b = base + offs[k] - offs[0], base + offs[k + 1] - offs[0]
        frame_delta(buf, lcw(data[a:b], max(dsz, w * h) * 2))
        out.append(bytes(buf))
    return w, h, out
