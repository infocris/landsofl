"""Lecture des archives .PAK Westwood (Lands of Lore)."""
import struct, sys

def read_pak(path):
    data = open(path, "rb").read()
    entries, pos = [], 0
    while True:
        off = struct.unpack_from("<I", data, pos)[0]
        if off == 0 or off > len(data): break
        end = data.index(b"\0", pos + 4)
        name = data[pos + 4:end].decode("latin-1")
        pos = end + 1
        if not name: break
        entries.append([name, off])
        if pos >= entries[0][1]: break
    out = {}
    for i, (name, off) in enumerate(entries):
        nxt = entries[i + 1][1] if i + 1 < len(entries) else len(data)
        out[name] = data[off:nxt]
    return out

if __name__ == "__main__":
    for p in sys.argv[1:]:
        files = read_pak(p)
        print(p.split("/")[-1], ":", ", ".join(f"{n}({len(d)})" for n, d in files.items()))


# Textes Westwood (Kyra / Lands of Lore) : paires de lettres fréquentes codées sur un
# octet >= 0x80, et 0x1B + c = caractère CP850 (c + 0x7F) pour les accents.
_T1 = " etainosrlhcdupm"
_T2 = ("tasio wb rnsdalmh ieorasnrtlc synstcloer dtgesionr ufmsw tep.icae "
       "oiadur laeiyodeia otruetoakhlr eiu,.oansrctlaileoiratpeaoip bm")


def decode_text(raw):
    out, i = bytearray(), 0
    while i < len(raw):
        c = raw[i]; i += 1
        if c == 0x1B and i < len(raw):
            out.append((raw[i] + 0x7F) & 0xFF); i += 1
        elif c & 0x80:
            c &= 0x7F
            out += (_T1[c >> 3] + _T2[c]).encode("cp850")
        else:
            out.append(c)
    return out.decode("cp850")


def read_strings(blob):
    import struct
    n = struct.unpack_from("<H", blob)[0] // 2
    offs = struct.unpack_from(f"<{n}H", blob)
    return [decode_text(blob[o:blob.index(b"\0", o)]) for o in offs]
