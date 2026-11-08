# Rétro-conception — Lands of Lore: The Throne of Chaos (version CD FR)

Journal des formats de fichiers décodés pour ce projet. Tout a été établi en lisant les
fichiers du jeu et en contrôlant visuellement les résultats. Rien ne vient d'une
documentation officielle.

- Source : `extracted-cd/app/C/LOLCD/`, extrait de `setup-00399-Lands_of_Lore_CD_FR-PCDOSBox.exe`.
- Outils : `tools/` (Python 3 sans dépendance ; les lancer avec `python3 -I`).

Niveau de confiance utilisé dans ce document :

- **Vérifié** : contrôlé sur les données (tailles qui tombent juste, rendu visuel cohérent).
- **Déduit** : cohérent avec les données, mais pas démontré.
- **Inconnu** : champ repéré, sens non établi.

Toutes les valeurs sont little-endian, sauf mention contraire.

---

## 1. Installateurs

Les deux `.exe` sont des installateurs **Inno Setup 6**. On les extrait avec
`innoextract -d <dossier> <setup.exe>`.

- Version disquette : `extracted/app/C/LandsOL/`.
- Version CD : `extracted-cd/app/C/LOLCD/`. Pas d'image ISO : tout est installé sur C:,
  et le jeu se lance avec `LANDS C:\LOLCD`.

## 2. Archives `.PAK` — vérifié

Outil : `tools/pak.py`.

```
répéter : u32 offset absolu des données, nom ASCII terminé par \0
fin     : offset 0, nom vide, ou position atteignant le premier offset
```

La taille d'une entrée se calcule par différence entre deux offsets consécutifs (la
dernière va jusqu'à la fin du fichier).

| Archive | Contenu |
|---|---|
| `Lnn.PAK` (01–29) | un niveau : `LEVELn.CMZ/.WLL/.INI/.INF/.XXX`, `LEVELnn.TLC`, textes `LEVELnn.ENG/FRE/GER`, sprites des monstres du niveau |
| `KEEP`, `FOREST1`, `MANOR`, `CAVE1`, `SWAMP`, `URBISH`, `MINE1`, `TOWER1`, `YVEL`, `CATWALK`, `RUIN`, `CIMMERIA` `.PAK` | décors : `.VCN`, `.VMP`, `.DAT`, `.SHP`, porte `*DOOR.SHP` / `CAVE1DR.SHP`, palettes `.PAL` |
| `STARTUP.PAK` | textes généraux `LANDS.ENG/FRE/GER`, `ITEM.INF`, polices, icônes d'objets |
| `GENERAL.PAK` | interface, dont `PLAYFLD.CPS` (palette de base) |
| `MONSTER.PAK` | sprites de monstres partagés (`LIZARD`, `CABAL`…) |

## 3. Compression — vérifié

Outil : `tools/wwcomp.py`.

### 3.1 Conteneur CPS

Utilisé par `.CMZ`, `.VCN`, `.VMP`, la plupart des `.SHP` et les images `.CPS`.

```
u16 taille du fichier - 2
u16 type de compression : 0 = aucune, 4 = LCW
u32 taille décompressée
u16 taille de palette (0 ou 768)
[palette : 768 octets, VGA 6 bits]
données
```

Repère : un `.SHP` est compressé quand son mot à l'offset 2 vaut 4.

### 3.2 LCW (« format 80 » de Westwood), copies absolues

| Commande | Effet |
|---|---|
| `0ccc pppp pppppppp` | copier `c+3` octets depuis `sortie[-p]` |
| `10nnnnnn` | `n` octets littéraux ; `0x80` = fin |
| `11nnnnnn pppp` | copier `n+3` octets depuis `sortie[p]` (absolu) |
| `FE nnnn vv` | remplir `n` octets avec `v` |
| `FF nnnn pppp` | copier `n` octets depuis `sortie[p]` |

## 4. Textes — vérifié

Fichiers `LANDS.FRE` (dans `STARTUP.PAK`) et `LEVELnn.FRE` :

- une table de `u16` d'offsets, dont le nombre vaut le premier offset divisé par 2 ;
- puis des chaînes terminées par `\0`, encodées en **CP850** et **compressées** :
  - un octet ≥ 0x80 code deux lettres fréquentes : `T1[c>>3] + T2[c]` avec `c = octet & 0x7F`,
    `T1 = " etainosrlhcdupm"` et une table `T2` de 128 caractères ;
  - `0x1B` suivi de `c` code le caractère CP850 `c + 0x7F` (é, è, à, ô…).

  Décodeur : `tools/pak.py`, fonctions `decode_text` et `read_strings`. Les majuscules
  (« FONTAINE ») passent sans compression, ce qui explique que les premières annotations
  étaient lisibles sans décodage.

Dans les scripts et les fichiers `.XXX`, un numéro de texte `0x4000 + i` désigne
l'entrée `i` de `LANDS.xxx`.

## 5. Grille d'un niveau — `LEVELn.CMZ` (CPS) — vérifié

```
u16 largeur (32), u16 hauteur (32), u16 octets par case (4 ; 9 au niveau 24)
largeur*hauteur cases ; octets 0..3 = id de mur des faces Nord, Est, Sud, Ouest
```

- Case `(x, y)` = index `y*32 + x`, avec `x` vers l'est et `y` vers le sud.
- Une case pleine porte le même id sur ses 4 faces ; une case vide porte l'id 0.
- **Inconnu** : les 5 octets supplémentaires du niveau 24.

## 6. Types de murs — `LEVELn.WLL` — vérifié (sens des champs : déduit)

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

- Les portes vont par séries d'ids consécutifs (par exemple 3–7 et 8–12 au château),
  avec des drapeaux qui varient : probablement les étapes d'ouverture (**déduit**).
- **Murs empruntés** : les niveaux 2 et 3 utilisent chacun des ids définis seulement dans
  le `.WLL` de l'autre, et le niveau 21 un id du niveau 20. L'extracteur reprend la
  définition dans un niveau du même décor.

## 7. Annotations de carte — `LEVELn.XXX` — vérifié

```
entrées de 12 octets : u16 x, u16 y, u16 icône, u16 x2, u16 y2, u16 n° de texte
```

- Le texte est dans `LANDS.FRE` (par exemple « FONTAINE », « SALLE DU TRONE »).
- La valeur `0xFFFF` marque un emplacement vide.
- **Inconnu** : le sens exact de `icône` et de `x2/y2` (souvent la case voisine, peut-être
  la case d'accès).

## 8. Scripts — `LEVELn.INI` / `LEVELn.INF` (EMC2) — vérifié pour ce qui est utilisé

Outil : `tools/emc.py`. Fichier IFF `FORM` / `EMC2` contenant trois chunks (tailles
big-endian) :

- `ORDR` : points d'entrée ;
- `TEXT` : table d'offsets `u16` big-endian, puis chaînes ;
- `DATA` : mots `u16` **big-endian**.

Décodage d'un mot d'instruction :

```
bit 15          saut, cible = mot & 0x7FFF
bit 14          paramètre = octet bas signé
bit 13          paramètre = mot suivant
opcode          (mot >> 8) & 0x1F
```

| Opcodes | Rôle |
|---|---|
| 3, 4 | empiler une constante |
| 7 | empiler le paramètre `n` du sous-programme |
| 12 | dépiler `n` (après un appel = nombre d'arguments) |
| 14 | appel d'une fonction du moteur (n° = paramètre & 0xFF) |
| 2 (param 1), puis 0 | appel d'un sous-programme |

Les arguments d'une fonction du moteur sont empilés du dernier au premier.

Fonctions du moteur identifiées :

| N° | Rôle | Arguments | Confiance |
|---|---|---|---|
| `0x38` | placer un monstre | case, dx, dy (0–255, 128 = centre), direction (0 N, 1 E, 2 S, 3 O), type, ?, mode, équipement ×0–4 | vérifié : 0 monstre dans un mur sur 28 niveaux |
| `0x0B` | charger un sprite de monstre | texte (fichier .SHP), emplacement, anim | déduit |
| `0x3F` | caractéristiques d'un type de monstre | type, emplacement de sprite, puis 40 valeurs | déduit (valeurs non décodées) |
| `0x11` | placer un objet | type d'objet, image, drapeaux, **niveau**, case, dx, dy (0–255), hauteur | vérifié (niveau = celui du script sauf 1 cas ; noms cohérents) |

- `.INI` est exécuté au chargement du niveau (monstres présents dès le départ).
- `.INF` contient les événements (monstres qui apparaissent sur un déclencheur).
- Plusieurs `0x0B` sur le même emplacement correspondent à des branches conditionnelles :
  le sprite dépend de l'avancement de l'histoire (par exemple ORC/THUG au niveau 2).
- **Anomalie** : le `.INI` du niveau 25 est une copie de celui du niveau 23 ; ses
  monstres tombent dans des murs. C'est probablement un niveau inutilisé.
- Le premier texte de `TEXT` qui n'est pas un `.PAL` donne le nom du décor (`KEEP`,
  `FOREST1`…). Un `.PAL` cité est une palette alternative.

### 8.1 Objets placés — vérifié

- **Total** : 223 objets placés par les scripts. 197 sont posés au chargement (`.INI`),
  27 apparaissent sur un événement (`.INF`).
- **Niveau visé** : l'argument « niveau » vaut celui du script, sauf au niveau 24, qui
  pose un objet (type 198) au niveau 29. L'extracteur ne reporte pas encore cet objet.
- **Objets dans les murs** : 51 objets sont placés dans un bloc de mur, avec un décalage
  de 0 ou 255 sur un axe et une hauteur de 8. Ce sont des objets rangés dans des **niches
  murales** ; c'est ce qui tient lieu de coffre dans ce jeu, où aucun autre contenant n'a
  été trouvé. Le décalage indique la face (0 = Ouest/Nord, 255 = Est/Sud), donc la case
  depuis laquelle on voit la niche. Souvent, le mur porte une décoration de type spécial 6
  avec le drapeau 0x87 (**déduit** : niche).
- **Scripts par case** : dans `LEVELn.INF`, la table `ORDR` a 1 027 entrées, et l'entrée
  n < 1024 est le point d'entrée du script de la case n (`0xFFFF` = aucun). Au niveau 1,
  45 cases ont un script, dont la fontaine (13,13) et les seuils des portes. C'est là
  que se trouvent les interactions (entrer dans une case, cliquer sur un mur, poser un
  objet…). Le type d'événement est un paramètre du script, encore à décoder.
- **Images des lieux** : la fonction `0x29` (n° de texte d'un `.CPS`, page) charge l'image
  fixe d'un lieu (auberge, échoppe, salle du trône…). Elle est appelée dans le script de
  la case devant l'entrée, qui est le second point (x2, y2) de l'annotation. Au niveau 1 :
  `NATHNIAL.CPS` en 16,14 (herboristerie), `VICTOR.CPS` en 16,12, `GERIM.CPS` en 10,13,
  `CONFRONT.CPS` en 17,8.
  - **Format** : l'image est une planche de 320×200 avec sa propre palette. Le décor
    occupe le coin 176×120, au format de la vue ; le reste contient les images
    d'animation du personnage.
  - **Couverture** : 14 cases au total sur les 29 niveaux. D'autres lieux (Yvel, niveau 22)
    sont chargés autrement, ce qui reste à trouver.
  - **En mémoire** : `NATHNIAL.CPS` se retrouvait entier en RAM, en 0x4D5C0, mais ce
    tampon ne change pas à l'entrée dans la scène. Il ne permet donc pas de détecter le
    mode.
- **Niveau 1** : aucun objet placé par script. L'équipement de départ vient
  d'ailleurs (inconnu).

### 8.2 Table des objets — vérifié (en RAM)

- **Emplacement** : en RAM à l'adresse physique 0x8AA05 (version CD FR). Elle compte 285
  entrées de 13 octets, et son index est le type d'objet utilisé par la fonction `0x11`.
- **Contenu d'une entrée** : octets 0–1 = numéro de texte du nom (0x4000 + index dans
  `LANDS.FRE`) ; octet 2 = numéro d'**icône** dans `ITEMICN.SHP` (`STARTUP.PAK`,
  138 icônes de 20×20, palette de l'interface) ; le reste est inconnu.
  - **Vérification de l'octet 2** : Onguent = 30, Ginseng = 42, Aloès = 43 donnent bien la
    potion, la feuille et l'herbe affichées dans la barre du jeu. La page du jeu s'en sert
    pour l'aperçu graphique de l'inventaire.
- **Contrôle** : l'entrée 0 vaut « Objet illégal ».
- **Pas dans les exécutables** : la table n'apparaît telle quelle ni dans `LANDS.EXE` ni
  dans `MAIN.EXE`. Elle est extraite d'un vidage de la RAM par
  `tools/item_table_from_ram.py`, et le résultat est versionné dans
  `tools/data/items_fr.json`.
- **Nom douteux** : le type 267, « Essaim », revient souvent dans les forêts. Son sens
  reste à vérifier en jeu.

## 9. Graphismes des décors — vérifié

Outil : `tools/lolgfx.py`.

### 9.1 `.VCN` (CPS) : tuiles 8×8 en 16 couleurs

```
u16 n (nombre de tuiles)
n   octets : décalage de sous-palette par tuile (multiple de 16)
128 octets : table de couleurs (8 sous-palettes x 16 index)
384 octets : couleurs 0–127 de la palette (VGA 6 bits)
32n octets : pixels 4 bits, 2 pixels par octet, poids fort à gauche
```

Couleur d'un pixel = `table[décalage[tuile] + quartet]`.

### 9.2 `.VMP` (CPS) : assemblages de tuiles

```
u16 nombre d'entrées, puis entrées u16 :
  bits 0–13 = n° de tuile (0 = vide)
  bit 14    = miroir horizontal
  bit 15    = couleur 0 transparente (superposition)
```

Organisation :

- entrées 0–329 : fond de la vue, 22×15 tuiles (176×120 pixels) ;
- puis un jeu de 431 entrées par type de mur (champ `vmp` du `.WLL`).
  `nombre = 330 + 431 × jeux` pour les 12 décors.
- **Dans un jeu de 431** : les 192 dernières entrées (16×12 tuiles = 128×96 pixels) forment
  le **mur proche vu de face**. Les entrées précédentes sont les vues de côté et les vues
  lointaines, rangées par largeurs de 3, 6, 10… tuiles (découpage exact non relevé).
- Les tuiles vides d'un jeu de mur sont transparentes : ouverture de porte, arche, bas de
  la dernière rangée (sol).

### 9.3 Palette — vérifié

- Couleurs 128–255 : palette de `PLAYFLD.CPS` (`GENERAL.PAK`).
- Couleurs 0–127 : `.VCN` du décor, ou les 384 premiers octets du `.PAL` cité par le
  script du niveau.
- Valeurs VGA 6 bits, à convertir en 8 bits par `v*4 + v/16`.

### 9.3 bis Perspective de la vue d'origine — déduit, cohérent avec les mesures

La vue fait 176×120 pixels. Le mur proche de face (128×96) est placé en haut de la vue,
centré : ses pixels opaques vont des lignes 0 à environ 94 (mesuré sur KEEP et TOWER1).
On en déduit :

- **Focale** : 64 pixels par unité, puisqu'une case fait 128 pixels de large vue à 0,5 case
  (le joueur est au centre de sa case).
- **Horizon** : y≈47 ; centre horizontal : x=88.
- **Hauteur de l'œil** : environ 0,367 case. Un mur fait environ 0,73 case de haut,
  l'œil est à mi-hauteur.
- **Correspondance sol** : un point du sol à la distance `z` devant, décalé de `x` sur le
  côté, apparaît en `(88 + 64·x/z, 47 + 23,5/z)`. Pour le plafond, `47 − 23,5/z`.
- **Pénombre** : le fond d'origine est peint avec une pénombre qui augmente avec la distance
  (bande noire autour de l'horizon).

Le visualiseur reconstitue ainsi une texture de sol et une texture de plafond vues de
dessus (64×64, une case), par projection inverse d'une case de profondeur :

- sol : de 0,34 à 1,34 case ;
- plafond : de 0,5 à 1,5 case ;
- la pénombre est compensée ligne par ligne ;
- la texture est retournée en miroir une case sur deux, en écho au fond d'origine que le
  jeu retourne à chaque pas (**déduit**).

Le résultat est une approximation : le fond d'origine est une image peinte, pas le rendu
exact d'un sol répétitif, d'où des raccords visibles.

**Échelle des distances du moteur d'origine — mesurée.** Ce n'est pas une perspective : un
mur de face mesure 128, environ 80 puis environ 48 px à 0,5, 1,5 et 2,5 cases. Ce sont
les morceaux de 16, 10 et 6 tuiles du `.VMP`, et les décorations des positions 1 à 3
du `.DAT` diminuent dans les mêmes proportions (×0,65). La taille diminue donc d'environ
×0,615 par case, au lieu de 1/distance : au loin, le décor paraît environ deux fois plus
grand qu'en perspective réelle.
- **Imitation** : la vue intégrée propose un mode « perspective du jeu », avec une
  distance apparente `deff(z) = 0,5 · (1/0,615)^(z − 0,5)` au-delà de 0,5 case. Les
  rayons y deviennent des courbes, que le rendu suit par pas de 0,02 case. Les murs, le
  sol, le plafond et les monstres utilisent la même échelle.
- **Bascule** : un bouton de la page du jeu passe d'un mode à l'autre.

**Vue 3D intégrée sous le jeu.** Elle reprend cette perspective : champ horizontal
`2·atan(1,375)` ≈ 108°, image 352×240 (format 176×120). Elle reçoit aussi la grille
vivante (§ 12.2), donc l'état réel des portes. Pour que ces identifiants aient une
texture, l'export produit une texture pour tous les types de mur du niveau.

### 9.4 Décorations — `.DAT` — vérifié pour la vue de face

```
u16 n ; puis n entrées de 72 octets :
  u16 forme[10]   n° d'image dans le .SHP du décor (0xFFFF = aucune), une par position de vue
  u8  échelle[10]
  s16 x[10], s16 y[10]   position de l'image
  s8  suivante    décoration chaînée (dessinée en plus)
  u8  drapeaux    bit 0 : motif symétrique (voir ci-dessous)
```

**Drapeau bit 0 — vérifié.** Seule la moitié gauche du motif est stockée. Il faut aussi
dessiner l'image retournée horizontalement, en miroir par rapport au centre du mur, en
`x' = 128 − x − largeur`. Sans cela, les blasons et bannières du château apparaissent
coupés en deux. Au château, cela concerne les décorations 6 à 9, 16 et 18.

Position 1 = mur proche de face, avec `x/y` relatifs au mur de 128×96 (**vérifié**
visuellement : bannières, blasons, portraits, fontaine). Les positions 2–3 sont plus
lointaines, et les positions 4–5 sont vraisemblablement les vues de côté (**déduit**).

### 9.5 Sprites — `.SHP` (souvent dans un conteneur CPS) — vérifié

```
u16 n ; u32 offsets[n+1] (relatifs à l'octet 2 ; 0 = image absente)
image :
  u16 drapeaux, u8 hauteur, u16 largeur, u8 hauteur, u16 taille, u16 taille décompressée
  si drapeaux & 1 : table de couleurs (taille = u8 qui suit si drapeaux & 4, sinon 16)
  données : LCW (sauf si drapeaux & 2), puis RLE : 0, n = n pixels transparents
  pixel = table[octet] si table, sinon index de palette
```

Monstres : les images vont par groupes de 4. Les images 0–3 sont de face (marche), 4–7
de profil, 8–11 de dos, 12–15 l'attaque (**vérifié** sur `GUARD.SHP`). L'autre profil
s'obtient en miroir.

Le battant de porte (`*DOOR.SHP`, 1 image) se loge dans la zone transparente du jeu de
mur « encadrement » (centré, aligné en bas de l'ouverture).

## 10. Non décodé à ce jour

- `.TLC` (5376 octets par niveau), `.INF` au-delà des placements de monstres, `ITEM.INF`.
- Caractéristiques des monstres (`0x3F`), objets au sol (`0x11`), téléporteurs et escaliers.
- Découpage des vues de côté et lointaines du `.VMP` (inutile pour le visualiseur libre).
- `.TIM`, `.WSA` (animations), sons.

## 11. Outils et sorties

| Outil | Rôle | Sortie |
|---|---|---|
| `tools/extract_maps.py` | grilles, murs, annotations, monstres | `maps/levelNN.json/.png`, `maps/levels.json`, `maps/raw/` |
| `tools/export_viewer.py` | textures de face, fond, sprites | `web/public/viewer/data/` |
| `web/public/viewer/` | visualiseur 3D libre (lancer de rayons maison) | http://localhost:8000/viewer/ |
| `web/public/minimap.js`, `memscan.js` | mini-carte en direct à côté du jeu | http://localhost:8000/ |

## 12. Mémoire du jeu en cours d'exécution — vérifié

Ces adresses servent à la mini-carte en direct de `web/public/index.html` (`minimap.js`,
`memscan.js`).

### 12.1 Accès à la RAM émulée

Deux méthodes ont été essayées.

**1. Mode direct** (`workerThread: false`). DOSBox-X tourne dans la page, et on lit
`ci.transport.module.HEAPU8` (partie interne de js-dos, non documentée). Cette méthode a
servi à la recherche des adresses. **Abandonnée** : en jeu, sur le Mac de l'utilisateur,
elle gelait l'onglet et ralentissait toute la machine. En Chrome sans fenêtre, aucun
ralentissement n'était mesurable (retard maximal de la boucle d'événements : 8 ms).

**2. Méthode retenue : worker modifié.** L'émulateur reste dans son worker. On a ajouté à
la copie locale `web/public/emulators/wdosbox-x.js` (l'original est conservé dans
`wdosbox-x.orig.js`) :

- `globalThis.__lolModule = Module`, dans `updateMemoryViews` ;
- un `BroadcastChannel("lol-mem")` qui répond aux demandes `{id, ranges:[[phys, longueur]…]}`
  par `{id, data:[Uint8Array…]}`.

La page n'échange que quelques Ko toutes les 200 ms (`LoLMem.RemoteMemory`, `memscan.js`).
À refaire si on met à jour js-dos.

Repérage de l'adresse 0 du PC émulé dans le tas WebAssembly :

- recherche de la signature `IBM COMPATIBLE` de la ROM BIOS, à l'adresse physique 0xFE00E ;
- validation par `JMP FAR` (0xEA) à 0xFFFF0, et par 0x3F8 (port de COM1) à l'adresse 0x400.

La RAM fait 16 Mo (`memsize=16`).

### 12.2 Variables (adresses physiques, version CD FR, configuration du projet)

| Adresse | Type | Contenu |
|---|---|---|
| `0x3E4E0` | u16 | case du groupe = `y*32 + x` (copie probable en `0x3B3DC`) |
| `0x3E4EF` | u16 | direction : 0 N, 1 E, 2 S, 3 O |
| `0x3E713` | 1024 × 10 octets | grille vivante du niveau. Octets 0–3 : murs N, E, S, O (identifiants de `.CMZ`, modifiés quand une porte s'ouvre). Octets 4–5 et 6–7 : têtes de listes des objets et monstres de la case (`0x8000 + n°` = monstre n). Octet 8 : direction (5 par défaut, **déduit**). Octet 9 : drapeaux, à 0 partout en début de partie (emplacement probable des marques de l'automap, **non vérifié**) |
| `0x3186F` | 30 × 46 octets | monstres du niveau courant. Champs relatifs à x (`0x31871 + 46·n`) : case u16 à −2 ; x, y u16 = case·256 + décalage ; destination x, y à +5 ; direction·2 à +9 et +16 ; numéro du monstre à +15 ; **direction à +17** ; points de vie u16 à +22 ; **type à +25** (juste avant le pointeur far vers ses caractéristiques, +26) ; +13 vaut 1 pour les gardes, sens inconnu. Entrée vide = case 0 |

| `0x3E4F6` | 48 × u16 | barre d'inventaire commune : n° d'objet du jeu (0 = vide) |
| `0x3E558` | u16 | objet tenu en main (curseur) |
| `0x31F79` | 400 × 16 octets | objets du jeu : l'entrée n commence par le **type** d'objet (u16, index de la table des objets § 8.2) ; le reste est inconnu (case, niveau…) |
| `0x3389F` | fiche de personnage | premier personnage, champs relatifs au nom (voir ci-dessous) |
| `0x3E6F0` | u16 | couronnes d'argent du groupe (**vérifié** : après écriture de 141, un clic sur le tas de pièces affiche « Vous avez 141 couronnes d'argent ». Le chiffre dessiné sur le tas n'est redessiné qu'à la transaction suivante) |
| `0x8AA05` | 285 × 13 octets | table des types d'objets (§ 8.2) |
| `0x5D6B5` | u8 | mode : 5 en exploration, 1 pendant l'image fixe d'un lieu (observé deux fois : entrée, sortie, nouvelle entrée) |

Les adresses dépendent de l'endroit où DOS charge `MAIN.EXE`. Elles sont stables tant que
le bundle, la configuration DOSBox et l'`autoexec` ne changent pas.

**Monstres** : trouvés en cherchant les coordonnées fines des gardes du niveau 1
(`x = 13·256 + 128`, `y = 18·256 + 128`…). L'écart entre deux gardes (46 octets) donne la
taille d'une entrée. Les directions lues (0, 4, 6, 6) correspondent aux directions de
départ 0, 2, 3, 3 du script, multipliées par 2. Les PNJ des dialogues ne sont pas des
entités de la carte : seuls les gardes du château sont des « monstres ».

**Sprite d'un monstre** : correction faite après qu'un brigand est apparu en sanglier
dans la vue 3D. Le type est à +25, et non à +13 (les deux valent 1 pour les gardes).
De plus, un même emplacement de sprite peut recevoir plusieurs fichiers selon
l'histoire (niveau 2 : ORC ou THUG). Pour trancher, la page cherche dans le premier Mo
de RAM un extrait de 32 octets de chaque fichier possible (octets 400 à 431 du `.SHP`
décompressé) : seul le sprite chargé s'y trouve (vérifié : `GUARD.SHP` en 0x7C7B2 au
niveau 1, `BOAR.SHP` et `THUG.SHP` absents). Cette recherche passe par une commande
`find` ajoutée au canal du worker.

**Cases explorées** : aucune marque trouvée. Après quelques pas, aucun octet de la grille
ne change, et la RAM ne laisse pas apparaître de tableau des cases vues.
**Hypothèse** : la carte automatique ne se remplit qu'une fois la carte obtenue dans
l'aventure. À vérifier à ce moment-là, sur l'octet 9 de chaque case.

**Niveau courant** : je n'ai pas trouvé de variable. La mini-carte compare la grille
vivante aux 29 grilles d'origine et retient le niveau qui a plus de 900 cases sur 1024
identiques.

### 12.3 Méthode de recherche (pour retrouver ces adresses)

- **Faire bouger le groupe** : on clique sur les flèches affichées à l'écran, dans Chrome
  sans fenêtre piloté par le protocole DevTools, son coupé (`--mute-audio`).
  `sendKeyEvent` et `simulateKeyPress` ne déclenchent qu'une fois une même touche répétée.
- **Chercher des valeurs connues** plutôt que des variations : la vue de départ (après
  le choix de Michael et le dialogue du garde) est la case 13,17 face au nord, soit 557.
  Un pas en avant donne 525.
- **Direction** : séquence N→E→S→E→N ; une seule adresse dans les 16 Mo suit 0,1,2,1,0.
- **Grille** : on cherche 12 cases consécutives du niveau 1 avec un pas de 4 à 32 octets ;
  un seul résultat (pas de 10).

**Fiche de personnage** (positions relatives au nom). L'ordre des champs est celui que
ScummVM utilise pour les sauvegardes de Lands of Lore ; il colle exactement (équipement à
+78, et la fiche affichée se recalcule). En petit-boutiste, souvent à des adresses impaires.

| Position | Champ |
|---|---|
| −2 | drapeaux (1 = actif) |
| +0 | nom (11 octets) |
| +11 | race / classe / sexe |
| +12 | identifiant (s16) |
| +21 | bonus de force des objets, 8 × u16 (poignard = 10) |
| +37 | modificateurs de protection, 8 × u16 (256 = ×1) |
| +53 | protection des objets |
| +55 / +57 | vie actuelle (s16) / maximale |
| +59 / +61 | magie actuelle (s16) / maximale |
| +64 / +66 | dégâts subis / coup d'arme |
| +68 / +70 | multiplicateurs de force / protection (÷256 ; 384 = ×1,5, 320 = ×1,25) |
| +72 / +74 | force / protection de base |
| +78 | équipement, 11 × u16 (n° d'objet du jeu) |
| +100 à +102 | niveaux Guerrier / Voleur / Mage |
| +103 à +105 | modificateurs de compétence |
| +106 / +110 / +114 | expérience des trois classes (u32 ; vaut 1 au départ, à confirmer) |

Calcul des valeurs affichées, vérifié sur la fiche du jeu :

- **Force** = (force de base + Σ bonus des objets) × multiplicateur ÷ 256, soit
  (5 + 10) × 1,5 = 22 ;
- **Protection** = (protection de base + protection des objets) × multiplicateur ÷ 256,
  soit (2 + 6) × 1,25 = 10.

Retirer le poignard fait passer le bonus de +23 de 10 à 0, et la Force affichée baisse.

**Écriture en RAM (triches).** Le canal du worker accepte aussi
`{write:[[adresse physique, Uint8Array]…]}`. La page s'en sert pour une vie et une magie
« infinies » : toutes les 100 ms, la vie (+55) et la magie (+59) actuelles du premier
personnage sont remises à leur maximum (+57, +61).
- **Vérifié** : une vie écrite à 5 remonte à 20 en moins de 0,5 s, et reste à 5 sans la
  triche.
- **Limite** : un coup qui ferait passer la vie sous zéro entre deux écritures resterait
  mortel. Les barres du jeu ne se redessinent qu'à ses propres événements.

**Inventaire** (trouvé par différences). On prend la potion de la barre en main, puis on
la repose. Un seul mot passe de n à 0 puis revient à n (la case de la barre, 0x3E4F6), et
un seul fait l'inverse, 0 puis n puis 0 (l'objet en main, 0x3E558). La table des objets
du jeu est celle où les objets n° 1, 2 et 3 ont pour types Onguent, Aloès et Ginseng.
Les n° 4 à 6 y valent Poignard, Chemise et Sandales, ce qui correspond à la fiche de
Michael. Les fiches des personnages 2 à 4 n'ont pas encore été localisées : il faudrait
qu'un personnage rejoigne le groupe pour mesurer l'écart entre deux fiches.

### 12.4 Touches du jeu (vérifiées par captures)

- **Flèches haut / bas** : avancer / reculer.
- **Flèches gauche / droite et pavé 4 / 6** : tourner.
- **Pavé 7 / 9** : pas de côté (et non rotation, contrairement à ma première hypothèse).

### 12.5 Sauvegardes — vérifié

- **Sauvegardes du jeu** : le menu disquette, puis « Sauvegarder », écrit
  `C:\LOLCD\_SAVEnnn.DAT` (82 Ko pour une partie au niveau 1) avec une description saisie
  au clavier. Le jeu crée aussi `_LEVELn.TMP`, l'état des niveaux visités.
- **Conservation par js-dos** : js-dos ne garde les fichiers modifiés (dans le stockage du
  navigateur, par adresse du bundle) qu'au clic sur sa disquette « save », ou en quittant
  le plein écran ou le verrouillage du pointeur avec l'option `autoSave`. La page du jeu
  appelle donc `ci.persist(true)` toutes les 5 s, et clique sur ce bouton quand les
  changements diffèrent.
- **F6 / F7 de js-dos** : ces touches appellent la sauvegarde d'état de DOSBox-X
  (`hand_savestate` / `hand_loadstate`).
  - **Par défaut**, l'état est gardé dans un emplacement en mémoire : aucun fichier n'est
    créé, et l'état est perdu au rechargement. Vérifié avec js-dos non modifié : ce n'était
    pas une régression.
  - **Correctif** : dans le `.jsdos/dosbox.conf` du bundle, section `[dosbox]`, on ajoute
    `savefile=QUICK.SAV`, `saveremark=false` et `forceloadstate=true`. DOSBox-X écrit
    alors l'état dans `QUICK.SAV`, environ 1,2 Mo, à la racine du disque. La sauvegarde
    automatique de la page le conserve, et F7 le restaure après rechargement (vérifié).
  - **Un seul emplacement** : chaque F6 écrase le précédent.
  - Le bundle d'avant ce changement est conservé dans
    `web/archive/lands-cd-v2.avant-savefile.jsdos`.
- **Cache de js-dos** : js-dos 8.5.3 garde une copie du bundle dans le stockage privé du
  navigateur (OPFS : `jsdos/caches/bundles/<url>`) et ne le retélécharge plus, même si le
  fichier change sur le serveur. Les changements du disque (sauvegardes) sont rangés dans
  `jsdos/saves/<url>.changes`.
  - **Vidage** : à chaque modification du bundle, on change `BUNDLE_VERSION` dans
    `index.html`. La page efface alors une fois la copie en cache, avant de lancer js-dos.
  - **Scripts de l'émulateur** : `pathSuffix: "?v=" + BUNDLE_VERSION` les force à se
    recharger aussi.

### 12.6 Clic droit — observé (test automatisé, 2026-11-07)

js-dos transmet bien le bouton droit au jeu. Comportements constatés en exploration au
niveau 1 :

| Élément | Clic droit | Clic gauche (pour comparer) |
|---|---|---|
| objet de l'inventaire | prend l'objet en main (« Onguent pris(e) ») ; échange avec l'objet tenu | — |
| vue 3D, objet en main | lance l'objet devant le groupe | — |
| flèche de déplacement | déplace le groupe | idem |
| portrait du personnage | rien de visible | ouvre la fiche (force, protection, équipement) |
| bouton d'attaque (épée) | rien de visible (aucun ennemi présent) | non testé |

Le clic droit n'est donc pas un simple double du clic gauche. Son rôle exact (au combat,
sur les sorts, sur la carte automatique) reste **inconnu**.

## Journal

- **2026-11-07** :
  - extraction des installateurs, archives PAK, compression CPS/LCW ;
  - grilles CMZ, murs WLL, annotations XXX ;
  - scripts EMC2 (placement des monstres) ;
  - graphismes VCN/VMP/DAT/SHP et palette ;
  - visualiseur 3D ;
  - perspective de la vue d'origine, sol et plafond reconstitués vus de dessus ;
  - mémoire du jeu en cours (case, direction, grille vivante), mini-carte en direct ;
  - sauvegardes : F6/F7 rendus persistants (`savefile`), conservation automatique des
    sauvegardes du jeu, bouton F7 ajouté à la page ;
  - clic droit : premiers constats.
- **2026-11-08** : compression des textes, table des objets (en RAM), objets placés et
  niches murales ; inventaire, objet en main et équipement du premier personnage en RAM ;
  monstres en temps réel ; structure des cases de la grille vivante ; scripts par case.
