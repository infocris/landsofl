# Reverse engineering — Lands of Lore: The Throne of Chaos (French CD version)

Log of the file formats decoded for this project. Everything was established by reading the
game files and checking the results visually. Nothing comes from official
documentation.

- Source: `extracted-cd/app/C/LOLCD/`, extracted from `setup-00399-Lands_of_Lore_CD_FR-PCDOSBox.exe`.
- Tools: `tools/` (Python 3, no dependencies; run them with `python3 -I`).

Confidence levels used in this document:

- **Verified**: checked against the data (sizes that add up exactly, consistent visual rendering).
- **Deduced**: consistent with the data, but not proven.
- **Unknown**: field identified, meaning not established.

All values are little-endian unless stated otherwise.

---

## 1. Installers

Both `.exe` files are **Inno Setup 6** installers. They are extracted with
`innoextract -d <folder> <setup.exe>`.

- Floppy version: `extracted/app/C/LandsOL/`.
- CD version: `extracted-cd/app/C/LOLCD/`. No ISO image: everything is installed on C:,
  and the game is started with `LANDS C:\LOLCD`.

## 2. `.PAK` archives — verified

Tool: `tools/pak.py`.

```
répéter : u32 offset absolu des données, nom ASCII terminé par \0
fin     : offset 0, nom vide, ou position atteignant le premier offset
```

The size of an entry is the difference between two consecutive offsets (the
last one runs to the end of the file).

| Archive | Contents |
|---|---|
| `Lnn.PAK` (01–29) | one level: `LEVELn.CMZ/.WLL/.INI/.INF/.XXX`, `LEVELnn.TLC`, texts `LEVELnn.ENG/FRE/GER`, sprites of the level's monsters |
| `KEEP`, `FOREST1`, `MANOR`, `CAVE1`, `SWAMP`, `URBISH`, `MINE1`, `TOWER1`, `YVEL`, `CATWALK`, `RUIN`, `CIMMERIA` `.PAK` | tilesets: `.VCN`, `.VMP`, `.DAT`, `.SHP`, door `*DOOR.SHP` / `CAVE1DR.SHP`, palettes `.PAL` |
| `STARTUP.PAK` | general texts `LANDS.ENG/FRE/GER`, `ITEM.INF`, fonts, item icons |
| `GENERAL.PAK` | interface, including `PLAYFLD.CPS` (base palette) |
| `MONSTER.PAK` | shared monster sprites (`LIZARD`, `CABAL`…) |

## 3. Compression — verified

Tool: `tools/wwcomp.py`.

### 3.1 CPS container

Used by `.CMZ`, `.VCN`, `.VMP`, most `.SHP` files and `.CPS` images.

```
u16 taille du fichier - 2
u16 type de compression : 0 = aucune, 4 = LCW
u32 taille décompressée
u16 taille de palette (0 ou 768)
[palette : 768 octets, VGA 6 bits]
données
```

Rule of thumb: a `.SHP` is compressed when its word at offset 2 equals 4.

### 3.2 LCW (Westwood "format 80"), absolute copies

| Command | Effect |
|---|---|
| `0ccc pppp pppppppp` | copy `c+3` bytes from `output[-p]` |
| `10nnnnnn` | `n` literal bytes; `0x80` = end |
| `11nnnnnn pppp` | copy `n+3` bytes from `output[p]` (absolute) |
| `FE nnnn vv` | fill `n` bytes with `v` |
| `FF nnnn pppp` | copy `n` bytes from `output[p]` |

## 4. Texts — verified

Files `LANDS.FRE` (in `STARTUP.PAK`) and `LEVELnn.FRE`:

- a table of `u16` offsets, whose count is the first offset divided by 2;
- then `\0`-terminated strings, encoded in **CP850** and **compressed**:
  - a byte ≥ 0x80 encodes two frequent letters: `T1[c>>3] + T2[c]` with `c = byte & 0x7F`,
    `T1 = " etainosrlhcdupm"` and a 128-character table `T2`;
  - `0x1B` followed by `c` encodes the CP850 character `c + 0x7F` (é, è, à, ô…).

  Decoder: `tools/pak.py`, functions `decode_text` and `read_strings`. Uppercase letters
  ("FONTAINE") pass through uncompressed, which explains why the first annotations
  were readable without decoding.

In scripts and `.XXX` files, a text number `0x4000 + i` refers to
entry `i` of `LANDS.xxx`.

## 5. Level grid — `LEVELn.CMZ` (CPS) — verified

```
u16 largeur (32), u16 hauteur (32), u16 octets par case (4 ; 9 au niveau 24)
largeur*hauteur cases ; octets 0..3 = id de mur des faces Nord, Est, Sud, Ouest
```

- Cell `(x, y)` = index `y*32 + x`, with `x` pointing east and `y` pointing south.
- A solid cell carries the same id on its 4 faces; an empty cell carries id 0.
- **Unknown**: the 5 extra bytes of level 24.

## 6. Wall types — `LEVELn.WLL` — verified (field meanings: deduced)

```
u16 inconnu (0)
entrées de 12 octets :
  u16 id
  u16 vmp      jeu de mur dans le .VMP du décor (1-based, 0 = aucun)
  s16 forme    >0 : n° de décoration (.DAT) ; -2 : battant de porte (*DOOR.SHP) ; 0 : rien
  u16 spécial  5 = porte (déduit)
  u16 drapeaux 0x01 = bloque le groupe ; 0x80 = case vide (sol)
  s16 automap  13 = porte sur la carte automatique ; 63 / -1 = rien (déduit)
```

- Doors come in series of consecutive ids (for example 3–7 and 8–12 in the castle),
  with varying flags: probably the opening stages (**deduced**).
- **Borrowed walls**: levels 2 and 3 each use ids defined only in the other's
  `.WLL`, and level 21 an id from level 20. The extractor takes the
  definition from a level with the same tileset.

### 6.0a Doors — opening stages (verified 2026-11-08)

A door is a series of consecutive wall types: the first is closed (blocking, with
an open texture), the last open (non-blocking). For example, on level 1: 3, 4, 5,
6, then 7 open. The game moves the face from one type to the next during opening. The
exported textures of the intermediate stages all show the door closed: the game
moves the panel itself. The 3D view isolates the panel (pixels that differ between the closed
texture and the open texture, which gives its height within the frame), then raises or lowers
it continuously toward the target opening. That opening is (type − first) /
(last − first), from the live grid. All doors are animated as
vertical slides: the actual opening direction of each tileset has not been verified.

### 6.0b Stairs, holes and passages (2026-11-08)

- **Stairs**: wall types placed on the floor (flags 4) whose map symbol is 25 or
  26. Positions match from one level to the next. On level 7, symbol 26 is at
  15,6, 15,15 and 28,3; on level 8, symbol 25 is at the same cells. On level 6, 26
  is at 22,3, and on level 7, so is 25. Hence **25 = stairs going up**, **26 =
  stairs going down** (**deduced** from these matches). The level change is done
  by the engine, not by the scripts: stairs do not appear in calls to
  function 0x3C.
- **Holes and trapdoors**: symbol 11 on the floor. Scripts drop the party to the level
  below, at the same position (level 20, cell 15,15 → level 18, cell 495 = 15,15).
- **Scripted passages**: function **0x3C** (level, cell, direction) changes level. These
  are the castle and forest exits, the cave entrances and the falls. The export
  records them with their trigger cell (field `exits`, `level_exits`).

### 6.0c Teleporters — deduced, match verified (2026-11-08)

Symbol **17** of the `automap` field marks teleporters. The wall type is placed on the floor,
without texture (invisible). It is found at 20,1 on level 15, on 4 cells on level 16 (the
mine), and on levels 19, 23, 25 and 26.

The jump is done by script function **0x3C** (level, cell, direction), most often
in a level subroutine that receives these values as parameters (`pushBPAdd n` = n-th
value pushed by the caller, n = 1 for the last one). Just before, this subroutine tests
"requested level = current level" to play the teleporter effect (function 0x39). For
example, on level 16:
- 13,4 → 4,9 (same level);
- 14,5 → level 12, cell 22,7;
- 15,6 → 14,6;
- 14,7 → level 14, cell 12,10.

`level_exits` now follows these subroutines and marks jumps within the same level as
`teleport`. Thirteen such jumps are found, including on cells without symbol 17
(levels 11, 12, 19 and 27). For 4 cells with symbol 17 (level 23: 2,11, 3,16 and 20,16;
level 26: 20,19 and 18,23), the destination is not resolved.

Three false leads ruled out:
- the cells with symbol **10** on level 14 are pressure plates: type 35 becomes 36,
  with sound 80;
- function **0x60** (value, cell) plays a sound on a cell;
- function **0x31** (cell, ±1 or 0) changes the state of a door.

### 6.0d Hidden passages — deduced (2026-11-09)

Hidden passages come in two kinds: fake walls and walls erased by a script.

**Fake walls.** These are faces whose texture is opaque, so drawn as a solid
wall, but whose flags bit 0 is 0: the face does not block passage. Stairs
(symbols 25 and 26) are excluded.
- The cell remains a wall on its other sides: it can only be crossed through the fake sides.
- On level 23 (Passerelle 1), type 36 (flags 132, map symbol 214) has the ordinary rock
  texture. It is placed on 18 cells of the central maze, for example 10,14, which
  is crossed from north to south.
- Symbol 214 marks these faces on most levels: 7, 8, 10, 13 to 16, 20, 21,
  23, 27 and 29. There are others: 63 (levels 2, 3 and 17), 22 (level 26) and 192 (level
  24). The page therefore does not rely on the symbol: it relies on opacity and bit 0.

**Walls erased by a script** (`tools/hidden_walls.py`, levels' `secrets` field).
- A script calls `setWall` (0x00) with face -1 (all four faces) and type 0 (empty)
  on a cell that is a wall in the original map.
- The condition is looked for just before the call: `getItemParam(item, 4)` (0x12, parameter
  4 = type) then "push type ; eval ==".
- The item comes from function 0x53 (item in hand) or from a script register. In that case
  it is probably an item placed on the cell (deduced).
- Other calls put a solid wall back on the same cell: the passage closes again.
- On level 23, the mechanism of cells 9,25, 4,30 and 5,29 erases walls 9,26, 4,31 and 6,29
  when holding the Gantelet des Ténèbres (254). Stepping on 8,26, 3,31 or 6,28 puts them back.
  - The mechanism of cell 16,24 (type 38, special 6) expects the Statuette (255). It empties
    cell 20,26, which is already a fake wall.
- 44 walls found on 14 levels.
- Some walls open from their own cell (level 14 for example). These may be
  walls to hit or click. The page does not mark those already known as fragile
  walls (§ 8.1).

### 6.1 Chests — verified visually (2026-11-08)

The `automap` field of a wall type selects the symbol on the game map. The value
**210** marks chests: every chest decoration spotted on the tileset sprite sheets has
this value (caves, swamp, mines, Urbish, manor, Yvel, towers, Cimmeria…). Each tileset
defines 4 consecutive types, which are the states of a chest: **closed**, **open**, open
(lid raised, probably empty) and **broken**. For example, on levels 7 to 9: 53, 70, 72
and 73. There are 64 chest faces on 21 levels. The script changes the type when a chest is
opened or broken ("Un coffre ouvert.", "Le coffre est endommagé."). The live grid
therefore gives the real state. The page shows chests and their state on the minimap; items
placed on a chest cell are labelled "dans un coffre" (in a chest).

**Chest contents** (`tools/chests.py`, levels' `chestItems` field; deduced from
reading the scripts, not verified by opening a chest):
- **Lock**: the script of the chest cell calls a generic level subroutine
  (on level 7: 625). Its parameters are the cell, the face, then the required key (-1 = none).
  The subroutine compares the item in hand (`0x53`, `0x12` parameter 4) to the key and to the Jeu
  de clefs (245), then changes the wall type (states from § 6.1).
- **Contents**: if it succeeds, the script calls function **`0x49`** (type, value, 0),
  once per item. The value appears to be a number of coins (Bourse) or charges (Coupe
  Bezel, wands, Collier de Jade).
- **Fragile items**: the script tests `getWall(992, 3) == -2`, probably "chest broken".
  If so, it gives a **Verre cassé** (247) instead of the following vial or
  cup.
- **Result**: by tracing the subroutines back to the cells that call them, the
  contents of **50 chests out of 54** are found. Missing: level 4, chests 15,30, 24,30 and 25,30;
  level 17, chest 25,17.
- **Multi-face chest**: a chest such as 9,8 on level 7 groups the items of its
  two faces.
- The minimap shows these contents when hovering over the chest; if the chest is open, it shows the
  original contents.

## 7. Map annotations — `LEVELn.XXX` — verified

```
entrées de 12 octets : u16 x, u16 y, u16 icône, u16 x2, u16 y2, u16 n° de texte
```

- The text is in `LANDS.FRE` (for example "FONTAINE", "SALLE DU TRONE").
- The value `0xFFFF` marks an empty slot.
- **Unknown**: the exact meaning of `icône` and `x2/y2` (often the neighbouring cell, perhaps
  the access cell).
- **Location illustrations** (minimap, when hovering over a location or its row in the list).
  The page first looks for a game image (function `0x29`, § 8) on cell `x2/y2`, on the
  location's cell or on a cell next to `x2/y2`. On level 1, this gives: Armurerie →
  VICTOR, Herboristerie → NATHNIAL, Bureau de Geron → GERIM, Salle du trône → CONFRONT.
  Otherwise, the 3D view takes a snapshot from `x2/y2`, facing `x/y` (message
  `lol-snap`, synchronous render then return to the party's position). Example: the Fontaine,
  seen from 13,14 facing north, does face the fountain, which supports the idea that
  `x2/y2` is the access cell. The snapshot is only possible for the level displayed by the 3D
  view.

### 7a French level names — deduced, match verified (2026-11-08)

In `LANDS.FRE` (`STARTUP.PAK`), text **528 + n** gives the name of level n. Just before,
texts 526 to 528 are "Mur Secret", "Plaque pivotante" and "Téléporteur".

| n | name | n | name | n | name |
|---|---|---|---|---|---|
| 1 | Gladstone | 11 | Marécage | 21 | Tour Niveau 3 |
| 2 | Forêt du Nord | 12 | Mines d'Urbish | 22 | Cité d'Yvel |
| 3 | Forêt du Sud | 13 | Mines Niveau 1 | 23 | Passerelle 1 |
| 4 | Manoir de Roland | 14 | Mines Niveau 2 | 24 | Bois d'Yvel |
| 5 | Cachette | 15 | Mines Niveau 3 | 25 | Passerelle 2 |
| 6 | Cavernes Niveau 1 | 16 | Mines Niveau 4 | 26 | Donjons |
| 7 | Cavernes Niveau 2 | 17 | Haut du Bois d'Opin | 27 | Château Niveau 1 |
| 8 | Cavernes Niveau 3 | 18 | Tour Niveau 1 | 28 | Château Niveau 2 |
| 9 | Cavernes Niveau 4 | 19 | Tour Sub-niveau | 29 | Château Niveau 3 |
| 10 | Bois d'Opin | 20 | Tour Niveau 2 | | |

The match holds across the whole table:
- the tilesets match: `CAVE1` for Cavernes 6 to 9, `MINE1` for Mines 13 to 16,
  `TOWER1` for Tours 18 to 21, `CIMMERIA` for the Château, `YVEL1` for the Cité d'Yvel;
- so do the map annotations: "SALLE DES COCONS" on level 7, "PORTES D'YVEL" on
  level 22.

What the game uses this list for (probably saves or the map) remains to be found:
**not verified**. The names are exported in `levels.json` (`frName`), and the minimap and the
3D view display them.

## 8. Scripts — `LEVELn.INI` / `LEVELn.INF` (EMC2) — verified for what is used

Tool: `tools/emc.py`. IFF `FORM` / `EMC2` file containing three chunks (big-endian
sizes):

- `ORDR`: entry points;
- `TEXT`: table of big-endian `u16` offsets, then strings;
- `DATA`: **big-endian** `u16` words.

Decoding an instruction word:

```
bit 15          saut, cible = mot & 0x7FFF
bit 14          paramètre = octet bas signé
bit 13          paramètre = mot suivant
opcode          (mot >> 8) & 0x1F
```

| Opcodes | Role |
|---|---|
| 3, 4 | push a constant |
| 7 | push parameter `n` of the subroutine |
| 12 | pop `n` (after a call = number of arguments) |
| 14 | call an engine function (no. = parameter & 0xFF) |
| 2 (param 1), then 0 | call a subroutine |

The arguments of an engine function are pushed from last to first.

Identified engine functions:

| No. | Role | Arguments | Confidence |
|---|---|---|---|
| `0x38` | place a monster | cell, dx, dy (0–255, 128 = center), direction (0 N, 1 E, 2 S, 3 W), type, ?, mode, equipment ×0–4 | verified: 0 monsters inside a wall across 28 levels |
| `0x0B` | load a monster sprite | text (.SHP file), slot, anim | deduced |
| `0x3F` | stats of a monster type | type, sprite slot, then 40 values | deduced (values not decoded) |
| `0x11` | place an item | item type, image, flags, **level**, cell, dx, dy (0–255), height | verified (level = the script's own except in 1 case; names consistent) |

- `.INI` runs when the level loads (monsters present from the start).
- `.INF` contains the events (monsters that appear on a trigger).
- Several `0x0B` calls on the same slot correspond to conditional branches:
  the sprite depends on story progress (for example ORC/THUG on level 2).
- **Anomaly**: the `.INI` of level 25 is a copy of level 23's; its
  monsters end up inside walls. It is probably an unused level.
- The first `TEXT` string that is not a `.PAL` gives the tileset name (`KEEP`,
  `FOREST1`…). A referenced `.PAL` is an alternate palette.

### 8.1 Placed items — verified

- **Total**: 223 items placed by the scripts. 197 are placed on load (`.INI`),
  27 appear on an event (`.INF`).
- **Target level**: the "level" argument equals the script's level, except on level 24, which
  places an item (type 198) on level 29. The extractor does not report this item yet.
- **Items in walls**: 51 items are placed inside a wall block, with an offset
  of 0 or 255 on one axis and a height of 8. These are items stored in **wall
  niches**; this is what stands in for chests in this game, where no other container has
  been found. The offset gives the face (0 = West/North, 255 = East/South), hence the cell
  from which the niche is seen. The wall often carries a decoration of special type 6
  with flag 0x87 (**deduced**: niche).
- **Per-cell scripts**: in `LEVELn.INF`, the `ORDR` table has 1,027 entries, and entry
  n < 1024 is the entry point of the script for cell n (`0xFFFF` = none). On level 1,
  45 cells have a script, including the fountain (13,13) and the door thresholds. This is
  where the interactions live (entering a cell, clicking a wall, dropping an
  item…). The event type is a script parameter, still to be decoded.
- **Locks** (`tools/locks.py`): when a wall is clicked, the game runs the cell's
  script. A lock reads the item in hand (function `0x53`), gets its type (`0x12`,
  parameter 4) and compares it with a key type. Verified example on level 8, cell 17,2:
  item in hand → if it is the "Jeu de clefs" (245), a message; if it is the "Clef usée"
  (169), it opens. Two forms: direct comparison ("push <key> ; eval ==") or a call to
  a level subroutine that reads the item in hand, with the key as argument
  (**probable**: the argument is not traced all the way to the comparison). Keys are the
  item types that have flag 0x0100. Result: 37 of 45 keys located, almost
  all on decorated walls, often next to a door. No lock is found
  for the Clef de Roland, des Brigands, de bronze, de la mine 3, the Clef usée (186), the Clef
  Bleue, the Clef de la Mort and the Clef Emoussée: used by another mechanism, or
  unused keys. The numbers 7 and 8 in these scripts are story flags
  (`0x07` = write, `0x08` = read, **deduced**) whose numbers sometimes match those of the
  keys.
- **Switches**: the `special` field of a wall type (`.WLL`, § 6) says what happens
  on click. Mapping taken from ScummVM (**not verified in game**): 1 = clickable
  decoration, 2 and 3 = lever in one position or the other, 4 = script only, 5 = door,
  6 = niche. Count: level 8, 7 lever faces; level 16, 7; level 1, no lever
  but 32 type-1 faces, all on cells with a script. The minimap shows levers
  and, when the cell has a script, type 1 or 4 elements. A lever's state is read from
  the live grid, since the wall identifier changes when it is pulled.
- **Kind of lock** (`tools/locks.py`, `lock_kind`): based on what the cell's script
  does. If the script creates an item (functions `0x11`, `0x10`, `0x0F`), the lock **gives
  an item**. If it removes a wall (`0x00`, face -1, type 0), it **opens a passage**. If it
  changes the decoration of its own face, it is a **receptacle**: the key stays inserted (the
  Clefs Mystiques of the towers). If it references a door's cell, or if a door touches the
  cell, it is a **door lock**. Tally: 24 doors, 6 passages, 13 receptacles,
  2 "gives an item", 15 undetermined. The game has no locked chest: the two
  "gives an item" cases are locations (Sadie's shop, l'Echoppe de Sadie, on level 22, a scene on
  level 10), and the chests mentioned in the texts ("Un coffre cassé") are decorations.
- **Fragile walls** (`tools/fragile.py`): on level 6, walking onto 8,7 then 11,13,
  one reads "Ce mur me semble assez fragile" then "Ce mur est également branlant". The
  walls just to the south (8,8 and 11,14) break when struck with the **Marteau**
  (item 59). The level script counts the hits in a variable (functions `0x2d`
  read and `0x2e` write, **deduced**). On the first hit, it changes the wall's appearance
  (function `0x00`: cell, face, type); on the next hit, it calls a subroutine
  that removes the wall (`0x00` with face -1 and type 0). On level 9, cell 20,13 reacts to
  event 0x400, the attack event, with the Marteau, and breaks wall 20,14. Walls
  found: level 6 at 8,8 and 11,14; level 9 at 22,8 and 20,14 (Marteau); level 15 at
  6,1 (Pioche). The "pierres branlantes" on level 9 (23,15) open with a simple
  click (event 0x40).
- **Cell script events** (register 0, **deduced**): 0x40 = click on the wall,
  0x400 = attack on the cell; the other values encountered (0x01, 0x02, 0x04, 0x08,
  0x10, 0x80, 0x100, 0x200, 0x4000) remain to be identified. Level messages:
  function `0x5e` (type, 0, text no. in the level's `.FRE`).
- **Location images**: function `0x29` (text no. of a `.CPS`, page) loads the still
  image of a location (inn, shop, throne room…). It is called in the script of
  the cell in front of the entrance, which is the second point (x2, y2) of the annotation. On level 1:
  `NATHNIAL.CPS` at 16,14 (herbalist), `VICTOR.CPS` at 16,12, `GERIM.CPS` at 10,13,
  `CONFRONT.CPS` at 17,8.
  - **Format**: the image is a 320×200 sprite sheet with its own palette. The scenery
    occupies the 176×120 corner, in the view's format; the rest holds the
    character's animation frames.
  - **Coverage**: 14 cells in total across the 29 levels. Other locations (Yvel, level 22)
    are loaded some other way, still to be found.
  - **In memory**: `NATHNIAL.CPS` was found whole in RAM, at 0x4D5C0, but this
    buffer does not change on entering the scene. So it cannot be used to detect the
    mode.
- **Level 1**: no item placed by script. The starting equipment comes from
  elsewhere (unknown).

### 8.2 Item table — verified (in RAM)

- **Location**: in RAM at physical address 0x8AA05 (French CD version). It has 285
  entries of 13 bytes, and its index is the item type used by function `0x11`.
- **Entry contents**: bytes 0–1 = text number of the name (0x4000 + index in
  `LANDS.FRE`); byte 2 = **icon** number in `ITEMICN.SHP` (`STARTUP.PAK`,
  138 icons of 20×20, interface palette); the following bytes are described
  below.
- **Fields 3–12** (read by `tools/item_info.py`, which produces the page's item cards):

  | Bytes | Field | Status |
  |---|---|---|
  | 3–4 | flags (0x0100 on all keys, 0x0002 on metal items?) | unknown |
  | 5–6 | allowed equipment slots, one bit per slot (see § 12.2) | **verified** on Michael |
  | 7 | action when the item is used = entry point in `ITEM.INF` (0xFF = none) | deduced + script read for 4 |
  | 8 | weapon might; otherwise 1st action parameter | **verified** (Poignard = 10) |
  | 9 | 2nd parameter (might of ranged weapons, max heal…) | deduced |
  | 10 | protection | **verified** (Chemise 5 + Sandales 1) |
  | 11–12 | value (Onguent 20, Poignard Incrusté 3000): probably the price | assumed |

  **Verification** (2026-11-08): with Poignard in slot 1, Chemise in 6 and Sandales
  in 9, Michael's character record contains `itemsMight[1] = 10` and `itemProtection = 6`.
- **Actions (byte 7)**:

  | Value | Items | Parameters |
  |---|---|---|
  | 0x00 | melee weapons | byte 8 = might |
  | 0x01 | armor, Amber ring (anneau d'Ambre) | — |
  | 0x02 / 0x19 | arrows, bolts, stones, bones (0x19 = poisoned) | byte 8 = damage |
  | 0x04 | Onguent, Aloès, Ginseng | random heal between byte 8 and byte 9 |
  | 0x0B | bows, crossbows, stars | byte 8 = ammunition type, byte 9 = might |
  | 0x0C | messages, Mandat du Roi | bytes 8–9 = text no. (0x4000 + `LANDS.FRE` index) |
  | 0x0E | spell scrolls | byte 8 = spell no. |
  | 0x14 | wands, Bâton d'ébène | byte 8 = spell no. |
  | 0xFF | keys, jewels, figurines | no action |

  Spell numbers, from the scroll names: 2 Gel, 3 Boules de feu, 4 Poing
  mortel, 5 Brume fatale, 6 Foudre, 7 Vortex; 9 (Bâton d'ébène) remains unknown.
- **Passive ring effects** (`MAIN.EXE` code, disassembled with Capstone). The game
  calls an "item equipped?" function (`0a21:0997`, arguments: character, item
  type):
  - **Anneau Bezel (225)**: the function that applies a status (arguments: character, status,
    chance out of 100) ignores status 0x80, poison, if the ring is worn. It is therefore
    poison immunity;
  - **Anneau Talba (227)** and **Anneau Duble (228)**: in the regeneration loop (the
    4 characters, records of 0x82 bytes), magic points (+0x3D, maximum +0x3F from the start of
    the record) regenerate by maximum/10 instead of 1 with Talba. Hit points regenerate by 4 instead of 1
    with Duble. A zone that drains magic (byte 0x7FDE) removes maximum/32 instead;
  - **Anneau de Nuage (229)**: in the damage-taken calculation, type 4 damage is
    divided by 4. Type 4 is that of the Boule de Glace in `ITEM.INF`, hence cold
    (**deduced**);
  - **Anneau de Zéphyr (230)**: after an attack, the character gets status 0x04
    (recovery) for 4 + random(8) cycles; with the ring, this duration is halved;
  - **Anneau d'Ambre (226)**: +5 protection, through the item table.
  The same attack routine runs the target cell's script with event 0x400, which
  confirms that 0x400 is the attack.
- **Usable items** (`ITEM.INF` entries, read in the script): 0x08 Flasque d'huile =
  refills the lantern; 0x09 Bourse = silver coins; 0x0F Gobelet d'argent = heal of 255
  for 1 magic point; 0x12 Coupe Bezel = hit points to maximum, uses counted in
  the item; 0x15 Cube de Vaelan: 263 (charged) restores 25 magic points then becomes
  264 (empty); 0x1C Gantelet des Ténèbres = Poing mortel spell; 0x18 = spell from byte 8;
  0x1E As de l'Infini and Réserve de Bannon = magic points to maximum, single use; 0x20 Fioles =
  "Beurk !", then Flasque vide. Deduced engine functions: `0x14` write a value
  of the character record, `0x0C` delete the item in hand, `0x49` give an item,
  `0x2F`/`0x30` read and write a global variable (lantern oil = variable 9).
- **Healing script** (`ITEM.INF`, entry point 4, read by disassembling): the item only works
  if hit points are not at maximum, or if the character is poisoned (bit 0x80 of their
  status) and the item is the Ginseng (type 218). The script draws a random number between
  the two parameters and heals by that much. With the Ginseng, it also removes the poison
  (message 0x4056 "Les effets du poison se dissipent…"). The Onguent (216) plays an extra
  sound. Script functions: `0x12` = item parameter, `0x13` = character record
  value, `0x03` = random draw, `0x61` = heal (**deduced**).
  - **Byte 2 check**: Onguent = 30, Ginseng = 42, Aloès = 43 do give the
    potion, the leaf and the herb shown in the game bar. The game page uses it
    for the graphical inventory preview.
- **Sanity check**: entry 0 is "Objet illégal".
- **Not in the executables**: the table does not appear as-is in either `LANDS.EXE` or
  `MAIN.EXE`. It is extracted from a RAM dump by
  `tools/item_table_from_ram.py`, and the result is versioned in
  `tools/data/items_fr.json`.
- **Doubtful name**: type 267, "Essaim", occurs often in the forests. Its meaning
  remains to be checked in game.

## 9. Tileset graphics — verified

Tool: `tools/lolgfx.py`.

### 9.1 `.VCN` (CPS): 8×8 tiles in 16 colors

```
u16 n (nombre de tuiles)
n   octets : décalage de sous-palette par tuile (multiple de 16)
128 octets : table de couleurs (8 sous-palettes x 16 index)
384 octets : couleurs 0–127 de la palette (VGA 6 bits)
32n octets : pixels 4 bits, 2 pixels par octet, poids fort à gauche
```

Pixel color = `table[décalage[tuile] + quartet]`.

### 9.2 `.VMP` (CPS): tile assemblies

```
u16 nombre d'entrées, puis entrées u16 :
  bits 0–13 = n° de tuile (0 = vide)
  bit 14    = miroir horizontal
  bit 15    = couleur 0 transparente (superposition)
```

Layout:

- entries 0–329: view background, 22×15 tiles (176×120 pixels);
- then one set of 431 entries per wall type (`vmp` field of the `.WLL`).
  `nombre = 330 + 431 × jeux` for the 12 tilesets.
- **Within a set of 431**: the last 192 entries (16×12 tiles = 128×96 pixels) form
  the **near wall seen head-on**. The preceding entries are the side views and the distant
  views, arranged by widths of 3, 6, 10… tiles (exact split not recorded).
- Empty tiles of a wall set are transparent: door opening, arch, bottom of
  the last row (floor).

### 9.3 Palette — verified

- Colors 128–255: palette of `PLAYFLD.CPS` (`GENERAL.PAK`).
- Colors 0–127: the tileset's `.VCN`, or the first 384 bytes of the `.PAL` referenced by the
  level script.
- 6-bit VGA values, converted to 8 bits with `v*4 + v/16`.

### 9.3a Perspective of the original view — deduced, consistent with measurements

The view is 176×120 pixels. The near wall seen head-on (128×96) is placed at the top of the view,
centered: its opaque pixels run from row 0 to about 94 (measured on KEEP and TOWER1).
From this we deduce:

- **Focal length**: 64 pixels per unit, since a cell is 128 pixels wide seen at 0.5 cell
  (the player is at the center of their cell).
- **Horizon**: y≈47; horizontal center: x=88.
- **Eye height**: about 0.367 cell. A wall is about 0.73 cell high,
  the eye is at mid-height.
- **Floor mapping**: a floor point at distance `z` ahead, offset by `x` to the
  side, appears at `(88 + 64·x/z, 47 + 23,5/z)`. For the ceiling, `47 − 23,5/z`.
- **Shading**: the original background is painted with shading that increases with distance
  (black band around the horizon).

The floor and the ceiling of the background do **not** follow this model: their painted
perspective differs from the walls' (§ 9.3c for the floor, § 9.3f for the ceiling). The
viewer's first ceiling texture, projected with this model (rows 0–31 for one cell), packed
three to four ceiling beams into one cell.

**Distance scale of the original engine — measured.** It is not a perspective: a
head-on wall measures 128, about 80 then about 48 px at 0.5, 1.5 and 2.5 cells. These are
the 16-, 10- and 6-tile pieces of the `.VMP`, and the decorations at positions 1 to 3
of the `.DAT` shrink in the same proportions (×0.65). Size therefore decreases by about
×0.615 per cell, instead of 1/distance: in the distance, the scenery looks about twice as
large as in true perspective.
- **Imitation**: the built-in view offers a "game perspective" mode, with an
  apparent distance `deff(z) = 0,5 · (1/0,615)^(z − 0,5)` beyond 0.5 cell. Rays
  become curves there, which the renderer follows in steps of 0.02 cell. Walls,
  floor, ceiling and monsters use the same scale.
- **Toggle**: a button on the game page switches between the two modes.

**3D view built in below the game.** It uses this perspective: horizontal field
`2·atan(1,375)` ≈ 108°, image 352×240 (176×120 aspect). It also receives the live
grid (§ 12.2), hence the actual state of doors. So that these identifiers have a
texture, the export produces a texture for every wall type of the level.

### 9.3b Movement transitions — verified in ScummVM (2026-11-19)

**Principle.** Nothing is pre-generated: the view is recomposed at each step from the pieces
of the `.VMP` and the decorations, and transitions are computed live by 2D warps
of the view image. The ScummVM functions are `movePartySmoothScroll*` in
`scene_lol.cpp` and `smoothScroll*` in `screen_lol.cpp`.

**Moving forward.** The new view is drawn off-screen.
- The current image is enlarged from a centered rectangle that shrinks, in 5 steps. The
  margins for these steps are read from fixed tables in `LANDS.EXE` (`kLoLScrollXTop`,
  `kLoLScrollYTop`, `kLoLScrollXBottom`, `kLoLScrollYBottom`).
- The top (`smoothScrollZoomStepTop`) and bottom (`smoothScrollZoomStepBottom`) halves are
  enlarged separately.
- The new view is then displayed all at once.

**Moving backward.** Same enlargement, applied to the new view.

**Sidestep.** Horizontal slide of the old and new views in 22 px strips
(`smoothScrollHorizontalStep`).

**Turning.** Three intermediate images blending the old and new views
(`smoothScrollTurnStep1` to `3`), with a doubled delay per step.

**Blocked by a wall.** Enlargement, then back to the starting view (`movePartySmoothScrollBlocked`).

**Settings.** The game option "smooth scrolling" (`smooth_scrolling` in ScummVM) removes
these transitions: the view changes without intermediate steps. In fast mode
(`_smoothScrollModeNormal` false), every other step is skipped.

### 9.3c Floor of the background: projection and mosaic pattern — measured (2026-11-22)

The floor of the background (rows below the black band) is a painted image whose
perspective does **not** match the walls' (§ 9.3a). It was measured on the two floors that
are paved with a visible repeating pattern: `KEEP` (level 1, octagons) and `TOWER1`
(levels 18–21, square slabs).

- **Width**: along each row, the pattern period in pixels grows linearly with `y`, towards
  a vanishing point at y = hx (≈ 39 for KEEP, 42.5 for TOWER1; the vertical joints of
  TOWER1 are straight lines through it). A floor point at lateral offset `X` (in
  "units", one unit ≈ one slab) is at `x = 88 + 0.75 · X · (y − hx)`.
- **Depth**: `K = ak / (y − hk)` units, with its own horizon hk, lower than hx:
  - TOWER1: the 6 horizontal joints (rows 64, 69, 75, 83, 94, 110) fit
    `y = 24 + 376 / (k + 4.37)` for integers `k`, within 0.1 px;
  - KEEP: hk = 34.5, ak = 354.25. Fitted on the X-rectified pixel rows: two rows at the
    same phase of the pattern correlate, and two rows half a period apart correlate
    with a half-period horizontal shift (staggered rows). The fit maximises
    `Σ (c₀ − c½) · cos(π · a · (1/(y₂ − H) − 1/(y₁ − H)))` over the pairs of rows.
- **Cell**: about 3.1 units wide. The near wall (128 px) stands on row 94, where a unit
  measures 41 px. A cell therefore holds 3 × 3 patterns.
- **The pattern** (`levelNN_floor_motif.png`, 48×48) is obtained by folding:
  1. each floor pixel, split into 6 × 2 sub-pixels, is projected to (X, K);
  2. it is then reduced modulo the lattice: KEEP 1 × 1 unit; TOWER1 1.09 × 1, with
     joints at K ≡ 0.37 and X = ±0.545;
  3. all visible repetitions accumulate, weighted by their on-screen resolution
     (`0.75 · (y − hx)` px per unit), over about 4 units of depth;
  4. the painted shading is compensated by the mean brightness of a band ±0.5 unit deep,
     so that the pattern's own light and dark rows are kept.
- **What the folding shows**:
  - KEEP: light and dark octagons alternate in a checkerboard, in staggered rows (two
    rows per pattern), with a small light diamond between them. The half-period shift is
    a translation of the shape only: folding with it merges light and dark octagons.
  - TOWER1: square slabs with dark joints.
- **Other floors** (grass, cobblestones, lava, rubble): no repetition. Neither the
  horizontal autocorrelation nor a 2D folding search (cross-validated between the left
  and right halves of the image) finds a period. They are painted without a pattern. The
  export rectifies only the **near half** of the floor: a half cell (1.55 × 1.55 units, from
  the bottom row, i.e. rows ≈ 92–120), with TOWER1's depth model and hx = 39, then fills the
  unseen corners from their neighbours. Further away, the painted shading, or the haze of
  Yvel (level 22) that washes the cobblestones towards grey, erases the paving.
- **Checkerboard of two cells — refuted (2026-11-22)**, tested on MANOR, URBISH and RUIN.
  The hypothesis was a floor made of cells 1 and 2 in a checkerboard (`12121 / 21212`):
  - **2 = 1 mirrored**: each row would then be mirror-symmetric about every cell boundary
    (axes evenly spaced, converging to y = hx). Searching cell sizes from 0.6 to 4 units
    and every phase, the best mean symmetry is 0.30–0.36, close to noise. The positive
    control, KEEP's octagons, reaches 0.86.
  - **2 a different cell**: rows one cell apart in depth would match with a one-cell
    lateral shift. The best row pairs have inconsistent shifts, i.e. no lattice.
  - No exact copy, mirrored or translated, exists within a row either. The background's
    `.VMP` uses each floor tile once (rows 8–14: consecutive tile numbers, no mirror bit).
  
  The game flips the whole background at each step, which is what the 3D view reproduces
  by mirroring one cell in two (`floorMirror`).
- **Use**: `levelNN_floor.png` is one cell:
  - for a paved floor, the pattern repeated 3 × 3;
  - for a painted floor, the near half cell (64×64) laid as a checkerboard `1 2 / 2 1`,
    2 being 1 mirrored (128×128). Mirroring the whole cell gives the same cell, so the
    3D view's mirroring of one cell in two keeps the checkerboard across cells. A fully
    mirrored layout (`1 2 / 3 4`, also flipped vertically) has no seam, but makes
    kaleidoscope figures; it was not kept.
  - `floorMirror: false` in `levelNN.json` (paved floors) tells the 3D view not to mirror
    the cell every other cell, since the pattern already tiles without seams.

### 9.3d Wall pieces and the forest's upper part — verified in ScummVM (2026-11-22)

`KyraRpgEngine::drawVcnBlocks` (`scene_rpg.cpp`) builds the view, 22×15 tiles, from the
background (flipped when `_wllProcessFlag` is set, § 9.3a) and from pieces of each wall's set of
431 `.VMP` entries. `_vmpOffsetsDefault = {102, 97, 129, 117, 81, 159, 45, 239, 0}`:

| Offset | Tiles (w×h) | First tile row | Piece |
|---|---|---|---|
| 129 | 6×5 | 3 (y 24–64) | wall facing the party, 3 cells ahead |
| 102, 97, 117 | 3×5, 1×5, 2×6 | 3 | sides at 2–3 cells |
| 159 | 10×8 | 2 (y 16–80) | facing wall, 2 cells ahead |
| 81 | 2×8 | 2 | side, 2 cells |
| 239 | 16×12 | 1 (y 8–104) | facing wall, next cell |
| 45 | 3×12 | 1 | side, next cell |
| 0 | 3×15 | 0 (y 0–120) | side of the party's own cell, full height |

Walls therefore only cover their own height; above them, the view shows the background.
In the forest (`FOREST1`), the background's top rows are a band of treetops cut out against
a sky of a single color (52, 52, 81 in the levels' palette), and in the game (screenshot at
level 2, facing a corridor) the trunks of the wall 3 cells ahead continue into it without a
break. The band above that wall (x 64–112, rows 0–23) is thus the upper part of those trees:
24 px above a 40 px wall.

The 3D view uses it for the forest: one storey of repeated trunk, then this band as the crown
(24/40 of a wall height, the sky made transparent), against a sky of that single color. Trees
are thus about 2.6 walls high. The band's size relative to the wall gives at least 1.6 at 3
cells; the extra trunk storey follows the near trees, which fill the whole view in the game.

### 9.3e Generating floors from the floor images (2026-11-22)

Two generators, depending on the floor (§ 9.3c):

- **Paved floors** (KEEP, TOWER1): the extracted pattern *is* the generator. The floor is
  deterministic and periodic, the pattern repeated over a lattice of 3 × 3 per cell.
- **Painted floors** (the others): **Wang tiles**, which give a non-periodic floor without
  seams, either deterministic or random.
  - **Source**: the near band of the floor, rectified from above (`floor_source`, 1.8 units
    deep from the bottom row, 4.6 units wide, 41.3 px per unit, shading compensated). Pixels
    outside the original view are left empty.
  - **Samples**: four 64×64 squares (half a cell) fully inside the source, chosen as far
    apart as possible. Samples 0/1 serve the horizontal edges (north/south), samples 2/3 the
    vertical edges (west/east). The second sample of each pair is mirrored, for variety.
  - **Tiles**: 16, one per combination of edge colors (n, e, s, w ∈ {0, 1}), at index
    `n + 2e + 4s + 8w` of a 4 × 4 atlas (`levelNN_floor_wang.png`). An edge of color c is
    centred on sample c: the tile on each side of the edge shows one half of that sample,
    so the joint is continuous by construction.
  - **Inside a tile**: the four triangles (one per edge) are joined by a minimum-error cut,
    as in image quilting. In each quarter, dynamic programming finds a path within 10 px of
    the diagonal that minimises the squared difference between the two samples, and the
    joint is blended over ±2 px. A plain blend along the diagonals showed X-shaped seams
    that cut through the stones.
  - **Layout** in the 3D view: one tile per half cell (`floorWang.perCell = 2`). The color
    of each edge is a hash of its coordinates, its orientation, the level and a seed:
    - deterministic by default (the same floor on every visit, seed 1);
    - any other seed with `?floorSeed=N`;
    - random at each load with `?floorSeed=random`.
    Two tiles sharing an edge get the same color, hence the same joint.
  - **Result**: good on cobblestones (Yvel), rubble (Urbish), lava, grass and moss. On
    the manor floor (MANOR), whose near band is less detailed, blocks remain visible.
  - `levelNN_floor.png` stays the one-cell texture (minimap, fallback).

### 9.3f Ceiling of the background: projection and coffers — measured (2026-11-22)

The ceiling of the background takes rows 0 to about 32 only (black band below, then the
floor). KEEP, TOWER1, MANOR and URBISH/MINE1 show the same **beamed ceiling**: crossbeams
across the corridor, longitudinal beams converging towards the centre, and a recessed
panel between them. CAVE1, SWAMP, CATWALK and RUIN show rock, moss or roots without
structure. CIMMERIA's ceiling is black.

- **Width**: a search for symmetric pairs of straight lines `x = 88 ± c · (h − y)` that
  follow the edges best gives h = 36–41.5 on KEEP and TOWER1. The longitudinal beams
  therefore converge to y ≈ 39, **the floor's vanishing point** (§ 9.3c). A ceiling point at
  lateral offset `X` (in cells) is at `x = 88 + 4 · X · (39 − y)`. The beam pair sits at
  `c ≈ 2`, i.e. X = ±0.5: on the cell boundaries. A fainter pair on TOWER1, near rows 30–35,
  fits X = ±1.5.
- **Depth**: along the centre of the ceiling, KEEP and TOWER1 share one profile. Bright
  crossbeams sit at rows 0–4, 14–17, 23–25 and 29–30, with darker bands between them. The
  centres 15.5, 24 and 29.5 are evenly spaced in `1 / (h − y)` for h = 55.15:
  `K = 145.3 / (55.15 − y)` cells puts them at K = 3.66, 4.66 and 5.66. The model then
  predicts the band at rows 0–4 (K = 2.66 → y ≈ 0.6) and a faint line at y ≈ 33, both
  present. Within each period, the bright underside of the beam is at frac K ∈ [0.65, 0.95],
  a mid band at [0, 0.3] and the dark recess at [0.3, 0.6].
- **One coffer per cell**: the crossbeams are one cell apart, and the longitudinal beams at
  X = ±0.5 pass near the edges of the game's wall pieces (x = 29, 44, 60 at rows 8, 16, 24,
  against 24, 48, 64; § 9.3d). The ceiling is a grid of beams on the cell boundaries, one
  coffer per cell.
- **Heights** (**deduced**, assuming a true perspective for each plane): lateral pixels per
  cell grow as `(y − h) / H` for a plane at height H from the eye.
  - The floor gives 0.75 · 3.1 = 2.3 px per row, so the eye is 0.43 cell above the floor.
  - The ceiling gives 4 px per row, so it is 0.25 cell above the eye.
  - The room is then 0.68 cell high, against 0.73–0.75 for the walls (128 × 96 px). With
    the horizon at y ≈ 39 on a wall of rows 0–94, the eye is 0.42 cell above the floor, which
    matches. The horizon at 47 of § 9.3a (eye at mid-height) is a property of the wall pieces,
    not of the painted floor and ceiling.
- **Texture** (`levelNN_ceil.png`, 64×64, row 0 = north when facing north):
  - **beamed ceilings**: all the visible ceiling is folded into one cell. Each row is
    split into 8 sub-rows with linear interpolation, and each pixel into 4 columns. The
    samples are weighted by the on-screen resolution, `4 · (39 − y)` px per cell, and
    symmetrised left-right, since the game flips the background at each step. The cell edge
    is placed at K ≡ 0.97, the middle of the beam (bright underside and mid band). The
    painted shading is compensated by the mean brightness of the rows within ±0.5 cell of
    depth. The result is a dark coffer framed by beams, which tiles without seams.
  - **other ceilings**: the nearest cell (K = 2.63 to 3.63, rows 0–15), rectified without
    folding; it is mirrored every other cell.
  - A fold symmetrised in all four directions was tried. It blurred the coffer into a
    cross, so it was not kept.
- **Use in the 3D view**: the game draws the same background whichever way the party
  faces, so the ceiling texture is turned to the cardinal direction nearest to the gaze,
  while staying aligned on the cells. Crossbeams therefore always run across the view, as
  in the game, in both the real and the game perspectives.

### 9.3g First floor of Yvel's houses, from the distant views — measured (2026-11-22)

Yvel's background (`YVEL1`) holds nothing but haze above the cobblestones. The far wall
pieces of the `.VMP` (159, 129; § 9.3d) are reduced, hazier copies of the near piece, with no
extra height. The upper floor is in the **decorations** (`.DAT`, § 9.4):
- **Where**: five Yvel decorations (6, 7, 8, 13, 31) are drawn **above** the wall, with
  `y < 0` at the head-on positions 1–3. The drawn width is the wall's (128, 80, 48).
- **How much shows**: the game shows more of the upper floor as the wall gets farther:
  - 8 px above the next-cell wall, which starts at row 8 of the view;
  - 20 px above the wall 2 cells ahead (row 16);
  - 27 px above the wall 3 cells ahead (row 24).
  
  Each also overlaps the top of the wall by a few pixels (the sill beam or joist ends).
  At 3 cells, the image starts 3 px above the top of the view: the artist painted only what
  the view shows.
- **Contents**:
  - 6: a tan half-timbered floor with windows;
  - 7: white half-timbering with red infill and windows with crossed glazing bars;
  - 8: brick with joist ends and shuttered openings;
  - 13: an arch with a grille, mirrored half;
  - 31: the stone of the rampart continued upwards.
- **Which walls**: they follow 23 wall types (stone, brick or half-timbered ground floors).
  The plain brick and half-timbered walls (types 1 and 2) have none: in the game, only haze
  shows above them.
- **Other tilesets**: decorations above the wall also exist in FOREST1 (8, 9: treetops,
  which the 3D view already takes from the background) and CIMMERIA. They are not used.
- **Colors**: the engine draws decorations through a distance overlay (`getLevelOverlay`,
  `drawDecorations` in `scene_lol.cpp`). The far images are moreover **painted** hazy: the
  3-cell images are almost grey, so their colors are lost.

**Reconstruction** (`levelNN_upper.png`, one 128×96 image per decoration;
`walls[id].upper` in `levelNN.json`):
1. Views 1–3 are brought to the near wall's scale: ×1, ×1.6 and ×2.67 in width; ×1, ×1.5 and
   ×2.4 in height, after the wall heights 96, 64 and 40.
2. The nearest view wins wherever it is drawn: rows 88–96 of the floor come from view 1, rows
   66–96 from view 2, rows 31–96 from view 3.
3. **2-cell view**: a linear correction per channel (mean, standard deviation). It is fitted
   on the pixels it shares with the near view, all decorations pooled: gains ≈ 1.5–1.7,
   offsets ≈ −96 to −122.
4. **3-cell view**: its brightness is kept, and colors come from the corrected 2-cell view,
   by brightness band, where the two overlap.
5. The top third of the floor (rows 0–30) is never shown by the game and stays transparent.

Fitting the haze on the wall pieces instead was tried and failed. Their 3-cell versions are
nearly grey, which makes the color fit degenerate. A color-by-color mapping learnt on the
overlaps had too few colors.

**3D view**: in Yvel, over the first repeated storey, the face draws this floor, keeping the
repeated storey visible in its unknown top third. Walls without such a decoration keep the
repeated storey.

### 9.4 Decorations — `.DAT` — verified for the head-on view

```
u16 n ; puis n entrées de 72 octets :
  u16 forme[10]   n° d'image dans le .SHP du décor (0xFFFF = aucune), une par position de vue
  u8  échelle[10]
  s16 x[10], s16 y[10]   position de l'image
  s8  suivante    décoration chaînée (dessinée en plus)
  u8  drapeaux    bit 0 : motif symétrique (voir ci-dessous)
```

**Flag bit 0 — verified.** Only the left half of the pattern is stored. The image must also
be drawn flipped horizontally, mirrored about the center of the wall, at
`x' = 128 − x − largeur`. Without this, the castle's coats of arms and banners appear
cut in half. In the castle, this concerns decorations 6 to 9, 16 and 18.

Position 1 = near wall head-on, with `x/y` relative to the 128×96 wall (**verified**
visually: banners, coats of arms, portraits, fountain). Positions 2–3 are farther
away, and positions 4–5 are probably the side views (**deduced**).

### 9.5 Sprites — `.SHP` (often inside a CPS container) — verified

```
u16 n ; u32 offsets[n+1] (relatifs à l'octet 2 ; 0 = image absente)
image :
  u16 drapeaux, u8 hauteur, u16 largeur, u8 hauteur, u16 taille, u16 taille décompressée
  si drapeaux & 1 : table de couleurs (taille = u8 qui suit si drapeaux & 4, sinon 16)
  données : LCW (sauf si drapeaux & 2), puis RLE : 0, n = n pixels transparents
  pixel = table[octet] si table, sinon index de palette
```

Monsters: images come in groups of 4. Images 0–3 are front (walking), 4–7
side, 8–11 back, 12–15 attack (**verified** on `GUARD.SHP`). The other side
is obtained by mirroring.

The door leaf (`*DOOR.SHP`, 1 image) fits into the transparent area of the "frame"
wall set (centered, aligned with the bottom of the opening).

## 10. Not decoded so far

- `.TLC` (5376 bytes per level), `.INF` beyond monster placement, `ITEM.INF`.
- Monster stats (`0x3F`), items on the floor (`0x11`). For stairs and
  teleporters, see § 6.0b and § 6.0c.
- Split of the side and distant views in the `.VMP` (not needed for the free viewer).
- `.TIM`, `.WSA` (animations), sounds.

## 10a. Reference: ScummVM (rewritten engine, GPL)

ScummVM's "Kyra" engine reimplements Lands of Lore 1 in C++, based on reverse
engineering of the original executable. It recognizes the French CD version.
- **Sources**: partial clone in `third_party/scummvm`, not versioned and read only
  (`engines/kyra`, `common`). Revision 250505e of 2026-11-09.
- **Useful files**: `engines/kyra/script/script_lol.cpp` (.INF script functions,
  `olol_*` opcode table, 175 entries), `engine/lol.cpp`, `timer_lol.cpp`, `items_lol.cpp`,
  `scene_lol.cpp`, `sprites_lol.cpp`, `gui/gui_lol.cpp`.

This is not the original code: the memory addresses of our reads (§ 12) do not appear in it.
The meaning of the functions, however, can be read directly. Comparison with our deductions:

| No. | Our deduction | ScummVM |
|---|---|---|
| 0x00 / 0x01 | write / read a wall | `setWallType` / `getWallType` ✔ |
| 0x07 / 0x08 | write / test a story flag | `setGameFlag` / `testGameFlag` ✔ |
| 0x12 | item parameter (4 = type) | `getItemPara` ✔ |
| 0x31 | door state | `triggerDoorSwitch` ✔ |
| 0x39 | teleporter effect | `fadeClearSceneWindow`: fade of the view, not specific to teleporters |
| 0x3C | level change | `loadNewLevel` ✔ |
| 0x49 | give an item | `createHandItem`: the item is created **in the hand** |
| 0x53 | item in hand | `getItemInHand` ✔ |
| 0x57 | sound | `playSoundEffect` ✔ |
| 0x5E | message | `playCharacterScriptChat`: a character's line |
| 0x60 | sound on a cell | `playEnvironmentalSfx` ✔ |

**Web version, separate from the DOSBox version** (`tools/scummvm_web.py`, 2026-11-09).
- **Build.** The WebAssembly port (Emscripten 4.0.10, `dists/emscripten/build.sh`) is
  built with the Kyra engine only: `setup configure make dist --disable-all-engines
  --enable-engine=kyra,lol`. The result (`scummvm.wasm`, 13 MB) is in
  `third_party/scummvm/build-emscripten`.
  - `kyra.dat` is copied automatically.
  - The build script calls `wget`, which is missing on the Mac: a small `curl`-based
    replacement is enough.
- **Versioned copy** (2026-11-10). The ScummVM site is in the repository, `web/scummvm`, like
  the emulators of the DOSBox version (`web/public/emulators`), ~25 MB:
  - `scummvm.wasm` and `scummvm.js`, ScummVM data (`data/`, including `kyra.dat`), licenses
    (`doc/`), generated pages (`lol.html`, `lol-game.html`, `scummvm.ini`);
  - `VERSION.txt`: ScummVM source commit, applied modification, build
    command;
  - the game files (`data/games`) stay local (links, not versioned).
  - The engine modification is committed on the local `lol-web` branch of the
    `third_party/scummvm` clone, and kept in the repository as a patch (`tools/scummvm/lol-web-state.patch`).
  - After a rebuild: `python3 -I tools/scummvm_web.py import` copies the build into
    `web/scummvm` and rewrites `VERSION.txt`.
- **Game files.** ScummVM expects the original CD layout: `GENERAL.PAK`,
  `STARTUP.PAK`, `INTRO1-9.PAK`, `INTROVOC.PAK` and `HISTORY.PAK` in a per-language folder
  (`FRE/`).
  - The installation flattened them and moved the intro fonts (`NEW8P.FNT`,
    `NEW6P.FNT`, `INTRO.FNT`) into `STARTIN.PAK`.
  - The script builds `web/scummvm/data/games/lol`: links to the game files, plus a
    `FRE/STARTUP.PAK` that merges `STARTUP.PAK` and `STARTIN.PAK`. The game folder is not
    modified.
- **Language folder files.** The CD version looks for some PAKs in `FRE/`:
  - the introduction (`setupPrologueData`);
  - the ending (`setupEpilogueData`): `FRE/GENERAL.PAK`, `INTROVOC.PAK`, `STARTUP.PAK`,
    `FINALE.PAK`, `FINALE1.PAK` and `FINALE2.PAK`. The final scene also reads its layers as
    `FRE/<file>` (`tlol_fadeInScene`).
  - The three `FINALE*.PAK` were missing: at the end of the game, ScummVM stopped on "Couldn't load
    file: FRE/FINALE.PAK". Fix of 2026-11-13: they are linked in `FRE/` like those of
    the introduction.
  - Verified by running `showOutro` with a temporary test command, removed afterwards: the ending
    plays through to the "FIN" screen.
- **Launch.** `python3 -I tools/scummvm_web.py` serves the page on port 8001, then:
  `http://localhost:8001/lol.html` (full page) or `lol-game.html` (game only).
  - This server also serves the DOSBox version (`index.html`, files from `web/public`), including
    on `/`. Started on port 8000 (`python3 -I tools/scummvm_web.py 8000`), it serves both engines
    at the same address.
  - **Engine choice** (`web/public/engine.js`): "Moteur DOSBox | ScummVM" selector above
    the volume, on both pages. The current engine is highlighted (`window.LOL_ENGINE`).
    A click asks for confirmation, then loads the other page: `index.html` or `lol.html`. On
    port 8000, `lol.html` is fetched from port 8001. If that server does not respond, the button
    is greyed out. Saves do not carry over from one engine to the other.
  - The `lol-fr` target comes from the `scummvm.ini` written by the script: game path, `language=fr`.
    Without the language, the game is detected as English and looks for `ENG/`.
  - The browser downloads this `scummvm.ini` only on first launch, then keeps its copy
    in IndexedDB. The `lol.html` launcher refreshes the `[lol-fr]` section (below).
  - **Fix of 2026-11-13**: the launcher replaced the whole `[lol-fr]` section with the
    server's. But ScummVM also stores the game settings there: `subtitles`,
    `speech_mute`, `music_volume`, `sfx_volume`, `speech_volume`, `walkspeed`… These settings
    were therefore lost on every launch. Now only the server's keys (path,
    language, keys) replace theirs, and the others are kept. Verified: music set
    to 30 % (`music_volume=76`), still there after reloading the page.
- **ZQSD movement** (verified 2026-11-09). The engine exposes its keys through ScummVM's
  "keymapper": keyboard `lolkeyb`, actions `MVF`, `MVB`, `SLL`, `SLR`, `TL`, `TR`
  (`engine/lol.cpp`). Default: up and down arrows, left and right arrows (sidestep),
  Home and Page Up (turn).
  - ScummVM web reads the **physical position** of keys with QWERTY names. On an
    AZERTY keyboard, Z arrives as "w", Q as "a" and A as "q".
  - The `scummvm.ini` therefore adds, at the AZERTY positions: Z forward (`w`), S back (`s`),
    Q / D turn (`a`, `d`), A / E sidestep (`q`, `e`).
  - Example: `keymap_lolkeyb_MVF=UP w`.
  - Turning and sidestepping are swapped compared with the DOSBox version, at the
    user's request.
  - The game disables this keyboard while a save name is being typed (`gui_lol.cpp`), which
    replaces the pause detection of the DOSBox version.
  - Test with a simulated AZERTY keyboard (physical code + AZERTY letter): Z moves forward, Q turns,
    D turns the other way, A sidesteps left.
  - In the save name, the letters are typed: the game keyboard is indeed disabled.
- **`lol.html` launcher.** The browser keeps its `scummvm.ini` in IndexedDB (database
  `/home/web_user`, store `FILE_DATA`). If it had been created before the `lol-fr` target,
  ScummVM stopped (`exit(1)`).
  - `lol.html` is generated from `scummvm.html`. Before loading `scummvm.js`, it
    replaces the `[lol-fr]` section of the stored file with the server's.
  - Verified: section removed by hand, reload, the section comes back with the keys and
    the game starts.
  - Since the minimap was added, this launcher is called `lol-game.html` (game only) and
    `lol.html` is the full page (below).
- **Keys received several times** (2026-11-10). SDL3 (emscripten port) subscribes to the keyboard
  on `window` each time a window is created (launcher, game, mode changes) without removing
  the previous subscription: 6 subscriptions in game.
  - A single keypress therefore reaches SDL 6 times, with the same timestamp. SDL marks the copies
    as repeats (`repeat`), and ScummVM passes them on to the game (trace added
    temporarily in `sdl3-events.cpp` and `kyra_v1.cpp`).
  - Effects: doubled letters in the save name ("teeeeeessssst"); Escape opened the
    menu then closed it immediately (the menu button, no. 88, has `keyCode2 = 110` = Escape, and
    so does "Reprendre la partie"). The `lolkeyb` keyboard actions ignore repeats,
    hence some letters spared.
  - Fix in the launcher: it intercepts `window`'s `addEventListener` for
    keyboard subscriptions coming from `scummvm.js`, and calls only the last one (active window).
    The page's own listeners are not filtered.
  - Verified by the user: no more doubled letters.
  - Escape alone: in ScummVM, while exploring, the key is also a "skip" and does not
    always open the menu. The O key (action `OPT`) opens the menu reliably.
- **Minimap, 3D view and panel** (2026-11-10). The DOSBox version reads the emulated PC's memory
  on the `lol-mem` channel (§ 12). For ScummVM, the engine publishes its state in the same form:
  - `tools/scummvm/lol-web-state.patch` (to apply in `third_party/scummvm` before
    building) adds `LoLEngine::webPublishState()`, called in `runLoop()`. Every
    150 ms, it lays out the engine structures as in the DOS game (packed structures,
    4-byte pointers set to 0) and sends them to the page (`EM_ASM`, `Module.lolState`).
  - ScummVM's structures keep the field order of the DOS game. Packed, they
    match the sizes and offsets of § 12: grid cell 10 bytes, item 16, monster
    46 (x field at +7, `facing` direction at +24, type at +32), character 130 (HP at +57,
    equipment at +80, levels at +102, experience at +108). The flag table
    (`_flagsTable`, bit `n & 7` of byte `n >> 3`) has the DOS 16-bit word order.
  - Zones sent, at DOS addresses: cell `0x3E4E0`, direction `0x3E4EF`, grid `0x3E713`,
    items `0x31F6D`, monsters `0x3186A`, party `0x3389D`, flags `0x3E55C`, bag `0x3E4F6`,
    hand `0x3E558`, money `0x3E6F0`, experience table `0x30270`, and `0x5D6B5` (1 during
    a special scene, `_specialSceneFlag`, otherwise 5).
  - `lol-game.html` answers reads on the `lol-mem` channel with these zones (zeros elsewhere).
    Searches: nothing found (sprites chosen from the flags, otherwise the first one).
    Writes: refused; the cheats and item creation are hidden.
  - `lol.html` is `web/public/index.html` without js-dos, with `lol-game.html` in a frame.
    The server serves files missing from the build from `web/public`. `minimap.js` is not
    modified.
  - Verified (automated test, sound muted): "Niveau 1 — Gladstone", cell 13,17 North,
    41 crowns; after D then Z: cell 14,17 East. The 3D view and the stats follow.
- **Inventory management from the panel** (2026-11-10, ScummVM version only).
  - Equipping an item is not just writing its number. The game (`clickedCharInventorySlot`,
    `gui_lol.cpp`) recomputes the stats (`recalcCharacterStats`), runs the script of
    the removed item (`runItemScript(…, 0x100)`) and that of the placed item (`0x80`): passive
    effects, strength and protection. A memory write would leave the character inconsistent.
  - The page therefore sends **commands** that the engine runs in its loop
    (`webRunCommands`, called by `webPublishState`) with its own functions:
    - move (swap if the target slot is occupied), delete (`deleteItem`), create
      (`makeItem` then `addItemToInventory`);
    - slots: 0 to 47 bag, 100 hand (`setHandItem`, cursor included),
      200 + char × 11 + equipment slot;
    - an item goes into an equipment slot only if its type's mask allows it
      (`_itemProperties[…].type`, slot bit), as in the game;
    - replies: 0 done, 1 impossible, 2 bag full, 3 empty slot.
  - Transport: `LoLMem.RemoteMemory.cmd()` on the `lol-mem` channel → `lol-game.html`
    (`Module.lolCmds`) → engine → `Module.lolCmdDone`.
  - The engine did not keep the size of the item type table: added
    `_webNumItemProperties` (set by `olol_allocItemPropertiesBuffer`).
  - Panel (`minimap.js`, active if `window.LOL_ENGINE === "scummvm"`): drag a slot onto
    another (bag, hand, equipment); in an item's card, "Prendre en main",
    "Ranger dans le sac", "Équiper : <personnage>", "Supprimer" (two clicks); "Créer un
    objet" goes through the command. With DOSBox, nothing changes (no item scripts when
    writing memory).
  - Verified (automated test, sound muted): dwarf helm (type 17) created in the bag, equipped
    on Michael (head), put away, dragged into the hand (the game shows "Heaume de nain pris(e)."
    and the cursor carries it), deleted; Bezel ring (225) dragged onto the head: refused.
- **Monster sprites** (2026-11-10, ScummVM version). A monster type can have several
  appearances depending on the story (level 2: ORC or THUG; 7: SCAVNGR or RATMAN; 11: SWAMPMON
  or HURZELL; 23, 26, 29…). The level script loads a sprite file into one of
  3 slots (`loadMonsterShapes(file, slot, …)`), and each type points to a
  slot (`_monsterProperties[type].shapeIndex`).
  - DOSBox version: the page searches memory for the signature of the loaded sprites, otherwise follows the
    script's condition (flag). ScummVM version: no search possible, hence wrong
    sprites.
  - The engine keeps the name of the file loaded into each slot
    (`_webMonsterShapeFile`, filled by `loadMonsterShapes`). It publishes, in a zone specific
    to the web version (`0x7F000000`, outside DOS memory), the name for each of the 5 types
    (13 bytes per type).
  - `minimap.js` (ScummVM version) rereads these names on every update: the map and the 3D view
    follow even a slot reload mid-level.
  - Web command added for tests: go to level n, cell c (`goto`, op 4), like
    `olol_loadNewLevel`.
  - Verified (automated test, sound muted): level 1 GUARD; level 2 type 1 = THUG (not ORC),
    type 2 = BOAR; level 7 type 2 = CAVEDWLR; level 11 type 1 = SWAMPMON, type 2 =
    SWAMPCIT. Map and engine agree.
- **Cheats: infinite HP and magic, crowns** (2026-11-10, ScummVM version).
  - DOSBox version: the page resets HP and magic to maximum every 100 ms; a strong enough hit
    between two writes is still fatal.
  - ScummVM version: every change in HP or magic goes through
    `setCharacterMagicOrHitPoints(char, type, points, mode)` (damage from `inflictDamage`, spells,
    poison…). With the cheat active, a decrease there is replaced by the maximum, before the death
    test (`hitPointsCur < 1` → flag 8): truly infinite HP. Each loop iteration also restores
    to maximum what was lost before activation.
  - Commands: op 5 (mask: 1 HP, 2 magic), resent by the page on change and every
    3 s (the game may have restarted); op 6: add crowns (`giveCredits`, coin pile
    redrawn). Test commands: op 7 monster damage (`inflictDamage`), op 8
    magic spent.
  - Verified (automated test, sound muted), Michael: without cheat, 5 damage → 15/20 HP, 3 magic
    → 3/6; cheats checked → 20/20 and 6/6; 500 damage and 50 magic → unchanged, alive;
    unchecked, 4 damage → 16/20; "+100 couronnes": 41 → 141.
- **Level up** (cheat, "+" button of a skill).
  - **DOSBox**: the page writes the level, experience and bonuses to memory.
  - **ScummVM**: the page cannot write into the engine, which explains the breakage
    (2026-11-13). It sends op 10, and the engine calls
    `increaseExperience(char, skill, threshold − xp)` with the threshold `_expRequirements[level]`.
    These are the game's rule and bonuses: HP, magic, message. Level 10 is the maximum.
  - **Verified**: Fighter 1 (1 xp) → 2 (500 / 1500 xp).
- **Casting a spell from the page** (ScummVM version, 2026-11-13).
  - **Published spells**: zone `0x7F000300`, 7 entries of 48 bytes, one per spell known to the party
    (`_availableSpells`, -1 = empty). Content of each entry: type (i8), a 0 byte, then the
    magic cost and HP cost of the 4 levels (`_spellProperties[t].mpRequired` and
    `hpRequired`, u16), then the name (`getLangString(spellNameCode)`, 30 bytes, CP850).
  - **Command op 9**: a = caster, b = type | level (0 to 3) << 8 | (target + 1) << 12. It
    reproduces `clickedMagicSubmenu` (a portrait's magic menu):
    - refused if the character is busy or unconscious (`flags & 0x314C`) or if a magic menu
      is open;
    - `checkMagic`, which displays the game's message;
    - flag 4, `castSpell`, `setCharacterUpdateEvent(char, 1, 8, 1)`, then magic experience
      level².
  - **Return codes**: 4 = not enough magic or HP; 5 = spell impossible here (wall right
    in front for a spell with flag 0x100).
  - **Heal (type 1) levels 1 to 3**: the game normally waits for a click on a portrait
    (`processMagicHealSelectTarget`). The target given by the page is applied like
    `clickedSpellTargetCharacter`: `castHealOnSingleCharacter`, then back to the normal
    buttons.
  - **Verified**: Michael, Étincelle level 1 → magic 6 → 1. Targeted healing is not tested, for lack
    of a healing spell at the start of the game.
- **Auto-attack by spell** (ScummVM version, 2026-11-13).
  - **Setting**: each character attacks with their weapon or with a known offensive spell
    (Étincelle 0, Gel 2, Boule de Feu 3, Poing Mortel 4, Brume Fatale 5, Foudre 6). Command op 19
    (a = character, b = spell, or -1 for the weapon). The engine keeps the choice in `_webAutoSpell`,
    and the page resends it every 3 s.
  - **Spell**:
    - it fires when `getSpellTargetBlock` (range 3 cells) finds a hostile monster;
    - the level is the highest whose `mpRequired` and `hpRequired` are covered;
    - casting goes through `webCastSpell`, the same function as command op 9 (like
      `clickedMagicSubmenu`);
    - if no level is possible, the character strikes with their weapon on the cell in front.
  - **Verified** on level 6, with Michael on Étincelle:
    - magic 6 → 1 (level 1, which costs 5); magic experience 1 → 11 with the monster killed;
    - then, with no magic left, he strikes with his weapon: combat experience 1 → 34.
- **"Débloquer" (Unlock) dialog: atlas, compass, spells** (ScummVM version, 2026-11-13; "Débloquer…" button, first called "Triches").
  - **Flags**: the atlas and the compass are flags of `_flagsTable[31]`, i.e.
    story flags 252 and 254 (byte 31 of the table published at `0x3E55C`).
    - 0x10: the atlas. `gui_drawPlayField` draws the book on the right, below the compass;
      `clickedAutomap` opens only with this flag; `updateAutoMap` records seen cells
      only with it.
    - 0x40: the compass, drawn at the top right and updated by `updateCompass`.
    - 0x20: the spell book, i.e. the scroll at the top left. Without it,
      `gui_drawPlayField` resets `_selectedSpell` to 0 and does not show the list. Not set at the start
      of the game (verified).
    - (0x08: the lamp.)
  - **Command op 18** (a = mask of 0x10, 0x20 and 0x40): it sets the flags, records the current
    cell in the in-game automap, redraws the play field and restores the brightness.
    Refused during a dialogue or a scene.
  - **Spells**: the player's 7 spells, with their state (known or not) and an "Apprendre" button
    (command op 11). This unlocking was moved out of the Magic panel.
  - **Verified**: at the start of the game, the atlas then the compass are unlocked and appear on
    the game screen; Soins is learned from the dialog. The unlocked spell book makes
    the scroll appear, with Étincelle.
- **Translucent monsters** (2026-11-14; e.g. TCABAL, level 27).
  - **Flag**: the monster type has bit 0x800 (`LoLMonsterProperty::flags`, 28th argument
    of `olol_loadMonsterProperties`, script function 0x3F). `drawMonster` then sets
    `flg |= 0x20`, and `drawDoorOrMonsterEquipment` draws with 0x1000 and the
    transparency tables (`drawShapePlotType21`).
  - **Static**: in the script, this argument is computed and cannot be read statically. The engine
    therefore publishes the flags of the 5 types in zone `0x7F000900` + 10 (5 × u16).
  - **Verified** at level 27: type 1 (TCABAL) 0xF810, translucent; type 2 (HATCHETS) 0xE000,
    opaque, although its colors are also entirely between 2 and 20.
  - **Tables**: `LEVELnn.TLC` (loaded by `loadLevelGraphics`), T1 of 256 bytes then T2 of
    20 × 256.
  - **Rendering in the game** (`drawShapePlotType21`), for each pixel:
    1. color c (the shape's color table);
    2. t = T1[c]; if t < 0x80, the color becomes T2[t × 256 + tileset color]. Colors 2 to
       20 give t = 1 to 19; color 0 gives t = 0, the identity row, so nothing;
    3. then the distance brightness overlay (attenuation table), applied to the result;
    4. if the result is non-zero, it is drawn.
  - **3D view**: the sprite sheet `levelNN_ghost.png` is exported for sprites where at least 50 %
    of the pixels are between 2 and 20.
    - Each index t is approximated there by "tint + opacity": least squares of
      `(1 - a) × tileset + a × tint` over the 256 tileset colors. This gives a ≈ 0.35, with an
      error of about 22/255.
    - Blending with the tileset happens at draw time, followed by distance darkening.
    - The sprite sheet is only used for translucent monsters: engine flag under
      ScummVM, list `TRANSLUCENT_KNOWN` = {TCABAL} under DOSBox.
  - **Remaining**: the resulting tint is greyer than in the game, where TCABAL look
    bluish. The linear approximation of T2 does not render this nuance; to be revisited.
  - **Brightness overlays** (`generateOverlay`, noted for reference):
    - overlay i (0 to 6): each color is blended (100 - i × W) % towards the "special
      color", then replaced by the closest of colors 1 to 127 other than itself;
    - colors 128 to 255 unchanged; overlay 7 = identity;
    - special color and W: arguments 2 and 3 of `olol_loadLevelGraphics` (function 0x09), for
      example 1 and 12 at level 27;
    - choice of a monster's overlay (`drawItemOrMonster`): `r = 7 - (layer / 3 - 1)`,
      with layer = depth / 32, i.e. 8 layers per cell.
- **Monster health bar in the 3D view** (ScummVM version, 2026-11-13).
  - **Current hit points**: the monster's `hitPoints` field, at +29 in the 46-byte record,
    i.e. +22 from x in `readMonsters`.
  - **Maximum**: that of the type (`_monsterProperties[type].hitPoints`), published in zone
    `0x7F000900` (5 × u16). It is also the experience gained by killing the monster
    (`increaseExperience`).
  - **Drawing**: the bar is drawn after the columns, above the sprite. It is green
    above 60 %, yellow above 30 %, red below. It is hidden if the monster's center
    is behind a wall (`zbuf`), if it is dying (mode ≥ 13) or if it is at 0.
  - **Only near monsters** (2026-11-22): the bar is drawn only within 2.5 cells ahead of
    the party (`HP_BAR_DIST`), i.e. the adjacent cell and the next one.
  - **Verified** at level 6, facing the rats: full bars, then the closest one turns yellow
    under auto-attack.
- **In-game automap, all levels** (ScummVM version, 2026-11-19; "◐ jeu" (game) mode of the maps).
  - **Marking**: `updateAutoMap` sets `flags |= 7` on the party's cell and on its 8 neighbors.
    A neighbor is not marked if a wall separates it: `_wllAutomapData[wall] & 0xC0`.
    Marking only happens if the atlas is owned (`_flagsTable[31] & 0x10`). Without the atlas, nothing is recorded.
  - **Where it is stored**:
    - current level: `_levelBlockProperties[i].flags`, byte 9 of the grid in DOS;
    - levels left: `_lvlTempData[n-1]->flags`, a copy of the flags of all cells;
    - visited levels: `_hasTempDataFlags`, bit n-1 for level n. This data is saved with the game.
  - **Reading by the game**: the game's map (`displayAutomap`) goes through the visited levels with its
    arrows (`automapForwardButton`). For each one, it reloads this data (`restoreBlockTempData`).
  - **Published zone `0x7F001000`**:
    - visited levels: u32, plus the current level;
    - then 29 × 128 bytes, one bit per cell (`flags & 7`). Cell i of a level is bit `i & 7` of byte `i >> 3`.
  - **"◐ jeu" mode**: the maps' ◐ button switches from "whole map" to "page exploration",
    then to "game map". In game mode, you see exactly the game's cells; the ↺ buttons are disabled.
    Under DOSBox, only the current level is known (live grid).
  - **Verified**:
    - new game: 0 cells before the atlas, 8 after 5 steps;
    - level change (op 4): the 8 cells of level 1 remain published and are shown on the full map.
- **Choosing companions** (ScummVM version, 2026-11-13; character sheets dialog, "Compagnons" (Companions)).
  - **Party size**: 3 characters at most (`addCharacter` refuses beyond that), stored without gaps
    from slot 0 (`countActiveCharacters` stops at the first inactive character). Slot 0 is
    the hero chosen at the start.
  - **Predefined characters**: `_charDefaults`, the table from `kyra.dat`. Order and id: Michael
    (-1 ?), Timothy 2, Baccata 3, Lora 4, Conrad -5, Paulson 6, Dawn 7, Kieran -8, Ak'shel -9.
    Negative ids are the playable heroes. Published in zone `0x7F000800`: count, then id
    (i16), name (11 bytes) and race/class/sex for each.
  - **Command op 17**: a = slot (1 or 2), b = id, or 0 to empty the slot.
    - The character is copied from the table, like `addCharacter`: default modifiers,
      face `FACEnn.SHP`, starting items created with their script 0x80.
    - The replaced character's items go into the bag, or on the floor if the bag is full.
    - An emptied slot shifts the following ones (sheets and faces).
    - The playfield is then redrawn.
  - **Risk**: the story scripts add and remove companions themselves by id
    (`olol_addRemoveCharacter`). A companion added outside the story may not be expected
    later on.
  - **Verified**:
    - Timothy added in slot 2, then Baccata in slot 3;
    - when emptying slot 2, Baccata moves to slot 2;
    - Timothy's 4 items arrive in the bag (3 → 7 cells);
    - the game's portraits are up to date.
- **Saving from the page** (ScummVM version, 2026-11-13; "Sauvegardes…" (Saves) dialog).
  - **Command op 16**: a = slot (-1 = first free from 0, like
    `getNextSavegameSlot` for LoL). The name is passed as text: the page encodes it as UTF-8
    bytes, attached to the command, which the engine reads in `Module.lolText`.
  - **Like the "Sauvegarder" menu** (`clickedSavenameMenu`): `updatePlayTimer` then
    `saveGameStateIntern(slot, name, nullptr)`. With no thumbnail provided, the engine generates it
    (`generateSaveThumbnail`). The list is then reread.
  - **Encoding**: the game stores names in UTF-8 (`convertString_KYRAtoGUI`), and the page's list
    decodes them as UTF-8, not CP850.
  - **Verified**:
    - "Fontaine été" saved in slot 0;
    - default name "Gladstone 13/11 21h02" in slot 1;
    - loading slot 0 brings the party back to 13,17.
    - "Écraser" (Overwrite; same command with a given slot) has not been tried.
- **Loading a save from the page** (ScummVM version, 2026-11-13; same dialog).
  - **List**: command op 14 rereads the `lol-fr.###` files (`listSavefiles`, header read
    by `readSaveHeader`, like `KyraMetaEngine::listSaves`).
  - **Zone `0x7F000700`**: count (u16), then number (u16) and name (40 bytes) for each
    save. 0xFFFF as long as no list has been requested.
  - **Loading**: command op 15 checks the save (`saveFileLoadable`), then sets
    `_gameToLoad`, like the "Charger une partie" menu (`gui_lol.cpp`). `runLoop` loads it on
    the next turn.
  - **Verified**: save "test web" made from the game menu, in cell 13,17; teleport
    to 12,12; loading from the page → back to 13,17.
- **Teleportation** (ScummVM version, 2026-11-13).
  - **Within the level**: command op 13 (a = cell, b = direction or -1). It does the same as
    `olol_setGlobalVar(0, …)`, used by the scripts' teleporters: `_currentBlock`,
    `calcCoordinates(… 0x80, 0x80)` and `updateAutoMap`, plus `completeDoorOperations`, then the
    scene is redrawn (`gui_drawScene(0)`). No cell script is run on arrival.
  - **Refusal**: solid cell (all four faces have `_wllWallFlags & 7`), dialogue or scene
    (`_updateFlags & 0x0F`), controls disabled or magic menu open.
  - **To another level**: command op 4, already present (like `olol_loadNewLevel`).
  - **Page**:
    - double-click on an explored, non-solid cell of the minimap;
    - double-click on a place in the list;
    - "Aller à" (Go to) selector (level, then place or passage). The free cell closest to the place
      is chosen: live grid for the current level, original map for the others.
  - **Verified**:
    - Gladstone 13,17 → Fontaine (12,12);
    - double-click 13,17 → 13,15;
    - "Aller à" Forêt du Nord → level 2, cell 13,1.
- **Game volumes** (ScummVM version, 2026-11-13): ⚙ button next to the master volume, with
  three sliders, Music, Effects and Voice.
  - **Reading**: the engine publishes `getVolume(music, effects, voice)` in zone `0x7F000600`
    (3 bytes). The scale is that of the game's "Contrôles audio" menu: 2 = muted, up to 102.
  - **Setting**: command op 12 (a = type, b = 2 to 102) calls `setVolume`, like the
    menu sliders (`clickedAudioMenu`), which converts to the mixer and stores
    `music_volume`, `sfx_volume` and `speech_volume`. Then `ConfMan.flushToDisk`.
  - **Voice muted** (2): `getVolume` returns 2 and the game switches to text only.
  - **Verified**: 75 / 75 / 75 at start; music 30 and voice 0 → the engine reads 31 (rounding of
    the conversion), 77 and 2.
- **Auto-attack** (ScummVM version, 2026-11-13; "Attaque auto" checkbox next to the cheats).
  - **Command**: bit 4 of the op 5 mask, sent with the cheats.
  - **Trigger**: at most every 200 ms, in the main loop. Each active and ready character
    (no `flags & 0x314C`) strikes as if its weapon were clicked
    (`clickedAttackButton`).
  - **Target**: the monster closest to the character in the cell in front of the party
    (`getNearestMonsterFromCharacter`, 0xFFFF = none). Same weapons, ammunition, cooldown
    and experience as in the game.
  - **Exceptions**: peaceful monsters (mode 1, like the Gladstone guards) are not
    attacked. The mode is suspended during dialogues and scenes (`_updateFlags & 0x0F`),
    when controls are disabled (`_weaponsDisabled`) and when a magic menu is open.
  - **Verified**: level 6, cell 7,7, with infinite hit points. Facing a monster, Michael's combat
    experience goes from 1 to 9, then to 13, without any click.
- **Unlocking spells in advance** (ScummVM version, 2026-11-13).
  - **The player's spells** are types 0 to 6: Étincelle, Soins, Gel, Boule de Feu, Poing
    Mortel, Brume Fatale, Foudre. They correspond to the 7 slots of `_availableSpells`. The following
    types (8 and up: fog, swarm, Vaelan's cube, guardian…) are only cast by
    items, with a negative caster in `castSpell`.
  - **Zone `0x7F000480`**: the player's 7 spells, known or not, as 46-byte entries. Each
    entry gives the magic point cost and the hit point cost of the 4 levels (u16), then the name (30 bytes).
  - **Command op 11**: a = spell, b = character who passes it on. It calls
    `addSpellToScroll`, like the script function `olol_addSpellToScroll` (magic masters,
    scrolls). For types above 1, the game plays the animation of the spell moving from the
    portrait to the scroll.
  - **Redraw**: page 2 is redrawn, then copied to the screen, if the scroll is
    displayed (`_flagsTable[31] & 0x20`). Before the first addition, the scroll was not visible
    on screen; afterwards, it is. Since flag 0x20 is not set at the start (see "Cheats"), it is
    probably the transfer animation that draws the scroll (not verified).
    Code 6 = already known.
  - **Verified**: at the start of the game, the 6 missing spells were unlocked one by one, then
    with "Tout" (All). They appear in the game's scroll and in the Magic panel.
- **Item directory** (both versions): dialog ("Annuaire des objets…" (Item directory) button
  under the inventory) with the 283 items of `items.json`, sorted into tabs (minimap
  categories), with a text filter. The sheet is shown on the right. The "+" button creates the item in the bag
  (op 3 under ScummVM, memory write under DOSBox); a click opens the sheet.
- **Per-monster appearance** (2026-11-10, 3D view, DOSBox and ScummVM versions).
  `LoLEngine::drawMonster` varies the same sprite in two ways:
  - **color variant**: the monster's `flags & 7` (byte +25 of the structure, 6th argument
    of script function 0x38, often computed, so read from live monsters). Image 16
    of the .SHP file is a table: column 0 = original colors (one per row), column d =
    replacement for variant d (0 or missing: unchanged). E.g. BANDIT: 88-94 (cloak) →
    112-118, 119-125 or 34-40; column 4 = original. Hence green, olive, grey-green, red cloaks;
  - **equipment**: `equipmentShapes[4]` (bytes +42 to +45), sets 1 to 4; for body image f,
    the game draws image 17 + (set − 1) × 16 + f of the same file, at the same place
    (helmet, mace, shield…: GUARD, ORC, THUG, AMAZON, PENTROG, WRAITH…). BANDIT has no
    equipment images.
  - `tools/export_viewer.py` exports `spriteVariants` (RGB color pairs per variant) and
    `spriteEquip` (4 × 16 images added to the sprite sheet); `minimap.js` passes each monster's `variant` and
    `equip`; the 3D view composes the image (recoloring + equipment) and caches it
    with its shade levels (`monsterLook`).
  - Verified: sprite sheet of the 4 variants of BANDIT and of ORC with equipment 1, 1+3, 2 (variant 2).
    At level 6, the 4 live bandits have variants 0, 2, 3 (drawn at load time).
- **Monster animations (attacks, hits, walking)** (2026-11-10, ScummVM version). The game
  picks the image in `getMonsterCurFrame(m, direction flags)`: according to the sprite's
  animation type (`_monsterAnimType`, 4 cases), the mode (5 idle, 8 combat, 11 / 13…),
  `fightCurTick`, `currentSubFrame`, hits received; direction via
  `_monsterDirFlags[(party direction << 2) + facing]` (bit 0x10 = flipped image). The engine
  publishes the image it draws for each of the 30 monsters (zone `0x7F000200`, 2 bytes:
  image 0-15 or 255, flipped); the synchronized 3D view, whose camera is the party's,
  uses it as is. Verified: bandit in front attacking → images 14, 15; 3D view mid
  club swing.
- **Items lying on the floor in the 3D view** (2026-11-10, DOSBox and ScummVM versions).
  `LoLEngine::drawObjects` draws an item on the floor with: if flag 0x40 of its type is set,
  image `shpIndex` of `GAMESHP.SHP`; otherwise image `_gameShapeMap[shpIndex × 2]` of
  `ITEMSHP.SHP` (`STARTUP.PAK`). `_gameShapeMap`: 276-byte table from `MAIN.EXE`
  (offset 0x2B35C in the CD version, found by its first bytes 15 5A 05 37 09 38).
  `shpIndex` and flags: bytes 2 and 3-4 of the type's record (`tools/data/items_fr.json`).
  - `tools/export_viewer.py`: `item_floor.png` (52 images) and `item_floor.json` (image per type,
    285 types).
  - `minimap.js` sends the 3D view the items of the live grid (the cells' item chains),
    except those stored in a wall or a chest, with their fine position (x, y: cell + low byte
    / 256); the 3D view draws them like monsters (same scale, placed on the floor).
  - Verified (ScummVM): level 2, damaged dagger at 8,4 seen from 8,5: same image and same
    place as in the game.
- **Hit splashes in the 3D view** (2026-11-10, ScummVM version). When a monster is
  hit (`damageReceived`), `drawMonster` draws image 6 of `GAMESHP.SHP` on top, at the
  monster's center offset by `hitOffsX/Y` (random, ±12), scaled down by a factor
  `bloodAmount` = max HP / damage (1 to 4; when dying, `fightCurTick × 2`), colors 2-7
  shifted according to the type's `flags & 0xC000` (+63, +15, +74). The engine publishes scaling and
  color with each monster's image (zone `0x7F000200`, 4 bytes); the export adds the
  4 splash colors to `item_floor.png` (`blood`); the 3D view draws it on the monster.
  Verified by a render of the 3D view alone (bandit hit).
- **Copying the game image into the 3D view: removed** (2026-11-10, at the request of the
  user, who prefers the 3D even during spells, dialogues and cutscenes). The copy
  (then an overlay of only the pixels changed during spells) existed briefly; the
  engine still publishes the display state (zone `0x7F000100`, including `_webCasting`: spell in
  progress, set by `castSpell`), read by `lolView()` in `lol-game.html` for debugging.
  History:
- **Game image in the 3D view** (2026-11-10, ScummVM version, removed): full-screen places (panoramas),
  dialogues, sequences, cutscenes.
  - Cause of the reported "black": in a special scene, the minimap requested the exported image of the
    place; with no image for that cell, the view showed a black "Lieu" (Place) background. ScummVM reports
    a special scene also during dialogues and sequences. Fixed: with no known image, the 3D
    view stays displayed (also for DOSBox).
  - The engine also publishes from `delay()` (called by all wait loops:
    dialogues, sequences, menu; commands remain reserved for the main loop) a
    display zone (`0x7F000100`): `_specialSceneFlag`, `_updateFlags`, sequence window
    (`gui_prepareForSequence`: 112,0-288,120 for the scene window, width 320 = full
    screen), open menu, `runLoop` turn counter.
  - `lol-game.html` (`lolView()`):
    - before the game (main loop never started: introduction) → whole screen;
    - menu, level change (`_webLoadingLevel`, set by `loadLevel`, cleared on the next
      turn of the main loop) or exploration → nothing (3D view);
    - special scene or `_updateFlags & 1` → sequence window; width 320 → whole screen;
    - main loop stopped for 0.5 s (dialogue, scripted cutscene) → scene window
      only (112,0, 176 × 120), never the interface.
    - Fixed on 2026-11-10: the first version copied the whole screen, interface included,
      during level changes and the guard scene in front of Gladstone. Verified: going from
      level 2 → 1 → 3D view kept; introduction in full screen.
  - `lol.html` copies the ScummVM canvas (`captureStream`, video) into the 3D view, cropped.
  - Verified: introduction copied; nothing during exploration or in the menu. Dialogues and
    panoramas not tested automatically (they must be triggered in the game).
- **Music paused in the menu** (ScummVM version): `clickedOptions` pauses the mixer
  (`_mixer->pauseAll`) during `runMenu`. Not verified by ear (tests without sound).
- **Master volume** (DOSBox and ScummVM versions): `web/public/volume.js` inserts a shared WebAudio
  gain between every node and `AudioContext.destination` (`AudioNode.prototype.connect`
  intercepted); slider in the page (remembered), also applied to the ScummVM frame. Verified:
  slider at 30 % → game gain 0.3.
- **Verified** (automated test, sound muted, SwiftShader software WebGL): the game is detected as
  "CD/DOS/French". The intro, the title menu ("Nouvelle Partie") and the character
  selection are displayed in French.
- Rendering goes through OpenGL (WebGL): without WebGL, ScummVM stops.
- Saves and settings stay in the browser (IndexedDB), separate from the
  DOSBox version.

## 11. Tools and outputs

| Tool | Role | Output |
|---|---|---|
| `tools/extract_maps.py` | grids, walls, annotations, monsters | `maps/levelNN.json/.png`, `maps/levels.json`, `maps/raw/` |
| `tools/export_viewer.py` | face textures, background, sprites | `web/public/viewer/data/` |
| `web/public/viewer/` | free-roaming 3D viewer (home-made ray casting) | http://localhost:8000/viewer/ |
| `web/public/minimap.js`, `memscan.js` | live minimap next to the game | http://localhost:8000/ |

**Full map (Tab key)**: dialog that reuses the minimap drawing in a
second canvas.
- **Framing**: the cell size fills the screen (10 to 40 px) and the whole level is centered.
- **Tiles**: those of the illustrated rendering are kept per cell size. The two maps therefore do not
  compete for them.
- **Keyboard**: Tab opens and closes the map, also when the game has the keyboard. A capture
  listener is set in the ScummVM frame's window. Tab is ignored during text input or when
  another dialog is open.
- **Hover**: shows the cell's tooltip.
- **Double-click** (ScummVM version): teleports the party to the cell, as on the minimap.
- **Verified**: Tab from the game opens the map; a double-click on the Fontaine moves the
  party from 13,17 to 12,12; Tab closes the map.

**Minimap size, zoom and centering** (settings remembered).
- **Size**: the map takes 256 to 768 px on screen, in steps of 64; the panel follows.
- **Zoom**: 6 to 40 px per cell, with the buttons or the mouse wheel on the map.
- **Centering (⌖)**: the view follows the party, which stays in the center. Without centering, the whole map
  is centered, or the view is clamped to the level when it overflows.

**Progressive minimap exploration** (◐ button, setting remembered; ↺ forgets the level).
- **In-game automap.** The engine marks seen cells in the grid flags
  (byte 9, `flags |= 7`, `updateAutoMap` in ScummVM). It marks the party's cell and its
  8 neighbors. A neighbor is not marked when the wall faces separating it have bit
  0xC0 in `_wllAutomapData`.
- **Condition.** This marking only happens if the global flag `_flagsTable[31] & 0x10` is set.
  At the start of the game, in Gladstone, byte 9 stays at 0 everywhere, even after a few steps (verified
  under ScummVM). The flag therefore depends on the storyline.
- **Tracking by the page.** The minimap therefore keeps its own record, for both engines:
  - the party's cell and its 4 neighbors;
  - a diagonal if one of the two sides is open;
  - up to 3 cells in front of the party, with their sides, up to the first wall, closed door or
    false wall.
- **Merging.** The game's marks (byte 9 & 7) are added to it.
- **Storage.** The record is kept in `localStorage` (`minimapSeen:<engine>:<level>`). It does not
  follow saves.
- **Display.** Unseen cells are dark. The markers they carry (places, items,
  chests, locks, monsters, passages) are hidden, and the "Lieux" (Places) and "Objets" (Items) lists only
  give those that have been discovered.

**Illustrated minimap rendering** (▦ button, setting remembered). Cells reuse the
place's graphics exported for the 3D view:
- **floor**: `levelNN_floor.png`, one cell seen from above (§ 9.3c);
- **walls**: the level's most frequent opaque face (`walls[id].tex`), cropped at the center
  and darkened;
- **closed doors**: their own face, with a colored border.

A cell that contains only one item type shows that item's icon
(`ITEMICN.SHP`, byte 2 of the item table), framed in cream. Other cells
keep their category icon, framed in cyan.

## 12. Memory of the running game — verified

These addresses feed the live minimap of `web/public/index.html` (`minimap.js`,
`memscan.js`).

### 12.1 Access to the emulated RAM

Two methods were tried.

**1. Direct mode** (`workerThread: false`). DOSBox-X runs in the page, and we read
`ci.transport.module.HEAPU8` (an undocumented js-dos internal). This method was used
to search for the addresses. **Abandoned**: in game, on the user's Mac, it froze the tab
and slowed down the whole machine. In headless Chrome, no slowdown was measurable
(maximum event-loop delay: 8 ms).

**2. Chosen method: modified worker.** The emulator stays in its worker. We added to the
local copy `web/public/emulators/wdosbox-x.js` (the original is kept in
`wdosbox-x.orig.js`):

- `globalThis.__lolModule = Module`, in `updateMemoryViews`;
- a `BroadcastChannel("lol-mem")` that answers requests `{id, ranges:[[phys, length]…]}`
  with `{id, data:[Uint8Array…]}`.

The page exchanges only a few KB every 200 ms (`LoLMem.RemoteMemory`, `memscan.js`).
Must be redone if js-dos is updated.

Locating address 0 of the emulated PC in the WebAssembly heap:

- search for the `IBM COMPATIBLE` signature of the BIOS ROM, at physical address 0xFE00E;
- validation by `JMP FAR` (0xEA) at 0xFFFF0, and by 0x3F8 (COM1 port) at address 0x400.

The RAM is 16 MB (`memsize=16`).

### 12.2 Variables (physical addresses, FR CD version, project configuration)

| Address | Type | Content |
|---|---|---|
| `0x3E4E0` | u16 | party cell = `y*32 + x` (probable copy at `0x3B3DC`) |
| `0x3E4EF` | u16 | direction: 0 N, 1 E, 2 S, 3 W |
| `0x3E713` | 1024 × 10 bytes | live level grid. Bytes 0–3: N, E, S, W walls (`.CMZ` identifiers, changed when a door opens). Bytes 4–5 and 6–7: heads of the item and monster lists of the cell (`0x8000 + no.` = monster n). Byte 8: direction (5 by default, **deduced**). Byte 9: flags, 0 everywhere at the start of the game (probable location of the automap marks, **not verified**) |
| `0x3186F` | 30 × 46 bytes | monsters of the current level. Fields relative to x (`0x31871 + 46·n`): cell u16 at −2; x, y u16 = cell·256 + offset; destination x, y at +5; direction·2 at +9 and +16; monster number at +15; **direction at +17**; hit points u16 at +22; **type at +25** (just before the far pointer to its stats, +26); +13 is 1 for guards, meaning unknown. Empty entry = cell 0 |

| `0x3E4F6` | 48 × u16 | shared inventory bar: game item no. (0 = empty) |
| `0x3E558` | u16 | item held in hand (cursor). The page watches it: when it changes, the item's sheet opens and its "in hand" cell is selected as after a click (lock circled if it is a key); when it goes back to 0, that sheet closes. **Verified**: click on the Onguent in the game bar → "Onguent" sheet; put back → sheet closed |
| `0x31F79` | 400 × 16 bytes | game items: entry n starts with the item **type** (u16, index into the item table § 8.2); the rest is unknown (cell, level…) |
| `0x3389F` | 4 × 130 bytes | party sheets: name of character n at `0x3389F + 130·n` (flags 2 bytes before). Fields relative to the name (see below) |
| `0x2E7A2` | 8 × 130 bytes | template sheets of the recruitable characters: Michael, Timothy, Baccata, (?), Conrad, Paulson, Dawn, Kieran, Ak'shel |
| `0x3E6F0` | u16 | party's silver crowns (**verified**: after writing 141, a click on the coin pile shows "Vous avez 141 couronnes d'argent". The number drawn on the pile is only redrawn at the next transaction) |
| `0x8AA05` | 285 × 13 bytes | item type table (§ 8.2) |
| `0x5D6B5` | u8 | mode: 5 when exploring, 1 during the still image of a location (observed twice: entry, exit, new entry) |
| `0x39D5A` | u8 | **game paused** when bit 3 (`0x08`) is 0: 15 in game, 7 in the disk menu and on a character sheet (observed, see below) |
| `0x3E4E6` | u8 | displayed screen (bits, **deduced**): 0 in game, 4 in the disk menu, 12 on a character sheet |
| `0x387B0` | table, 19-byte entries | game timers (**deduced**): their u16 field at `0x387B0 + 19·n` advances by about 64 per second in game, and freezes when paused |

The addresses depend on where DOS loads `MAIN.EXE`. They are stable as long as the
bundle, the DOSBox configuration and the `autoexec` do not change.

**Monsters**: found by searching for the fine coordinates of the level 1 guards
(`x = 13·256 + 128`, `y = 18·256 + 128`…). The gap between two guards (46 bytes) gives the
size of an entry. The directions read (0, 4, 6, 6) match the script's starting
directions 0, 2, 3, 3, multiplied by 2. Dialogue NPCs are not map entities: only the
castle guards are "monsters".

**Monster sprite**: fixed after a brigand appeared as a boar in the 3D view. The type is
at +25, not at +13 (both are 1 for guards). Moreover, the same sprite slot can receive
several files depending on the story (level 2: ORC or THUG). To decide, the page searches
the first MB of RAM for a 32-byte excerpt of each possible file (bytes 400 to 431 of the
decompressed `.SHP`): only the loaded sprite is found (verified: `GUARD.SHP` at 0x7C7B2 on
level 1, `BOAR.SHP` and `THUG.SHP` absent). This search goes through a `find` command
added to the worker channel.

**Pause** (2026-11-09, automated test, sound muted): we compared copies of the first 640
KB of RAM, taken in game, in the disk menu, then in game again.
- The fields of the timer table (`0x387B0`, one entry every 19 bytes) advance in game and
  freeze in the menu. They also freeze on a character sheet.
- Among the bytes that change only during these screens, `0x39D5A` is 15 in game and 7 on
  both screens. It stays at 15 while moving (79 reads, 1 per 0.1 s, during 6 steps and
  turns). We read it as a "timers active" bit (**deduced**).
- `0x3E4E6` tells the two screens apart (4 and 12): it is rather the displayed screen.
- Not tested: dialogues, still image of a location, combat, in-game automap.
- Resting (Zzz) could not be tested: the game answers "Personne n'est fatigué".

**Explored cells**: no mark found. After a few steps, no grid byte changes, and the RAM
shows no table of seen cells.
**Hypothesis**: the in-game automap only fills once the map has been obtained in the
adventure. To be checked at that point, on byte 9 of each cell.

**Current level**: I found no variable. The minimap compares the live grid with the 29
original grids and keeps the level that has more than 900 identical cells out of 1024.

### 12.3 Search method (to find these addresses again)

- **Moving the party**: we click the arrows shown on screen, in headless Chrome driven
  through the DevTools protocol, sound muted (`--mute-audio`).
  `sendKeyEvent` and `simulateKeyPress` trigger a repeated identical key only once.
- **Search for known values** rather than variations: the starting view (after choosing
  Michael and the guard's dialogue) is cell 13,17 facing north, i.e. 557.
  One step forward gives 525.
- **Direction**: sequence N→E→S→E→N; a single address in the 16 MB follows 0,1,2,1,0.
- **Grid**: we search for 12 consecutive level 1 cells with a stride of 4 to 32 bytes;
  a single result (stride 10).

**Character sheet** (positions relative to the name). The field order is the one ScummVM
uses for Lands of Lore saves; it matches exactly (equipment at +78, and the displayed
sheet is recomputed). Little-endian, often at odd addresses.

| Position | Field |
|---|---|
| −2 | flags (1 = active) |
| +0 | name (11 bytes) |
| +11 | race / class / sex |
| +12 | identifier (s16) |
| +21 | item might bonuses, 8 × u16 (dagger = 10) |
| +37 | protection modifiers, 8 × u16 (256 = ×1) |
| +53 | item protection |
| +55 / +57 | current (s16) / maximum hit points |
| +59 / +61 | current (s16) / maximum magic points |
| +64 / +66 | damage taken / weapon hit |
| +68 / +70 | might / protection multipliers (÷256; 384 = ×1.5, 320 = ×1.25) |
| +72 / +74 | base might / protection |
| +78 | equipment, 11 × u16 (game item no.). Roles deduced from the item table masks (§ 8.2): 1 weapon, 2 shield, 3 weapon, 4 shield, 5 head, 6 body, 7 neck, 8 wrists, 9 feet, 10–11 rings |
| +100 to +102 | Warrior / Rogue / Mage levels |
| +103 to +105 | skill modifiers |
| +106 / +110 / +114 | experience of the three classes (u32; 1 at start, to be confirmed) |

**Story flags (verified 2026-11-08)**: script functions 0x07 (write) and 0x08 (read) use
an array of 16-bit words at `DS:0x804C` (`MAIN.EXE` code at `136a1`).
Flag n is bit (n & 15) of word n >> 4. The DS segment is deduced from the party cell:
`DS:0x7FD0` = cell (physical address 0x3E4E0) and `DS:0x7FDF` = direction (0x3E4EF). Hence
DS = 0x36510 and the array at **0x3E55C**. Check: at the start of the game, flag 110 is 1,
and it is one of those the level 1 script sets.

**Sprite choice depending on the story**: a level's `.INI` loads one sprite or another
into the same slot, depending on a flag (`testGameFlag(N) [== V] ; ifNotJmp ; 0x0B ; jmp ;
0x0B`). The export (`sprite_conditions`, field `spriteConds`) records these conditions, and
the page evaluates them with the flags in memory. Examples: level 2, flag 67 → ORC,
otherwise THUG; level 7, flag 64 = 1 → SCAVNGR, otherwise RATMAN; level 11, flag 86 = 0 →
SWAMPMON, otherwise HURZELL (the Trent); level 23, flag 577 = 1 → DRKCMNDR, otherwise NECROSAP.

**Item creation (verified 2026-11-08)**: in the item table, a free entry has its flags
word (+14) at 0x8000. A carried item has everything at 0, except the level (+11) at 0xFF and
the type (+12). To create an item, the page fills the first free entry this way, then writes
its number into the first empty cell of the bag. The game only redraws its bar on the next
scroll (arrows). Verified: the item then shows in the bar; picking it up and equipping it
has not been tested yet. Items with charges (wands) or contents (purse) are created with 0
in these fields.

**Monster state (verified 2026-11-08, by attacking a guard)**: in a monster's record
(46 bytes; positions from the x field), +12 is the current animation frame
(goes from 0 to 1 or 3 when the monster moves) and +13 the **mode**. The castle guards
stay in mode 1 (peaceful). After an attack, all four switch to mode 7 (walking towards
the party) or 8 (attacking), their destination (+5, +7) becomes the party cell, and byte
+24 goes from 1 to 0. Scripts also place enemies in mode 1 (ratmen, riders…): mode 1
means "not attacking for now", not "friendly". Script modes 2, 3, 4 and 12 remain to be
identified. The minimap colours monsters as follows: green = mode 1, red = modes 7 and 8,
orange = other.

**Experience and levels (`MAIN.EXE` code, verified 2026-11-08)**: the experience gain
routine (`a98f`) adds the points to the sheet (+0x6C + 4 × class from the start of the
sheet, i.e. +106 from the name), then calls the level check (`41190`) in a loop as long as
it returns 1. Writing experience into memory therefore does not raise the level: an in-game
gain is needed. The check compares experience with a table of 32-bit words at the start of
the data segment (physical address 0x30270): 0, 500, 1,500, 5,000, 25,000, 50,000, 80,000,
120,000, 180,000, 270,000, then 0x7FFFFFFF, hence level 10 at most. On a level-up, the
game:
- adds 1 to the level (+100 + class from the name) and the flag 0x200 << class in the
  character's state;
- grants the class bonuses, added to the current value and to the maximum. Warrior: HP
  + random(4 to 6). Rogue: HP + random(2 to 6). Mage: MP + (random(1 to 8) + 17) × factor
  / 256, the factor being word +0x0C of the structure pointed to by the far pointer at
  +0x11 from the name (256 for Michael), then HP + random(1 to 6);
- shows a message (texts 0x4023 to 0x4025) and plays sound 0x76.

The page's "+" buttons reproduce these effects, except the flag, the message and the
sound. Verified: Warrior 1 → 2 gives HP 20 → 24; Mage 1 → 2 gives MP 6 → 24.

**Items actually present (verified 2026-11-08)**: each entry of the item table is 16 bytes
and starts 12 bytes before the type (0x31F79 − 12 = 0x31F6D). Fields:
+0 next item in the same cell, +2 next to draw, +4 height, +5 cell, +7 x and +9 y
(cell × 256 + offset), +11 level, +12 type, +14 flags (0x4000 seen on an item on the floor).
In the live grid, bytes 4-5 of a cell give the first item on the floor; a value with bit
0x8000 designates a monster (in bytes 6-7). Check: an Onguent dropped in front of the party
appears in cell 525 (13,16), with x = 0x0D40 and y = 0x10C0, and bytes 4-5 of the cell are
1, its number. The level byte stays at 255, even for an item on the floor: so each cell's
list is what counts.

**Sheet size: 130 bytes — verified.** The character templates are spaced 0x82 bytes
apart. To check it on the party, we copied Kieran's template into the second slot
(`0x3389F + 130 − 2`):
- **Game reaction**: it immediately shows a second portrait (with Michael's face, the
  character's image not being loaded);
- **Panel and cheats**: the page reads and heals this character like the first one.

On a template, the computed Protection (1) differs from the one on the selection screen
(6). The multipliers are probably only recomputed by the game when the character actually
joins the party.

Computation of the displayed values, verified on the game's sheet:

- **Might** = (base might + Σ item bonuses) × multiplier ÷ 256, i.e.
  (5 + 10) × 1.5 = 22;
- **Protection** = (base protection + item protection) × multiplier ÷ 256,
  i.e. (2 + 6) × 1.25 = 10.

Removing the dagger takes the bonus at +23 from 10 to 0, and the displayed Might drops.

**Writing to RAM (cheats).** The worker channel also accepts
`{write:[[physical address, Uint8Array]…]}`. The page uses it for "infinite" HP and
magic: every 100 ms, the first character's current HP (+55) and MP (+59) are reset to
their maximum (+57, +61).
- **Verified**: HP written to 5 climbs back to 20 in under 0.5 s, and stays at 5 without
  the cheat.
- **Limit**: a hit that would take HP below zero between two writes would still be
  lethal. The game's bars are only redrawn on its own events.

**Inventory** (found by differencing). We pick up the potion from the bar, then put it
back. A single word goes from n to 0 and back to n (the bar cell, 0x3E4F6), and a single
one does the opposite, 0 then n then 0 (the item in hand, 0x3E558). The game's item table
is the one where items no. 1, 2 and 3 have the types Onguent, Aloès and Ginseng.
Nos. 4 to 6 there are Poignard, Chemise and Sandales, which matches Michael's sheet. The
sheets of characters 2 to 4 have not been located yet: a character would have to join the
party to measure the gap between two sheets.

### 12.4 Game keys (verified by screenshots)

- **Up / down arrows**: move forward / backward.
- **Left / right arrows and keypad 4 / 6**: turn.
- **Keypad 7 / 9**: sidestep (not rotation, contrary to my first hypothesis).
- **Other keys, from ScummVM's keymap** (`LoLEngine::initKeymaps`, "Lands of Lore - Keyboard"; read in the source, not tested in the DOS version):
  - **F1 / F2 / F3**: attack with character 1 / 2 / 3 (same as clicking the character's weapon, `clickedAttackButton`). The ZQSD mapping added by `scummvm.ini` does not touch them.
  - **1 / 2 / 3 added by the project** (2026-11-20), outside menus:
    - ScummVM: `scummvm.ini` maps them to the Attack 1-3 actions (`keymap_lolkeyb_AT1=F1 1`…). The game disables this keymap while a save name is typed (`gui_lol.cpp`), so digits can still be typed there. Verified: a brigand facing the party went from 32 to 22 HP after pressing 1.
    - DOSBox: the page sends F1-F3 (js-dos codes 290-292) for the top-row keys 1-3, even with ZQSD off, but not while the game is paused (byte 0x39D5A, bit 3 clear: disk menu, character sheet), as for ZQSD. Not tested in game.
  - **/**: select the next known spell (`gui_highlightSelectedSpell`); ignored while weapons are disabled or with a single spell known.
  - **M**: map (needs the atlas); **R**: rest; **O**: options menu.
  - **Space / Enter**: stop the current speech (`snd_stopSpeech`).
  - Movement: Up / Down = forward / backward, Left / Right = slide, Home / Page Up = turn left / right (ScummVM defaults; the original arrow and keypad keys above also work).

### 12.5 Saves — verified

- **Game saves**: the disk menu, then "Sauvegarder", writes
  `C:\LOLCD\_SAVEnnn.DAT` (82 KB for a game on level 1) with a description typed on the
  keyboard. The game also creates `_LEVELn.TMP`, the state of the visited levels.
- **Persistence by js-dos**: js-dos only keeps modified files (in browser storage, keyed
  by bundle URL) when its "save" floppy is clicked, or when leaving full screen or pointer
  lock with the `autoSave` option. The game page therefore calls `ci.persist(true)` every
  5 s, and clicks that button when the changes differ.
- **js-dos F6 / F7**: these keys call DOSBox-X's state save
  (`hand_savestate` / `hand_loadstate`).
  - **By default**, the state is kept in an in-memory slot: no file is created, and the
    state is lost on reload. Verified with unmodified js-dos: it was not a regression.
  - **Fix**: in the bundle's `.jsdos/dosbox.conf`, `[dosbox]` section, we add
    `savefile=QUICK.SAV`, `saveremark=false` and `forceloadstate=true`. DOSBox-X then
    writes the state to `QUICK.SAV`, about 1.2 MB, at the root of the disk. The page's
    automatic save keeps it, and F7 restores it after reload (verified).
  - **A single slot**: each F6 overwrites the previous one.
  - The bundle from before this change is kept in
    `web/archive/lands-cd-v2.avant-savefile.jsdos`.
- **js-dos cache**: js-dos 8.5.3 keeps a copy of the bundle in the browser's private
  storage (OPFS: `jsdos/caches/bundles/<url>`) and no longer re-downloads it, even if the
  file changes on the server. Disk changes (saves) are stored in
  `jsdos/saves/<url>.changes`.
  - **Clearing**: on every bundle change, we change `BUNDLE_VERSION` in
    `index.html`. The page then deletes the cached copy once, before starting js-dos.
  - **Emulator scripts**: `pathSuffix: "?v=" + BUNDLE_VERSION` forces them to reload
    too.

### 12.6 Right click — observed (automated test, 2026-11-07)

js-dos does pass the right button to the game. Behaviours seen while exploring on
level 1:

| Element | Right click | Left click (for comparison) |
|---|---|---|
| inventory item | picks the item up ("Onguent pris(e)"); swaps with the held item | — |
| 3D view, item in hand | throws the item in front of the party | — |
| movement arrow | moves the party | same |
| character portrait | nothing visible | opens the sheet (might, protection, equipment) |
| attack button (sword) | nothing visible (no enemy present) | not tested |

So right click is not a mere duplicate of left click. Its exact role (in combat, on
spells, on the in-game automap) remains **unknown**.

## Log

- **2026-11-07**:
  - extraction of the installers, PAK archives, CPS/LCW compression;
  - CMZ grids, WLL walls, XXX annotations;
  - EMC2 scripts (monster placement);
  - VCN/VMP/DAT/SHP graphics and palette;
  - 3D viewer;
  - perspective of the original view, floor and ceiling reconstructed seen from above;
  - memory of the running game (cell, direction, live grid), live minimap;
  - saves: F6/F7 made persistent (`savefile`), automatic persistence of game saves, F7
    button added to the page;
  - right click: first observations.
- **2026-11-08**: text compression, item table (in RAM), placed items and wall niches;
  inventory, item in hand and equipment of the first character in RAM; real-time
  monsters; structure of the live grid cells; per-cell scripts.
- **2026-11-08**: item table fields (slots, action, might, protection, value), healing
  script of `ITEM.INF`, roles of the 11 equipment slots; item sheet on click in the
  inventory and tooltip on minimap hover.
- **2026-11-08**: key locks (level scripts), shown on the minimap and in the key sheets.
- **2026-11-08**: items actually present (cell lists in the live grid), levers and
  clickable elements on the minimap, smooth transitions in the 3D view.
- **2026-11-08**: fragile walls (Hammer) of the Draracle caves, on the minimap.
- **2026-11-08**: magic effects of rings (`MAIN.EXE` code) and of usable items
  (`ITEM.INF`), nature of locks, monster animation in 3D.
- **2026-11-08**: level recognition on the significant cells only (the caves look alike:
  963 identical cells out of 1024 between levels 5 and 25); sprite choice for an ambiguous
  type (e.g. SCAVNGR or RATMAN on level 7, depending on story flag 64): we keep the
  candidate closest in memory to the level's certain sprites, since a stale copy from the
  previous level may remain.
- **2026-11-08**: experience thresholds and level-up (game code), per-class "+" buttons
  in the panel.
- **2026-11-08**: chests (symbol 210 of the game map, 4 states), shown on the minimap with
  their real state.
- **2026-11-08**: stairs (symbols 25 and 26), holes (11) and passages of function 0x3C,
  shown on the minimap; animated doors in the 3D view.
- **2026-11-08**: minimap illustrated with each location's textures, and real icon of
  items alone in their cell.
- **2026-11-08**: teleporters (symbol 17 and jumps of function 0x3C within the same level),
  shown on the minimap with their destination.
- **2026-11-08**: location illustration on hover (game image or 3D view capture).
- **2026-11-08**: 3D view of Yvel (tileset `YVEL1`) treated as an exterior.
  - Sky: average colour of each line of the original background above the horizon (line 47).
  - 3-storey facades: the storeys repeat the level's plain texture closest to the top of
    the face, without the base (12 lines), so as not to repeat doors and signs.
  - This rendering is our own choice and has not been compared with the game.
- **2026-11-08**: item sheet, comparison with the worn equipment.
  - `items.json` gains the numeric fields `might` and `prot` (`tools/item_info.py`, § 8.2).
  - For each character and each possible slot, the sheet gives the might and protection
    difference, as well as the effects gained or lost.
  - Weapons and shields are compared with the main hand only.
- **2026-11-08**: chest contents (function 0x49), 50 chests out of 54, shown on hover.
- **2026-11-08**: French level names (text 528 + n of LANDS.FRE).
- **2026-11-09**: hidden passages, § 6.0d.
  - False walls (opaque non-blocking faces, 18 on level 23) are tinted aqua green.
    Their passable sides are dotted.
  - Walls removed by a script (44 walls, `tools/hidden_walls.py`) have a dotted frame.
    The tooltip gives the mechanism, the expected item and the cell that closes the passage.
- **2026-11-09**: game pause detected, `0x39D5A` bit 3 and frozen timers (§ 12.2).
  - The page reads this byte every 250 ms. When paused, the ZQSD button is hidden and the
    ZQSD conversion is suspended until back in game, which allows typing those letters in
    a save name. Verified with the disk menu and a character sheet.
- **2026-11-09**: ScummVM sources retrieved, script functions cross-checked (§ 10a).
- **2026-11-09**: ScummVM web built and run separately (port 8001), up to character selection (§ 10a).
- **2026-11-10**: ScummVM web: keys received several times (duplicate SDL3 keyboard subscriptions) fixed in the launcher; minimap, 3D view and panel wired to the state published by the engine (§ 10a).
- **2026-11-10**: ScummVM web versioned in `web/scummvm` (origin in `VERSION.txt`, engine change on the local branch `lol-web`) (§ 10a).
- **2026-11-10**: ScummVM web: inventory management from the panel (commands executed by the engine: move, equip, delete, create) (§ 10a).
- **2026-11-10**: ScummVM web: exact monster sprites (names published by the engine); "go to level" command (§ 10a).
- **2026-11-10**: ScummVM web: infinite HP and magic applied by the engine (no lethal hit), crowns (§ 10a).
- **2026-11-10**: 3D view: monster colour variants and equipment (§ 10a).
- **2026-11-10**: ScummVM web: monster attack animations, game image in the 3D view (cutscenes, dialogues, locations), music paused in the menu; master volume (§ 10a).
- **2026-11-10**: 3D view: items on the floor (game images) (§ 10a).
- **2026-11-10**: 3D view: hit splashes on monsters; copy of the game image removed. Fix: a syntax error in the ScummVM page disabled infinite HP, the inventory and the crowns (§ 10a).
- **2026-11-13**: emulation engine selector (DOSBox / ScummVM) in both pages (§ 10a).
- **2026-11-13**: minimap: progressive exploration; condition of the in-game automap (`_flagsTable[31] & 0x10`, byte 9 of the cell) (§ 11).
- **2026-11-13**: ScummVM web: spells cast from the page, level-up by the engine (fix); item directory (§ 10a).
- **2026-11-13**: ScummVM web: unlocking the player's spells from the page (§ 10a).
- **2026-11-13**: ScummVM web: auto-attack mode (§ 10a).
- **2026-11-13**: ScummVM web: music, effects and voice volumes in the page (§ 10a).
- **2026-11-13**: ScummVM web: teleportation (minimap, locations, level selector) (§ 10a).
- **2026-11-13**: page: character sheets in a dialog (HP / MP summary in the panel).
- **2026-11-13**: ScummVM web: loading saves from the page (§ 10a).
- **2026-11-13**: full map in a dialog (Tab), with teleportation (§ 11).
- **2026-11-13**: ScummVM web: saving from the page (new save, overwrite) (§ 10a).
- **2026-11-13**: ScummVM web: game settings (subtitles, volumes) kept from one launch to the next (§ 10a).
- **2026-11-13**: ScummVM web: ending files (FRE/FINALE*.PAK) added, the end of the game no longer crashes (§ 10a).
- **2026-11-13**: ScummVM web: choice of the party's companions (§ 10a).
- **2026-11-13**: 3D view: health bar above monsters (ScummVM) (§ 10a).
- **2026-11-13**: "Triches" (Cheats) dialog: atlas, compass and spell unlocking (ScummVM) (§ 10a).
- **2026-11-13**: "Triches" dialog: spell book unlocking (flag 0x20) (§ 10a).
- **2026-11-13**: DOSBox page: the ZQSD button returns to the other buttons, bottom right (no more placement next to the game's arrows).
- **2026-11-13**: auto-attack: weapon or spell (max possible level) per character (ScummVM) (§ 10a).
- **2026-11-13**: inventory: "Vider" (Empty) button (ScummVM); each occupied bag cell is destroyed by command op 2 (`deleteItem`), with confirmation. Verified: 3 items destroyed, the equipment is kept.
- **2026-11-14**: 3D view: translucent monsters (TCABAL) rendered translucent; type flags published by the engine; LEVELnn.TLC tables decoded (§ 10a).
- **2026-11-14**: page: inventory and equipment in a dialog ("Gérer…" (Manage…) button or I key, enlarged; item sheet in the right column); the panel only keeps the number of occupied cells.
- **2026-11-14**: the "Triches" dialog becomes "Débloquer" (Unlock) ("Débloquer…" button).
- **2026-11-14**: locks (`tools/locks.py`): false positives fixed.
  - **The case**: the tree holes of the Forêt du Nord (level 2, cells 7,2 and 15,7) call
    subroutine 848. It tests the party's direction, then story flag 191 or 190, then checks
    that the hand is **empty**. A character then makes a remark, the game sets the flag and
    gives the item: Aloès (217) or Ginseng (218). The flag numbers coincided with those of
    the Jade and Spotted Keys.
  - **Corrected rule**: a subroutine is a lock only if it reads the item in hand (function
    0x53) **and** its type (0x12, `getItemPara`). Its body is read up to the next entry
    point, no longer up to the first return: a real lock first exits if the hand is empty,
    then compares the type.
  - **Effect**: 60 locks before, 68 after.
    - Removed: level 2 (the 2 tree holes), level 10 at 10,11 and level 22 at 24,11. These
      are cells that give an item.
    - Added, 12 locks the old reading missed, often in pairs of neighbouring cells (both
      sides of a door): level 23, Mystic and Blue Keys; level 26; level 27, Small Key;
      level 29, Blunt, Death and Oily Keys.
- **2026-11-14**: full map (Tab).
  - **Other levels**: the selector shows any level, drawn from its starting grid, without
    monsters, with its remembered exploration. Double-clicking a cell loads that level on
    the targeted cell (`goto` command). Verified: Forêt du Nord, cell 13,3.
  - **Options carried over** from the minimap and synchronized with it: illustrated cells,
    fog of war, forgetting the exploration of the displayed level. The legend is copied below the map.
  - **Removal**: teleportation leaves the minimap ("Aller à" line, double-click on the map
    and on locations); it remains only in the full map.
- **2026-11-14**: inventory dialog: empty equipment slots shown with the game's silhouette (`gui_drawCharInventoryItem`, `slotShapes` of the CD version: images 0x2E to 0x35 of GAMESHP.SHP — head 0x2E, body 0x2F, weapon 0x30, feet 0x31, neck 0x32, wrists 0x33, shield 0x34, ring 0x35), exported to `viewer/data/slot_shapes.png`.
- **2026-11-14**: 3D view: monster types loaded by scripts without a placed monster.
  - **The case**: the skeletons of the Haut du Bois d'Opin (level 17) are type 2, sprite
    MOLDER. The script loads `MOLDER.SHP` into slot 1 (function 0x0B) and associates type 2
    with that slot (function 0x3F). But no monster of this type is placed by a constant
    value: they appear some other way. The sprite was therefore not exported, and the 3D
    view could not draw them.
  - **Fix**: the export (`loaded_monster_types`) adds these types and their sprites to
    `monsterTypes` and to the sprite sheets.
  - **Effect**: extra types on levels 2, 3, 7, 10, 17, 23, 24 and 29.
  - **Verified** on level 17: the skeletons appear in 3D. Remaining gap: in the game, they
    carry different weapons (sword, axe), whereas in 3D both have the same one.
- **2026-11-15**: ScummVM web: "couldn't load file 'L20.PAK'" at startup via the portal (port 8920).
  - **Cause**: at startup, the game loads all the PAKs listed in `FILEDATA.FDT` (`Resource::loadFileList`).
    ScummVM's HTTP file system (`backends/fs/emscripten/http-fs.cpp`) then downloads almost all of them
    at the same time, without retrying. But the Python server accepts only 5 pending connections
    (`request_queue_size`). The following connections are lost; Caddy returns 502
    ("dial tcp :8000: i/o timeout" after 3 s) and the engine stops. The affected PAK varies from one run to the next.
  - **Fix**:
    - `tools/scummvm_web.py` accepts 256 pending connections;
    - the game page (`lol-game.html`) wraps `fetch` for files in `data/`: 15 s maximum per attempt,
      check of the announced size (`Content-Length`), up to 5 attempts.
  - **Verified**: 96 PAKs requested in parallel via the portal, 3 times in a row, all 200; the game starts without error.
- **2026-11-19**: full map (Tab): "↺ tous" (all) button.
  - It forgets the exploration of all levels for the page's engine: `localStorage` keys
    `minimapSeen:<moteur>:<niveau>`. The other engine's exploration and the other settings are kept.
  - Cells marked by the in-game automap on the current level (byte 9 & 7) reappear,
    since they are part of the game itself.
- **2026-11-19**: maps: "◐ jeu" (game) mode, synchronized with the in-game automap (zone `0x7F001000`, § 10a).
- **2026-11-20**: document translated into English and renamed from `docs/retro-conception.md` to `docs/reverse-engineering.md`. Section suffixes now use letters (§ 10a instead of § 10 bis). Quoted in-game text, French level names and the web page's UI labels stay in French.
- **2026-11-20**: game keys completed from ScummVM's keymap: F1-F3 attack with characters 1-3, `/` next spell, M/R/O (§ 12.4).
- **2026-11-20**: keys 1-3 attack with characters 1-3 (ScummVM keymap, DOSBox page), except in menus (§ 12.4).
- **2026-11-22**: floor of the background measured: its own projection (vanishing point y ≈ 39–42.5 in width, horizon y ≈ 24–34.5 in depth), 3.1 units per cell, and the mosaic pattern of KEEP and TOWER1 extracted by folding every visible repetition (`levelNN_floor_motif.png`). The other floors are not repeating patterns (§ 9.3c).
- **2026-11-22**: hypothesis of a checkerboard of two cells (`12121 / 21212`, mirrored or not) in the painted floors refuted; the background `.VMP` uses each floor tile once (§ 9.3c).
- **2026-11-22**: painted floors: only the near half cell is rectified (the far rows are dark or, in Yvel, hazy), laid as a checkerboard `1 2 / 2 1` with 2 = 1 mirrored (§ 9.3c).
- **2026-11-22**: 3D view: health bars only for monsters within 2.5 cells (§ 10a).
- **2026-11-22**: 3D view of the forest (tileset `FOREST1`: levels 2, 3, 10, 17, 24) treated as an exterior like Yvel: 3-storey trees and sky instead of a ceiling. The original background shows trees well above the view, at least two wall heights, under a dark sky; the former ceiling, projected from those treetops, made a tunnel.
- **2026-11-22**: wall pieces of the view (`_vmpOffsetsDefault`, rows and sizes) and the forest's treetops taken from the background band above the wall 3 cells ahead (§ 9.3d).
- **2026-11-22**: floor generation: Wang tiles from the near band of painted floors (16 tiles, minimum-error cuts, edges hashed from their coordinates, deterministic or random seed); paved floors keep their periodic pattern (§ 9.3e).
- **2026-11-22**: ceiling geometry measured on the background: longitudinal beams converging to y ≈ 39 like the floor, crossbeams one cell apart with `K = 145.3 / (55.15 − y)`, one coffer per cell, eye 0.43 cell above the floor and ceiling 0.25 above the eye. Ceilings rebuilt by folding (beamed tilesets) or near-cell rectification, and turned with the gaze in the 3D view (§ 9.3f).
- **2026-11-22**: Yvel's first floor: decorations drawn above the wall (y < 0), visible higher as the wall gets farther (8, 20, 27 px). Views 1–3 rescaled and stacked, the 2-cell view corrected for haze and the grey 3-cell view colored from it; drawn over the first storey in the 3D view (§ 9.3g).
