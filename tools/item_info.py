"""Fiche descriptive d'un type d'objet, à partir de son entrée de 13 octets (table en RAM, § 8.2).

Champs (docs/retro-conception.md, § 8.2) :
  0-1  n° de texte du nom (0x4000 + index LANDS.FRE)     2  icône (ITEMICN.SHP)
  3-4  drapeaux (sens non établi)                        5-6  emplacements d'équipement (bits)
  7    action quand on utilise l'objet (point d'entrée de ITEM.INF, 0xFF = aucune)
  8    force (ou paramètre de l'action)                  9    second paramètre
  10   protection                                       11-12 valeur (supposée)

Usage autonome : python3 -I tools/item_info.py <dossier LOLCD>  (écrit un aperçu sur la sortie)
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pak import read_pak, read_strings

# bits du masque d'emplacements = numéro de l'emplacement d'équipement (11 emplacements)
SLOT_NAMES = ["arme", "bouclier", "arme", "bouclier", "tête", "corps", "cou", "poignets",
              "pieds", "anneau", "anneau"]
# n° de sort des parchemins et baguettes, nommés d'après les parchemins de la table
SPELLS = {2: "Gel", 3: "Boules de feu", 4: "Poing mortel", 5: "Brume fatale", 6: "Foudre", 7: "Vortex"}


def slots_label(mask):
    if mask & 0x05 == 0x05: return "Arme (main)"
    if mask & 0x0A == 0x0A: return "Bouclier (main)"
    for bit, name in ((4, "Tête"), (5, "Corps"), (6, "Cou"), (7, "Poignets"), (8, "Pieds"), (9, "Doigt (anneau)")):
        if mask & (1 << bit): return name
    return None


def describe(raw, names, strings):
    """raw : 13 octets ; names : noms par type ; strings : textes LANDS.FRE. -> dict JSON."""
    b = raw
    mask = b[5] | b[6] << 8
    func, p1, p2, prot = b[7], b[8], b[9], b[10]
    value = b[11] | b[12] << 8
    out = {"slots": [k for k in range(11) if mask >> k & 1], "func": func, "value": value}
    effects = []
    kind = slots_label(mask)
    if func == 0x00 and kind:
        kind = "Arme de corps à corps"
        effects.append(f"Force +{p1}")
    elif func == 0x0B:
        kind = "Arme de jet / à distance"
        ammo = names[p1] if 0 < p1 < len(names) else f"type {p1}"
        effects.append(f"Munition : {ammo}")
        effects.append(f"Force +{p2}")
    elif func in (0x02, 0x19):
        kind = "Arme à lancer" if mask else "Munition"
        effects.append(f"Dégâts {p1}" + (" (empoisonnée)" if func == 0x19 else ""))
    elif func == 0x04:
        kind = "Soin (à utiliser)"
        effects.append(f"Rend {p1} à {p2} points de vie (au hasard)")
        if b[0] | b[1] << 8 == 0x4155:            # Ginseng (ITEM.INF, point d'entrée 4)
            effects.append("Guérit aussi le poison")
    elif func == 0x0E:
        kind = "Parchemin de sort"
        effects.append(f"Lance le sort « {SPELLS.get(p1, f'n° {p1}')} »")
    elif func == 0x14:
        kind = "Baguette / bâton magique"
        effects.append(f"Lance le sort « {SPELLS.get(p1, f'n° {p1}')} »")
    elif func == 0x0C:
        kind = "Texte à lire"
        tid = p1 | p2 << 8
        if 0x4000 <= tid < 0x4000 + len(strings) and strings[tid - 0x4000].strip():
            out["text"] = strings[tid - 0x4000].strip()
    elif kind is None and func == 0xFF:
        kind = "Objet (clé, quête, trésor…)"
    elif kind is None:
        kind = "Objet utilisable"
        effects.append(f"Action spéciale (script n° {func} de ITEM.INF, non décodée)")
    elif kind == "Doigt (anneau)" and not prot:
        effects.append("Effet magique non décodé")
    if prot:
        effects.append(f"Protection +{prot}")
    if mask:
        out["wear"] = ", ".join(dict.fromkeys(SLOT_NAMES[k] for k in out["slots"]))
    out["kind"] = kind
    out["effects"] = effects
    return out


def build(game_dir, table_path):
    items = json.load(open(table_path, encoding="utf-8"))["items"]
    strings = read_strings(read_pak(os.path.join(game_dir, "STARTUP.PAK"))["LANDS.FRE"])
    names = [i["name"] for i in items]
    out = [{"name": i["name"], "icon": i["shape"], **describe(bytes.fromhex(i["raw"]), names, strings)}
           for i in items]
    # clés : serrures où elles s'utilisent (tools/locks.py)
    import locks
    for n, ls in locks.all_locks(game_dir).items():
        for l in ls:
            out[l["key"]].setdefault("locks", []).append({"level": n, "x": l["x"], "y": l["y"], "how": l["how"],
                                                          "kind": l["kind"]})
    for t, i in enumerate(items):
        if bytes.fromhex(i["raw"])[4] & 1:
            out[t]["kind"] = "Clé"
    return out


if __name__ == "__main__":
    table = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "items_fr.json")
    for t, d in enumerate(build(sys.argv[1], table)):
        print(t, d["name"], "|", d["kind"], "|", "; ".join(d["effects"]), "|", d.get("wear", ""), "|", d.get("text", "")[:50])
