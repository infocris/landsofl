"""Passages cachés : murs que les scripts des niveaux (.INF) font disparaître.

Un script appelle setWall (fonction 0x00 : case, face, type de mur) avec la face -1 (les
quatre faces) et le type 0 (vide) sur une case qui est un mur dans la carte d'origine : le
mur s'efface et ouvre un passage. D'autres appels remettent un type de mur plein sur la même
case (le passage se referme). Les appels dans des sous-programmes sont attribués aux cases
qui les appellent (même méthode que tools/chests.py).

Condition : le script compare souvent un objet au type attendu, juste avant l'appel :
getItemParam(objet, 4) (fonction 0x12, paramètre 4 = type) puis « push <type> ; eval == ».
L'objet vient de la fonction 0x53 (objet en main) ou d'un registre du script (objet posé ou
lancé sur la case, déduit). Murs faux (traversables) : voir minimap.js, non exportés ici.

Usage autonome : python3 -I tools/hidden_walls.py <dossier maps>   (lit maps/raw/LEVELnn.INF)
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import chests, emc

FN_SETWALL = 0x00
FN_ITEM_PARAM = 0x12
FN_HAND = 0x53


def _item_condition(ins, start, k):
    """Type d'objet comparé entre le début du script de la case (index start) et l'appel k."""
    found = None
    for j in range(start, k):
        a, op, p = ins[j]
        if op != 14 or p & 0xFF != FN_ITEM_PARAM:
            continue
        src = emc.call_args(ins, j, 2)
        if len(src) < 2 or src[1] != (4, 4):
            continue
        for jj in range(j + 1, min(j + 8, k)):
            if ins[jj][1] in (3, 4) and jj + 1 < len(ins) and ins[jj + 1][1:] == (17, 2):
                hand = any(ins[h][1] == 14 and ins[h][2] & 0xFF == FN_HAND for h in range(start, j))
                found = {"item": ins[jj][2], "hand": hand}
                break
    return found


def secret_walls(inf, level):
    """-> [{"x", "y", "open": [{"x", "y", "item"?, "hand"?}], "close": [{"x", "y"}]}]"""
    cells = level["cells"]
    cells = cells if isinstance(cells[0], str) else [c for row in cells for c in row]
    ins = emc.disasm(emc.chunks(inf))
    index = {a: k for k, (a, _, _) in enumerate(ins)}
    res = {}
    for owners, args, addr in chests.fn_calls(inf, FN_SETWALL, with_addr=True):
        if len(args) < 3 or not isinstance(args[0], int) or not 0 <= args[0] < 1024 or args[1] != -1:
            continue
        b, typ = args[0], args[2]
        if not cells[b].startswith("wall") or typ is None:
            continue
        e = res.setdefault(b, {"x": b % 32, "y": b // 32, "open": [], "close": []})
        for o in sorted(owners):
            trig = {"x": o % 32, "y": o // 32}
            if typ == 0:
                start = index[addr]
                while start > 0 and ins[start - 1][1] != 8:     # début du script (après le retour précédent)
                    start -= 1
                cond = _item_condition(ins, start, index[addr])
                if cond:
                    trig.update(cond)
                if trig not in e["open"]:
                    e["open"].append(trig)
            elif trig not in e["close"]:
                e["close"].append(trig)
    return [e for e in res.values() if e["open"]]


if __name__ == "__main__":
    maps = sys.argv[1]
    for n in range(1, 30):
        p = os.path.join(maps, "raw", f"LEVEL{n:02d}.INF")
        if not os.path.exists(p):
            continue
        lv = json.load(open(os.path.join(maps, f"level{n:02d}.json"), encoding="utf-8"))
        for e in secret_walls(open(p, "rb").read(), lv):
            print(n, e)
