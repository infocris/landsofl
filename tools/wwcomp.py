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
