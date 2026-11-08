"""Murs fragiles : murs qu'on casse en les frappant avec un objet précis (le Marteau).

Lecture des scripts d'événements (LEVELn.INF, § 8) : un script teste le type de l'objet
utilisé (fonction 0x12, paramètre 4, comparé à une constante), puis modifie un mur dans
les instructions qui suivent : changement de type (fonction 0x00 : case, face, type) ou
appel d'un sous-programme du niveau avec la case en argument (« casser » = fonction 0x00
avec face -1 et type 0). La case doit être un mur dans la grille d'origine.

Usage autonome : python3 -I tools/fragile.py <dossier LOLCD> <dossier maps>
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pak import read_pak
import emc

TABLE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "items_fr.json")
WINDOW = 40          # instructions examinées après le test de l'objet
TOOLS = {59, 28}     # Marteau, Pioche : les autres objets testés ouvrent des passages, pas des murs fragiles


def level_fragile(inf, is_wall, keys):
    """-> [(case, type d'objet)] ; is_wall(case) dit si la case est un mur à l'origine."""
    ins = emc.disasm(emc.chunks(inf))
    out = set()
    for m in range(len(ins) - 4):
        # getItemParam(x, 4) ; addSP ; pushRetOrPos ; push T ; eval ==
        if not (ins[m][1] == 14 and ins[m][2] & 0xFF == 0x12 and ins[m - 2][1] in (3, 4) and ins[m - 2][2] == 4
                and ins[m + 3][1] in (3, 4) and ins[m + 4][1] == 17 and ins[m + 4][2] == 2):
            continue
        tool = ins[m + 3][2]
        if tool in keys or tool not in TOOLS:  # serrures : tools/locks.py
            continue
        for k in range(m + 5, min(m + WINDOW, len(ins))):
            op, p = ins[k][1], ins[k][2]
            blk = None
            if op == 14 and p & 0xFF == 0 and k >= 3 and all(ins[k - i][1] in (3, 4) for i in (1, 2, 3)):
                blk = ins[k - 1][2]                       # setWall(case, face, type)
            elif op == 2 and p == 1 and k + 1 < len(ins) and ins[k + 1][1] == 0 and ins[k - 1][1] in (3, 4):
                blk = ins[k - 1][2]                       # sous-programme(case)
            if blk is not None and 0 <= blk < 1024 and is_wall(blk):
                out.add((blk, tool))
            if op == 8 and p == 1:                        # fin du script
                break
    return sorted(out)


def all_fragile(game_dir, maps_dir):
    items = json.load(open(TABLE, encoding="utf-8"))["items"]
    keys = {i["type"] for i in items if bytes.fromhex(i["raw"])[4] & 1}
    res = {}
    for n in range(1, 30):
        p = os.path.join(game_dir, f"L{n:02d}.PAK")
        mp = os.path.join(maps_dir, f"level{n:02d}.json")
        if not os.path.exists(p) or not os.path.exists(mp):
            continue
        f = read_pak(p)
        if f"LEVEL{n}.INF" not in f:
            continue
        cells = json.load(open(mp, encoding="utf-8"))["cells"]
        is_wall = lambda b: cells[b // 32][b % 32].startswith("wall")
        res[n] = [{"x": b % 32, "y": b // 32, "tool": t, "toolName": items[t]["name"] if 0 < t < len(items) else str(t)}
                  for b, t in level_fragile(f[f"LEVEL{n}.INF"], is_wall, keys)]
    return res


if __name__ == "__main__":
    for n, ls in all_fragile(sys.argv[1], sys.argv[2]).items():
        for l in ls:
            print(f"niveau {n:2d} case {l['x']:2d},{l['y']:2d}  outil : {l['toolName']} ({l['tool']})")
