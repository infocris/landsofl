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
