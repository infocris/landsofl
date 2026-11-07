"""Lecture des scripts EMC2 de Westwood (.INI/.INF de Lands of Lore).

Chunks IFF : ORDR (points d'entrée), TEXT (chaînes), DATA (mots u16 big-endian).
Mot d'instruction : bit15 -> saut (opcode 0, param = mot & 0x7FFF)
                    bit14 -> param = octet bas signé ; bit13 -> param = mot suivant
                    opcode = (mot >> 8) & 0x1F
"""
import struct

OPS = {0: "jmp", 1: "setRet", 2: "pushRetOrPos", 3: "push", 4: "push", 5: "pushReg",
       6: "pushBPNeg", 7: "pushBPAdd", 8: "popRetOrPos", 9: "popReg", 10: "popBPNeg",
       11: "popBPAdd", 12: "addSP", 13: "subSP", 14: "call", 15: "ifNotJmp",
       16: "negate", 17: "eval", 18: "setRetAndJmp"}


def chunks(blob):
    assert blob[:4] == b"FORM" and blob[8:12] == b"EMC2", "pas un script EMC2"
    out, pos = {}, 12
    while pos + 8 <= len(blob):
        tag = blob[pos:pos + 4].decode("latin-1")
        size = struct.unpack_from(">I", blob, pos + 4)[0]
        out[tag] = blob[pos + 8:pos + 8 + size]
        pos += 8 + size + (size & 1)
    return out


def texts(ck):
    t = ck.get("TEXT", b"")
    if not t:
        return []
    n = struct.unpack_from(">H", t)[0] // 2
    return [t[o:t.index(b"\0", o)].decode("latin-1") for o in struct.unpack_from(f">{n}H", t)]


def disasm(ck):
    d = ck["DATA"]
    words = struct.unpack(f">{len(d) // 2}H", d[:len(d) // 2 * 2])
    i, out = 0, []
    while i < len(words):
        addr, w = i, words[i]; i += 1
        if w & 0x8000:
            out.append((addr, 0, w & 0x7FFF)); continue
        op = (w >> 8) & 0x1F
        if w & 0x4000:
            p = struct.unpack("b", bytes([w & 0xFF]))[0]
        elif w & 0x2000:
            p = struct.unpack(">h", struct.pack(">H", words[i]))[0]; i += 1
        else:
            p = 0
        out.append((addr, op, p))
    return out


def calls(ck):
    """Appels système avec leurs arguments constants : [(addr, n°fonction, [arg0, arg1…])].

    Les arguments sont empilés du dernier au premier ; addSP après l'appel donne leur nombre.
    Un argument non constant vaut None."""
    ins = disasm(ck)
    res = []
    for k, (addr, op, p) in enumerate(ins):
        if op != 14:
            continue
        nargs = ins[k + 1][2] if k + 1 < len(ins) and ins[k + 1][1] == 12 else 0
        args, j = [], k - 1
        while len(args) < nargs and j >= 0:
            o, q = ins[j][1], ins[j][2]
            args.append(q if o in (3, 4) else None)
            j -= 1
        res.append((addr, p, args))
    return res


def call_args(ins, k, nargs):
    """Sources des arguments de l'appel à l'index k : liste de (opcode, param)."""
    args, j = [], k - 1
    while len(args) < nargs and j >= 0:
        args.append(ins[j][1:]); j -= 1
    return args


def resolved_calls(ck, fn_wanted):
    """Appels à fn_wanted, y compris via sous-programmes enveloppes.

    Renvoie [(addr, args)] où args[i] = valeur constante ou None.
    Gère un niveau d'enveloppe : push args… ; pushRetOrPos 1 ; jmp sous-prog,
    le sous-programme relayant ses paramètres par pushBPAdd n (n=1 = dernier empilé)."""
    ins = disasm(ck)
    index = {a: k for k, (a, _, _) in enumerate(ins)}
    out, wrappers = [], {}
    for k, (addr, op, p) in enumerate(ins):
        if op != 14 or (p & 0xFF) != fn_wanted:
            continue
        n = ins[k + 1][2] if k + 1 < len(ins) and ins[k + 1][1] == 12 else 0
        src = call_args(ins, k, n)
        if all(o in (3, 4) for o, _ in src):
            out.append((addr, [q for _, q in src]))
        else:
            out.append((addr, [q if o in (3, 4) else None for o, q in src]))
            # point d'entrée du sous-programme : on remonte jusqu'au précédent retour
            start = k
            while start > 0 and ins[start - 1][1] not in (8, 0, 18):
                start -= 1
            wrappers[ins[start][0]] = (addr, src)
    for k, (addr, op, p) in enumerate(ins):
        if op == 2 and p == 1 and k + 1 < len(ins) and ins[k + 1][1] == 0:
            tgt = ins[k + 1][2]
            if tgt not in wrappers:
                continue
            gargs, j = [], k - 1
            while j >= 0 and ins[j][1] in (3, 4):
                gargs.append(ins[j][2]); j -= 1
            waddr, src = wrappers[tgt]
            vals = []
            for o, q in src:
                if o in (3, 4): vals.append(q)
                elif o == 7 and 1 <= q <= len(gargs): vals.append(gargs[q - 1])
                else: vals.append(None)
            out.append((addr, vals))
    # on retire l'appel générique interne au sous-programme
    inner = {w[0] for w in wrappers.values()}
    return [(a, v) for a, v in out if a not in inner]
