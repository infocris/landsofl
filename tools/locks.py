"""Serrures : où chaque clé s'utilise, d'après les scripts d'événements des niveaux (.INF).

Quand on clique sur un mur, le jeu exécute le script de la case (table ORDR, § 8). Une
serrure lit l'objet en main (fonction 0x53), prend son type (fonction 0x12, paramètre 4)
et le compare au type de la clé. Deux formes rencontrées :
  - comparaison directe dans le script de la case : « push <clé> ; eval == » ;
  - appel d'un sous-programme du niveau qui lit l'objet en main, avec la clé en argument.
La case de la serrure est celle dont le script contient la comparaison ou l'appel.
Clés = types d'objets dont le drapeau 0x0100 est présent (octets 3-4 de la table, § 8.2).

Usage autonome : python3 -I tools/locks.py <dossier LOLCD>
"""
import json, os, struct, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pak import read_pak
import emc

FN_ITEM_IN_HAND = 0x53
TABLE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "items_fr.json")


def key_types():
    items = json.load(open(TABLE, encoding="utf-8"))["items"]
    return {i["type"]: i["name"] for i in items if bytes.fromhex(i["raw"])[4] & 1}


def level_locks(inf, keys):
    """-> [(case, type de clé, "direct" | "sous-programme")]"""
    ck = emc.chunks(inf)
    ins = emc.disasm(ck)
    idx = {a: k for k, (a, _, _) in enumerate(ins)}
    o = struct.unpack(f">{len(ck['ORDR']) // 2}H", ck["ORDR"])
    starts = sorted((a, i) for i, a in enumerate(o) if a != 0xFFFF and i < 1024)

    def owner(addr):
        b = None
        for s, i in starts:
            if s > addr:
                break
            b = i
        return b

    memo = {}

    def reads_hand(target, depth=0):          # le sous-programme (ou un qu'il appelle) lit l'objet en main
        if (target, depth) in memo:
            return memo[(target, depth)]
        k, res = idx.get(target), False
        if k is not None and depth <= 3:
            for m in range(k, min(k + 400, len(ins))):
                _, op, p = ins[m]
                if op == 14 and p & 0xFF == FN_ITEM_IN_HAND:
                    res = True; break
                if op == 2 and p == 1 and m + 1 < len(ins) and ins[m + 1][1] == 0 \
                        and reads_hand(ins[m + 1][2], depth + 1):
                    res = True; break
                if op == 8 and p == 1:        # retour
                    break
        memo[(target, depth)] = res
        return res

    out = set()
    for k in range(1, len(ins)):
        addr, op, p = ins[k]
        if op in (3, 4) and p in keys and k + 1 < len(ins) and ins[k + 1][1] == 17 and ins[k + 1][2] == 2:
            out.add((owner(addr), p, "direct"))
        if op == 2 and p == 1 and k + 1 < len(ins) and ins[k + 1][1] == 0 and reads_hand(ins[k + 1][2]):
            j, args = k - 1, []
            while j >= 0 and ins[j][1] in (3, 4) and len(args) < 12:
                args.append(ins[j][2]); j -= 1
            for v in args:
                if v in keys:
                    out.add((owner(addr), v, "sous-programme"))
    # une même serrure trouvée des deux façons : on garde « direct »
    best = {}
    for b, t, how in out:
        if b is None:
            continue
        if (b, t) not in best or how == "direct":
            best[(b, t)] = how
    return sorted((b, t, how) for (b, t), how in best.items())


def all_locks(game_dir):
    """-> {niveau: [{"x", "y", "key", "name", "how"}]}"""
    keys = key_types()
    res = {}
    for n in range(1, 30):
        p = os.path.join(game_dir, f"L{n:02d}.PAK")
        if not os.path.exists(p):
            continue
        f = read_pak(p)
        if f"LEVEL{n}.INF" not in f:
            continue
        res[n] = [{"x": b % 32, "y": b // 32, "key": t, "name": keys[t], "how": how}
                  for b, t, how in level_locks(f[f"LEVEL{n}.INF"], keys)]
    return res


if __name__ == "__main__":
    locks = all_locks(sys.argv[1])
    keys = key_types()
    used = {l["key"] for ls in locks.values() for l in ls}
    for n, ls in locks.items():
        for l in ls:
            print(f"niveau {n:2d} case {l['x']:2d},{l['y']:2d}  {l['name']} ({l['key']}, {l['how']})")
    print(f"{len(used)} clés sur {len(keys)} localisées ; sans serrure trouvée :",
          ", ".join(f"{keys[t]} ({t})" for t in sorted(set(keys) - used)))
