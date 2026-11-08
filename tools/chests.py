"""Contenu des coffres : objets donnés par les scripts des niveaux (.INF) quand on les ouvre.

Un coffre est une face de mur dont le symbole de carte vaut 210 (§ 6.1). Son script (case du
mur, table ORDR) appelle un sous-programme générique de serrure, puis la fonction 0x49
« donner un objet » (type, valeur, 0) pour chaque objet. La valeur est un nombre de pièces
(Bourse) ou de charges (Coupe Bezel, baguettes), d'après les objets concernés (déduit).
Objets fragiles : le script teste un état (getWall(992, 3) == -2, sans doute « coffre
cassé ») et donne alors un Verre cassé (247) à la place de l'objet suivant (déduit).

Les appels peuvent être dans des sous-programmes : on remonte aux cases qui les appellent.
Usage autonome : python3 -I tools/chests.py <dossier LOLCD> <dossier viewer/data>
"""
import json, os, struct, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pak import read_pak
import emc

FN_GIVE = 0x49
BROKEN_GLASS = 247
CHEST_SYMBOL = 210


def give_calls(inf):
    """-> [(cases propriétaires, [type, valeur, …])] dans l'ordre du script."""
    return fn_calls(inf, FN_GIVE)


def fn_calls(inf, fn, with_addr=False):
    """Appels à la fonction fn avec un premier argument constant :
    [(cases propriétaires, [arguments…])] (+ adresse de l'appel si with_addr)."""
    ck = emc.chunks(inf)
    ins = emc.disasm(ck)
    o = struct.unpack(f">{len(ck['ORDR']) // 2}H", ck["ORDR"])
    starts = sorted((a, i) for i, a in enumerate(o[:1024]) if a != 0xFFFF)
    calls = [(k, ins[k + 1][2]) for k, (a, op, p) in enumerate(ins)
             if op == 2 and p == 1 and k + 1 < len(ins) and ins[k + 1][1] == 0]
    targets = sorted({t for _, t in calls})

    def cell_start(a):
        r = None
        for s, i in starts:
            if s > a:
                break
            r = (s, i)
        return r

    def owners(a, depth=0):
        cs = cell_start(a)
        sub = max([t for t in targets if t <= a], default=None)
        if sub is not None and (cs is None or sub > cs[0]):      # dans un sous-programme
            if depth > 4:
                return set()
            out = set()
            for kk, t in calls:
                if t == sub:
                    out |= owners(ins[kk][0], depth + 1)
            return out
        return {cs[1]} if cs else set()

    res = []
    for k, (a, op, p) in enumerate(ins):
        if op == 14 and p & 0xFF == fn:
            n = ins[k + 1][2] if k + 1 < len(ins) and ins[k + 1][1] == 12 else 0
            src = emc.call_args(ins, k, n)
            if src and src[0][0] in (3, 4):
                args = [q if o_ in (3, 4) else None for o_, q in src]
                res.append((owners(a), args, a) if with_addr else (owners(a), args))
    return res


def chest_cells(level):
    ids = {int(k) for k, v in level["wallTypes"].items() if v[2] == CHEST_SYMBOL}
    fc = level["faces"]
    return sorted({i for i in range(1024) for f in range(4) if fc[i * 4 + f] in ids})


def chest_contents(inf, level, names):
    """-> {case: [{"type", "name", "value"?, "fragile"?}]}"""
    gc = give_calls(inf)
    out = {}
    for c in chest_cells(level):
        lst, pending_glass = [], False
        for own, args in gc:
            if c not in own or not 0 <= args[0] < len(names):
                continue
            if args[0] == BROKEN_GLASS:
                pending_glass = True
                continue
            e = {"type": args[0], "name": names[args[0]]}
            if len(args) > 1 and args[1]:
                e["value"] = args[1]
            if pending_glass:
                e["fragile"] = True
                pending_glass = False
            lst.append(e)
        if lst:
            out[str(c)] = lst
    return out


if __name__ == "__main__":
    game, data = sys.argv[1], sys.argv[2]
    names = [i["name"] for i in json.load(open(os.path.join(data, "items.json"), encoding="utf-8"))]
    found = total = 0
    for n in range(1, 30):
        p = os.path.join(data, f"level{n:02d}.json")
        if not os.path.exists(p):
            continue
        lvl = json.load(open(p, encoding="utf-8"))
        f = read_pak(os.path.join(game, f"L{n:02d}.PAK"))
        if f"LEVEL{n}.INF" not in f:
            continue
        cc = chest_contents(f[f"LEVEL{n}.INF"], lvl, names)
        cells = chest_cells(lvl)
        total += len(cells); found += len(cc)
        for c in cells:
            items = cc.get(str(c), [])
            print(f"niveau {n:2d} coffre {c % 32},{c // 32} : " + (", ".join(
                e["name"] + (f" ({e['value']})" if "value" in e else "") + (" [fragile]" if e.get("fragile") else "")
                for e in items) or "contenu non trouvé"))
    print(f"{found} coffres sur {total} avec un contenu trouvé")
