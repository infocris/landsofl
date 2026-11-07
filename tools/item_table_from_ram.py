"""Extrait la table des objets de Lands of Lore d'un vidage de la RAM émulée.

Usage : python3 -I tools/item_table_from_ram.py <ram.bin (16 Mo)> <dossier LOLCD> <sortie.json>

La table n'existe telle quelle dans aucun exécutable : le jeu la construit au
chargement. En RAM (version CD FR) : adresse physique 0x8AA05, 285 entrées de 13 octets,
index = type d'objet (celui des scripts, fonction 0x11). Octets 0-1 = n° de texte du nom
(0x4000 + index dans LANDS.FRE), octet 2 = n° d'image (déduit), le reste est inconnu.
La table est retrouvée par sa forme (suite régulière de numéros de texte), puis vérifiée.
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pak import read_pak, read_strings

ENTRY = 13


def main(ram_path, game_dir, out_path):
    ram = open(ram_path, "rb").read()
    names = read_strings(read_pak(os.path.join(game_dir, "STARTUP.PAK"))["LANDS.FRE"])
    is_name = lambda o: 0x4000 <= (ram[o] | ram[o + 1] << 8) < 0x4000 + len(names)
    # plus longue suite de numéros de texte espacés de 13 octets
    best = (0, 0)
    o = 0
    seen = set()
    for o in range(len(ram) - ENTRY):
        if o in seen or not is_name(o) or (o >= ENTRY and is_name(o - ENTRY)):
            continue
        n, q = 0, o
        while q < len(ram) - 1 and is_name(q):
            seen.add(q); n += 1; q += ENTRY
        if n > best[0]:
            best = (n, o)
    count, start = best
    first = names[(ram[start] | ram[start + 1] << 8) - 0x4000]
    if count < 200 or first != "Objet illégal":
        sys.exit(f"table non trouvée (meilleure suite : {count} à {start:#x}, « {first} »)")
    items = []
    for t in range(count):
        e = ram[start + t * ENTRY:start + (t + 1) * ENTRY]
        items.append({"type": t, "name": names[(e[0] | e[1] << 8) - 0x4000], "shape": e[2], "raw": e.hex()})
    json.dump({"ramAddress": start, "entrySize": ENTRY, "items": items},
              open(out_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{count} objets, table à {start:#x}")


if __name__ == "__main__":
    main(*sys.argv[1:4])
