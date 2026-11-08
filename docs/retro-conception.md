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

### 6.0 bis Portes — étapes d'ouverture (vérifié 2026-11-08)

Une porte est une série de types de mur consécutifs : le premier est fermé (bloquant, avec
une texture ouverte), le dernier ouvert (non bloquant). Par exemple, au niveau 1 : 3, 4, 5,
6, puis 7 ouvert. Le jeu fait passer la face d'un type au suivant pendant l'ouverture. Les
textures exportées des étapes intermédiaires montrent toutes la porte fermée : le jeu
déplace le panneau lui-même. La vue 3D isole le panneau (pixels différents entre la texture
fermée et la texture ouverte, d'où sa hauteur dans l'encadrement), puis le fait monter ou
descendre de façon continue vers l'ouverture visée. Celle-ci vaut (type − premier) /
(dernier − premier), d'après la grille vivante. Toutes les portes sont animées en
glissement vertical : le sens réel d'ouverture de chaque décor n'a pas été vérifié.

### 6.0 ter Escaliers, trous et passages (2026-11-08)

- **Escaliers** : types de mur posés au sol (drapeaux 4) dont le symbole de carte vaut 25 ou
  26. Les positions se répondent d'un niveau à l'autre. Au niveau 7, le symbole 26 est en
  15,6, 15,15 et 28,3 ; au niveau 8, le symbole 25 est aux mêmes cases. Au niveau 6, le 26
  est en 22,3, et au niveau 7, le 25 aussi. D'où **25 = escalier qui monte**, **26 =
  escalier qui descend** (**déduit** de ces correspondances). Le changement de niveau est fait
  par le moteur, pas par les scripts : les escaliers n'apparaissent pas dans les appels de la
  fonction 0x3C.
- **Trous et trappes** : symbole 11 au sol. Les scripts font tomber le groupe au niveau
  inférieur, à la même position (niveau 20, case 15,15 → niveau 18, case 495 = 15,15).
- **Passages scriptés** : la fonction **0x3C** (niveau, case, direction) change de niveau. Ce
  sont les sorties du château et de la forêt, les entrées des cavernes et les chutes. L'export
  les relève avec leur case de déclenchement (champ `exits`, `level_exits`).

### 6.0 quater Téléporteurs — déduit, concordance vérifiée (2026-11-08)

Le symbole **17** du champ `automap` marque les téléporteurs. Le type de mur est posé au sol,
sans texture (invisible). On le trouve en 20,1 au niveau 15, sur 4 cases au niveau 16 (la
mine), et aux niveaux 19, 23, 25 et 26.

Le saut est fait par la fonction de script **0x3C** (niveau, case, direction), le plus souvent
dans un sous-programme du niveau qui reçoit ces valeurs en paramètres (`pushBPAdd n` = n-ième
valeur empilée par l'appelant, n = 1 pour la dernière). Juste avant, ce sous-programme teste
« niveau demandé = niveau courant » pour jouer l'effet du téléporteur (fonction 0x39). Par
exemple, au niveau 16 :
- 13,4 → 4,9 (même niveau) ;
- 14,5 → niveau 12, case 22,7 ;
- 15,6 → 14,6 ;
- 14,7 → niveau 14, case 12,10.

`level_exits` suit maintenant ces sous-programmes et marque `teleport` les sauts dans le même
niveau. Treize sauts de ce genre sont trouvés, y compris sur des cases sans le symbole 17
(niveaux 11, 12, 19 et 27). Pour 4 cases au symbole 17 (niveau 23 : 2,11, 3,16 et 20,16 ;
niveau 26 : 20,19 et 18,23), la destination n'est pas résolue.

Trois fausses pistes écartées :
- les cases au symbole **10** du niveau 14 sont des dalles à pression : le type 35 devient 36,
  avec le son 80 ;
- la fonction **0x60** (valeur, case) joue un son sur une case ;
- la fonction **0x31** (case, ±1 ou 0) change l'état d'une porte.

### 6.0 quinquies Passages cachés — déduit (2026-11-09)

Les passages cachés sont de deux sortes : les faux murs et les murs effacés par un script.

**Faux murs.** Ce sont des faces dont la texture est opaque, donc dessinée comme un mur
plein, mais dont le bit 0 des drapeaux vaut 0 : la face ne bloque pas le passage. Les escaliers
(symboles 25 et 26) sont exclus.
- La case reste un mur sur ses autres côtés : on la traverse seulement par les côtés faux.
- Au niveau 23 (Passerelle 1), le type 36 (drapeaux 132, symbole de carte 214) a la texture
  de roche ordinaire. Il est posé sur 18 cases du labyrinthe central, par exemple 10,14, que
  l'on traverse du nord au sud.
- Le symbole 214 marque ces faces dans la plupart des niveaux : 7, 8, 10, 13 à 16, 20, 21,
  23, 27 et 29. Il en existe d'autres : 63 (niveaux 2, 3 et 17), 22 (niveau 26) et 192 (niveau
  24). La page ne s'appuie donc pas sur le symbole : elle se fonde sur l'opacité et le bit 0.

**Murs effacés par un script** (`tools/hidden_walls.py`, champ `secrets` des niveaux).
- Un script appelle `setWall` (0x00) avec la face -1 (les quatre faces) et le type 0 (vide)
  sur une case qui est un mur dans la carte d'origine.
- La condition est cherchée juste avant l'appel : `getItemParam(objet, 4)` (0x12, paramètre
  4 = type) puis « push type ; eval == ».
- L'objet vient de la fonction 0x53 (objet en main) ou d'un registre du script. Dans ce cas
  il s'agit probablement d'un objet posé sur la case (déduit).
- D'autres appels remettent un mur plein sur la même case : le passage se referme.
- Au niveau 23, le mécanisme des cases 9,25, 4,30 et 5,29 efface les murs 9,26, 4,31 et 6,29
  quand on tient le Gantelet des Ténèbres (254). Passer en 8,26, 3,31 ou 6,28 les remet.
  - Le mécanisme de la case 16,24 (type 38, special 6) attend la Statuette (255). Il vide la
    case 20,26, qui est déjà un faux mur.
- 44 murs trouvés sur 16 niveaux.
- Certains murs s'ouvrent depuis leur propre case (niveau 14 par exemple). Ce sont peut-être
  des murs à frapper ou à cliquer. La page ne marque pas ceux qui sont déjà connus comme murs
  fragiles (§ 9).

### 6.1 Coffres — vérifié visuellement (2026-11-08)

Le champ `automap` d'un type de mur choisit le symbole de la carte du jeu. La valeur
**210** marque les coffres : tous les décors de coffre repérés sur les planches de décors ont
cette valeur (cavernes, marais, mines, Urbish, manoir, Yvel, tours, Cimmeria…). Chaque décor
définit 4 types consécutifs, qui sont les états d'un coffre : **fermé**, **ouvert**, ouvert
(couvercle levé, sans doute vide) et **cassé**. Par exemple, aux niveaux 7 à 9 : 53, 70, 72
et 73. Il y a 64 faces de coffre sur 21 niveaux. Le script change le type quand on ouvre ou
casse un coffre (« Un coffre ouvert. », « Le coffre est endommagé. »). La grille vivante
donne donc l'état réel. La page affiche les coffres et leur état sur la mini-carte ; les
objets posés sur une case de coffre sont indiqués « dans un coffre ».

**Contenu des coffres** (`tools/chests.py`, champ `chestItems` des niveaux ; déduit de la
lecture des scripts, non vérifié en ouvrant un coffre) :
- **Serrure** : le script de la case du coffre appelle un sous-programme générique du niveau
  (au niveau 7 : 625). Ses paramètres sont la case, la face, puis la clé demandée (-1 = aucune).
  Le sous-programme compare l'objet en main (`0x53`, `0x12` paramètre 4) à la clé et au Jeu
  de clefs (245), puis change le type du mur (états du § 6.1).
- **Contenu** : s'il réussit, le script appelle la fonction **`0x49`** (type, valeur, 0),
  une fois par objet. La valeur semble être un nombre de pièces (Bourse) ou de charges (Coupe
  Bezel, baguettes, Collier de Jade).
- **Objets fragiles** : le script teste `getWall(992, 3) == -2`, sans doute « coffre cassé ».
  Si c'est le cas, il donne un **Verre cassé** (247) à la place de la fiole ou de la coupe
  qui suit.
- **Résultat** : en remontant les sous-programmes jusqu'aux cases qui les appellent, on trouve
  le contenu de **50 coffres sur 54**. Il manque : niveau 4, coffres 15,30, 24,30 et 25,30 ;
  niveau 17, coffre 25,17.
- **Coffre à plusieurs faces** : un coffre comme 9,8 au niveau 7 regroupe les objets de ses
  deux faces.
- La mini-carte donne ce contenu au survol du coffre ; si le coffre est ouvert, c'est le
  contenu d'origine.

## 7. Annotations de carte — `LEVELn.XXX` — vérifié

```
entrées de 12 octets : u16 x, u16 y, u16 icône, u16 x2, u16 y2, u16 n° de texte
```

- Le texte est dans `LANDS.FRE` (par exemple « FONTAINE », « SALLE DU TRONE »).
- La valeur `0xFFFF` marque un emplacement vide.
- **Inconnu** : le sens exact de `icône` et de `x2/y2` (souvent la case voisine, peut-être
  la case d'accès).
- **Illustration des lieux** (mini-carte, au survol d'un lieu ou de sa ligne dans la liste).
  La page cherche d'abord une image du jeu (fonction `0x29`, § 8) sur la case `x2/y2`, sur la
  case du lieu ou sur une case voisine de `x2/y2`. Au niveau 1, on obtient : Armurerie →
  VICTOR, Herboristerie → NATHNIAL, Bureau de Geron → GERIM, Salle du trône → CONFRONT.
  Sinon, la vue 3D fait une capture prise depuis `x2/y2`, tournée vers `x/y` (message
  `lol-snap`, rendu synchrone puis retour à la position du groupe). Exemple : la Fontaine,
  vue depuis 13,14 vers le nord, est bien face à la fontaine, ce qui conforte l'idée que
  `x2/y2` est la case d'accès. La capture n'est possible que pour le niveau affiché par la vue
  3D.

### 7 bis Noms français des niveaux — déduit, concordance vérifiée (2026-11-08)

Dans `LANDS.FRE` (`STARTUP.PAK`), le texte **528 + n** donne le nom du niveau n. Juste avant,
les textes 526 à 528 sont « Mur Secret », « Plaque pivotante » et « Téléporteur ».

| n | nom | n | nom | n | nom |
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

La concordance tient sur tout le tableau :
- les décors correspondent : `CAVE1` pour les Cavernes 6 à 9, `MINE1` pour les Mines 13 à 16,
  `TOWER1` pour les Tours 18 à 21, `CIMMERIA` pour le Château, `YVEL1` pour la Cité d'Yvel ;
- les annotations de carte aussi : « SALLE DES COCONS » au niveau 7, « PORTES D'YVEL » au
  niveau 22.

Il reste à savoir à quoi le jeu sert de cette liste (sans doute les sauvegardes ou la carte) :
**non vérifié**. Les noms sont exportés dans `levels.json` (`frName`), et la mini-carte et la
vue 3D les affichent.

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
- **Serrures** (`tools/locks.py`) : quand on clique sur un mur, le jeu exécute le script
  de la case. Une serrure lit l'objet en main (fonction `0x53`), prend son type (`0x12`,
  paramètre 4) et le compare au type d'une clé. Exemple vérifié au niveau 8, case 17,2 :
  objet en main → si c'est le « Jeu de clefs » (245), message ; si c'est la « Clef usée »
  (169), ouverture. Deux formes : comparaison directe (« push <clé> ; eval == ») ou appel
  d'un sous-programme du niveau qui lit l'objet en main, avec la clé en argument
  (**probable** : l'argument n'est pas suivi jusqu'à la comparaison). Les clés sont les
  types d'objets qui ont le drapeau 0x0100. Résultat : 37 clés sur 45 localisées, presque
  toutes sur des murs décorés, souvent à côté d'une porte. Aucune serrure n'est trouvée
  pour la Clef de Roland, des Brigands, de bronze, de la mine 3, la Clef usée (186), la Clef
  Bleue, la Clef de la Mort et la Clef Emoussée : utilisation par un autre mécanisme, ou
  clés non utilisées. Les nombres 7 et 8 de ces scripts sont des drapeaux d'histoire
  (`0x07` = écrire, `0x08` = lire, **déduit**) dont les numéros recoupent parfois ceux des
  clés.
- **Interrupteurs** : le champ `special` d'un type de mur (`.WLL`, § 6) dit ce qui se passe
  au clic. Correspondance reprise de ScummVM (**non vérifiée en jeu**) : 1 = décor
  cliquable, 2 et 3 = levier dans l'une ou l'autre position, 4 = script seul, 5 = porte,
  6 = niche. Comptage : niveau 8, 7 faces de levier ; niveau 16, 7 ; niveau 1, aucun levier
  mais 32 faces de type 1, toutes sur des cases à script. La mini-carte affiche les leviers
  et, quand la case a un script, les éléments de type 1 ou 4. L'état d'un levier se lit dans
  la grille vivante, puisque l'identifiant du mur change quand on l'actionne.
- **Nature des serrures** (`tools/locks.py`, `lock_kind`) : d'après ce que fait le script de
  la case. Si le script crée un objet (fonctions `0x11`, `0x10`, `0x0F`), la serrure **donne
  un objet**. S'il supprime un mur (`0x00`, face -1, type 0), elle **ouvre un passage**. S'il
  change le décor de sa propre face, c'est un **réceptacle** : la clé reste insérée (les
  Clefs Mystiques des tours). S'il cite la case d'une porte, ou si une porte touche la
  case, c'est une **serrure de porte**. Bilan : 24 portes, 6 passages, 13 réceptacles,
  2 « donne un objet », 15 indéterminées. Le jeu n'a pas de coffre fermé à clé : les deux
  cas « donne un objet » sont des lieux (l'Echoppe de Sadie au niveau 22, une scène au
  niveau 10), et les coffres cités dans les textes (« Un coffre cassé ») sont des décors.
- **Murs fragiles** (`tools/fragile.py`) : au niveau 6, en marchant en 8,7 puis en 11,13,
  on lit « Ce mur me semble assez fragile » puis « Ce mur est également branlant ». Les
  murs juste au sud (8,8 et 11,14) se cassent en les frappant avec le **Marteau**
  (objet 59). Le script du niveau compte les coups dans une variable (fonctions `0x2d`
  lire et `0x2e` écrire, **déduit**). Au premier coup, il change l'apparence du mur
  (fonction `0x00` : case, face, type) ; au coup suivant, il appelle un sous-programme
  qui supprime le mur (`0x00` avec face -1 et type 0). Au niveau 9, la case 20,13 réagit à
  l'événement 0x400, celui de l'attaque, avec le Marteau, et casse le mur 20,14. Murs
  trouvés : niveau 6 en 8,8 et 11,14 ; niveau 9 en 22,8 et 20,14 (Marteau) ; niveau 15 en
  6,1 (Pioche). Les « pierres branlantes » du niveau 9 (23,15) s'ouvrent par un simple
  clic (événement 0x40).
- **Événements des scripts de case** (registre 0, **déduit**) : 0x40 = clic sur le mur,
  0x400 = attaque sur la case ; les autres valeurs rencontrées (0x01, 0x02, 0x04, 0x08,
  0x10, 0x80, 0x100, 0x200, 0x4000) restent à identifier. Messages du niveau :
  fonction `0x5e` (type, 0, n° de texte du `.FRE` du niveau).
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
  138 icônes de 20×20, palette de l'interface) ; les octets suivants sont décrits
  ci-dessous.
- **Champs 3–12** (lecture faite par `tools/item_info.py`, qui produit les fiches de la page) :

  | Octets | Champ | Statut |
  |---|---|---|
  | 3–4 | drapeaux (0x0100 sur toutes les clés, 0x0002 sur les objets métalliques ?) | inconnu |
  | 5–6 | emplacements d'équipement autorisés, un bit par emplacement (voir § 12.2) | **vérifié** sur Michael |
  | 7 | action quand on utilise l'objet = point d'entrée de `ITEM.INF` (0xFF = aucune) | déduit + script lu pour 4 |
  | 8 | force de l'arme ; sinon 1er paramètre de l'action | **vérifié** (Poignard = 10) |
  | 9 | 2e paramètre (force des armes à distance, max du soin…) | déduit |
  | 10 | protection | **vérifié** (Chemise 5 + Sandales 1) |
  | 11–12 | valeur (Onguent 20, Poignard Incrusté 3000) : probablement le prix | supposé |

  **Vérification** (2026-11-08) : avec Poignard en emplacement 1, Chemise en 6 et Sandales
  en 9, la fiche de Michael contient `itemsMight[1] = 10` et `itemProtection = 6`.
- **Actions (octet 7)** :

  | Valeur | Objets | Paramètres |
  |---|---|---|
  | 0x00 | armes de corps à corps | octet 8 = force |
  | 0x01 | armures, anneau d'Ambre | — |
  | 0x02 / 0x19 | flèches, carreaux, pierres, os (0x19 = empoisonné) | octet 8 = dégâts |
  | 0x04 | Onguent, Aloès, Ginseng | soin aléatoire entre octet 8 et octet 9 |
  | 0x0B | arcs, arbalètes, étoiles | octet 8 = type de munition, octet 9 = force |
  | 0x0C | messages, Mandat du Roi | octets 8–9 = n° de texte (0x4000 + index `LANDS.FRE`) |
  | 0x0E | parchemins de sort | octet 8 = n° de sort |
  | 0x14 | baguettes, Bâton d'ébène | octet 8 = n° de sort |
  | 0xFF | clés, joyaux, figurines | aucune action |

  Numéros de sort, d'après les noms des parchemins : 2 Gel, 3 Boules de feu, 4 Poing
  mortel, 5 Brume fatale, 6 Foudre, 7 Vortex ; le 9 (Bâton d'ébène) reste inconnu.
- **Effets passifs des anneaux** (code de `MAIN.EXE`, désassemblé avec Capstone). Le jeu
  appelle une fonction « objet équipé ? » (`0a21:0997`, arguments : personnage, type
  d'objet) :
  - **Anneau Bezel (225)** : la fonction qui applique un état (arguments : personnage, état,
    chance sur 100) ignore l'état 0x80, le poison, si l'anneau est porté. C'est donc une
    immunité au poison ;
  - **Anneau Talba (227)** et **Anneau Duble (228)** : dans la boucle de régénération (les
    4 personnages, fiches de 0x82 octets), la magie (+0x3D, maximum +0x3F depuis le début de
    la fiche) remonte de maximum/10 au lieu de 1 avec Talba. La vie remonte de 4 au lieu de 1
    avec Duble. Une zone qui draine la magie (octet 0x7FDE) retire maximum/32 à la place ;
  - **Anneau de Nuage (229)** : dans le calcul des dégâts subis, les dégâts de type 4 sont
    divisés par 4. Le type 4 est celui de la Boule de Glace dans `ITEM.INF`, donc du froid
    (**déduit**) ;
  - **Anneau de Zéphyr (230)** : après une attaque, le personnage reçoit l'état 0x04
    (récupération) pour 4 + hasard(8) cycles ; avec l'anneau, cette durée est divisée par 2 ;
  - **Anneau d'Ambre (226)** : +5 en protection, par la table des objets.
  La même routine d'attaque lance le script de la case visée avec l'événement 0x400, ce qui
  confirme que 0x400 correspond à l'attaque.
- **Objets à utiliser** (entrées de `ITEM.INF`, lues dans le script) : 0x08 Flasque d'huile =
  remplit la lanterne ; 0x09 Bourse = pièces d'argent ; 0x0F Gobelet d'argent = soin de 255
  contre 1 point de magie ; 0x12 Coupe Bezel = vie au maximum, utilisations comptées dans
  l'objet ; 0x15 Cube de Vaelan : le 263 (chargé) rend 25 points de magie puis devient le
  264 (vide) ; 0x1C Gantelet des Ténèbres = sort Poing mortel ; 0x18 = sort de l'octet 8 ;
  0x1E As de l'Infini et Réserve de Bannon = magie au maximum, usage unique ; 0x20 Fioles =
  « Beurk ! », puis Flasque vide. Fonctions du moteur déduites : `0x14` écrire une valeur
  de la fiche du personnage, `0x0C` supprimer l'objet en main, `0x49` donner un objet,
  `0x2F`/`0x30` lire et écrire une variable globale (huile de la lanterne = variable 9).
- **Script des soins** (`ITEM.INF`, point d'entrée 4, lu en désassemblant) : l'objet ne sert
  que si la vie n'est pas au maximum, ou si le personnage est empoisonné (bit 0x80 de son
  état) et que l'objet est le Ginseng (type 218). Le script tire un nombre au hasard entre
  les deux paramètres et soigne d'autant. Avec le Ginseng, il retire aussi le poison
  (message 0x4056 « Les effets du poison se dissipent… »). L'Onguent (216) joue un son de
  plus. Fonctions du script : `0x12` = paramètre d'objet, `0x13` = valeur de la fiche du
  personnage, `0x03` = tirage au hasard, `0x61` = soin (**déduit**).
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
- Caractéristiques des monstres (`0x3F`), objets au sol (`0x11`). Pour les escaliers et les
  téléporteurs, voir § 6.0 ter et § 6.0 quater.
- Découpage des vues de côté et lointaines du `.VMP` (inutile pour le visualiseur libre).
- `.TIM`, `.WSA` (animations), sons.

## 11. Outils et sorties

| Outil | Rôle | Sortie |
|---|---|---|
| `tools/extract_maps.py` | grilles, murs, annotations, monstres | `maps/levelNN.json/.png`, `maps/levels.json`, `maps/raw/` |
| `tools/export_viewer.py` | textures de face, fond, sprites | `web/public/viewer/data/` |
| `web/public/viewer/` | visualiseur 3D libre (lancer de rayons maison) | http://localhost:8000/viewer/ |
| `web/public/minimap.js`, `memscan.js` | mini-carte en direct à côté du jeu | http://localhost:8000/ |

**Rendu illustré de la mini-carte** (bouton ▦, réglage mémorisé). Les cases reprennent les
graphismes du lieu exportés pour la vue 3D :
- **sol** : moitié basse de `levelNN_floor.png`, c'est-à-dire les dalles vues de près ;
- **murs** : la face opaque la plus fréquente du niveau (`walls[id].tex`), recadrée au centre
  et assombrie ;
- **portes fermées** : leur propre face, avec un liseré de couleur.

Une case qui ne contient qu'un seul type d'objet montre l'icône de cet objet
(`ITEMICN.SHP`, octet 2 de la table des objets), encadrée en crème. Les autres cases
gardent l'icône de leur catégorie, encadrée en cyan.

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
| `0x3E558` | u16 | objet tenu en main (curseur). La page le surveille : quand il change, la fiche de l'objet s'ouvre et sa case « en main » est sélectionnée comme après un clic (serrure entourée si c'est une clé) ; quand il revient à 0, cette fiche se ferme. **Vérifié** : clic sur l'Onguent de la barre du jeu → fiche « Onguent » ; reposé → fiche fermée |
| `0x31F79` | 400 × 16 octets | objets du jeu : l'entrée n commence par le **type** d'objet (u16, index de la table des objets § 8.2) ; le reste est inconnu (case, niveau…) |
| `0x3389F` | 4 × 130 octets | fiches du groupe : nom du personnage n en `0x3389F + 130·n` (drapeaux 2 octets avant). Champs relatifs au nom (voir ci-dessous) |
| `0x2E7A2` | 8 × 130 octets | fiches modèles des personnages recrutables : Michael, Timothy, Baccata, (?), Conrad, Paulson, Dawn, Kieran, Ak'shel |
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
| +78 | équipement, 11 × u16 (n° d'objet du jeu). Rôles déduits des masques de la table des objets (§ 8.2) : 1 arme, 2 bouclier, 3 arme, 4 bouclier, 5 tête, 6 corps, 7 cou, 8 poignets, 9 pieds, 10–11 anneaux |
| +100 à +102 | niveaux Guerrier / Voleur / Mage |
| +103 à +105 | modificateurs de compétence |
| +106 / +110 / +114 | expérience des trois classes (u32 ; vaut 1 au départ, à confirmer) |

**Drapeaux d'histoire (vérifié 2026-11-08)** : les fonctions de script 0x07 (écrire) et 0x08
(lire) utilisent un tableau de mots de 16 bits en `DS:0x804C` (code `MAIN.EXE` en `136a1`).
Le drapeau n est le bit (n & 15) du mot n >> 4. Le segment DS se déduit de la case du groupe :
`DS:0x7FD0` = case (adresse physique 0x3E4E0) et `DS:0x7FDF` = direction (0x3E4EF). D'où
DS = 0x36510 et le tableau en **0x3E55C**. Contrôle : au début du jeu, le drapeau 110 est à 1,
et c'est l'un de ceux que le script du niveau 1 active.

**Choix des sprites selon l'histoire** : le `.INI` d'un niveau charge un sprite ou un autre
dans le même emplacement, selon un drapeau (`testGameFlag(N) [== V] ; ifNotJmp ; 0x0B ; jmp ;
0x0B`). L'export (`sprite_conditions`, champ `spriteConds`) relève ces conditions, et la page
les évalue avec les drapeaux en mémoire. Exemples : niveau 2, drapeau 67 → ORC, sinon THUG ;
niveau 7, drapeau 64 = 1 → SCAVNGR, sinon RATMAN ; niveau 11, drapeau 86 = 0 → SWAMPMON,
sinon HURZELL (le Trent) ; niveau 23, drapeau 577 = 1 → DRKCMNDR, sinon NECROSAP.

**Création d'objets (vérifié 2026-11-08)** : dans la table des objets, une entrée libre a
son mot de drapeaux (+14) à 0x8000. Un objet porté a tout à 0, sauf le niveau (+11) à 0xFF et
le type (+12). Pour créer un objet, la page remplit la première entrée libre ainsi, puis écrit
son numéro dans la première case vide du sac. Le jeu ne redessine sa barre qu'au prochain
défilement (flèches). Vérifié : l'objet s'affiche alors dans la barre ; le prendre et
l'équiper n'a pas encore été testé. Les objets à charges (baguettes) ou à contenu (bourse) sont créés avec 0 dans ces
champs.

**État des monstres (vérifié 2026-11-08, en attaquant un garde)** : dans la fiche d'un
monstre (46 octets ; positions depuis le champ x), +12 est l'image d'animation en cours
(passe de 0 à 1 ou 3 quand le monstre bouge) et +13 le **mode**. Les gardes du château
restent en mode 1 (paisible). Après une attaque, les quatre passent en mode 7 (marche vers
le groupe) ou 8 (attaque), leur destination (+5, +7) devient la case du groupe, et l'octet
+24 passe de 1 à 0. Les scripts placent aussi des ennemis en mode 1 (hommes-rats,
cavaliers…) : le mode 1 veut dire « n'attaque pas pour l'instant », pas « amical ». Les
modes 2, 3, 4 et 12 des scripts restent à identifier. La mini-carte colore les monstres
ainsi : vert = mode 1, rouge = modes 7 et 8, orange = autre.

**Expérience et niveaux (code de `MAIN.EXE`, vérifié 2026-11-08)** : la routine de gain
d'expérience (`a98f`) ajoute les points à la fiche (+0x6C + 4 × classe depuis le début de la
fiche, soit +106 depuis le nom), puis appelle en boucle la vérification de niveau (`41190`)
tant qu'elle renvoie 1. Écrire l'expérience en mémoire ne fait donc pas monter de niveau : il
faut un gain en jeu. La vérification compare l'expérience à une table de mots de 32 bits
placée au début du segment de données (adresse physique 0x30270) : 0, 500, 1 500, 5 000,
25 000, 50 000, 80 000, 120 000, 180 000, 270 000, puis 0x7FFFFFFF, d'où un niveau 10 au
plus. Lors d'une montée de niveau, le jeu :
- ajoute 1 au niveau (+100 + classe depuis le nom) et le drapeau 0x200 << classe dans
  l'état du personnage ;
- donne les bonus de la classe, ajoutés à la valeur actuelle et au maximum. Guerrier : vie
  + hasard(4 à 6). Voleur : vie + hasard(2 à 6). Mage : magie + (hasard(1 à 8) + 17) × facteur
  / 256, le facteur étant le mot +0x0C de la structure pointée par le pointeur lointain en
  +0x11 depuis le nom (256 pour Michael), puis vie + hasard(1 à 6) ;
- affiche un message (textes 0x4023 à 0x4025) et joue le son 0x76.

Les boutons « + » de la page reproduisent ces effets, sauf le drapeau, le message et le
son. Vérifié : Guerrier 1 → 2 donne vie 20 → 24 ; Mage 1 → 2 donne magie 6 → 24.

**Objets réellement présents (vérifié 2026-11-08)** : chaque entrée de la table des objets
fait 16 octets et commence 12 octets avant le type (0x31F79 − 12 = 0x31F6D). Champs :
+0 objet suivant de la même case, +2 suivant à dessiner, +4 hauteur, +5 case, +7 x et +9 y
(case × 256 + décalage), +11 niveau, +12 type, +14 drapeaux (0x4000 vu sur un objet posé).
Dans la grille vivante, les octets 4-5 d'une case donnent le premier objet posé ; une
valeur avec le bit 0x8000 désigne un monstre (dans les octets 6-7). Vérification : un
Onguent posé devant le groupe apparaît en case 525 (13,16), avec x = 0x0D40 et
y = 0x10C0, et les octets 4-5 de la case valent 1, son numéro. L'octet de niveau reste à
255, y compris pour un objet posé : c'est donc la liste de chaque case qui fait foi.

**Taille d'une fiche : 130 octets — vérifié.** Les modèles des personnages sont espacés
de 0x82 octets. Pour le vérifier sur le groupe, on a copié le modèle de Kieran dans le
deuxième emplacement (`0x3389F + 130 − 2`) :
- **Réaction du jeu** : il affiche aussitôt un second portrait (avec le visage de
  Michael, l'image du personnage n'étant pas chargée) ;
- **Panneau et triches** : la page lit et soigne ce personnage comme le premier.

Sur un modèle, la Protection calculée (1) diffère de celle de l'écran de choix (6). Les
multiplicateurs ne sont sans doute recalculés par le jeu qu'à l'arrivée réelle du
personnage dans le groupe.

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
- **2026-11-08** : champs de la table des objets (emplacements, action, force, protection,
  valeur), script des soins de `ITEM.INF`, rôles des 11 emplacements d'équipement ; fiche
  d'objet au clic dans l'inventaire et info-bulle au survol de la mini-carte.
- **2026-11-08** : serrures des clés (scripts des niveaux), affichées sur la mini-carte et
  dans la fiche des clés.
- **2026-11-08** : objets réellement présents (listes des cases dans la grille vivante),
  leviers et éléments cliquables sur la mini-carte, transitions douces de la vue 3D.
- **2026-11-08** : murs fragiles (Marteau) des cavernes du Draracle, sur la mini-carte.
- **2026-11-08** : effets magiques des anneaux (code de `MAIN.EXE`) et des objets à
  utiliser (`ITEM.INF`), nature des serrures, animation des monstres en 3D.
- **2026-11-08** : reconnaissance du niveau sur les seules cases significatives (les cavernes
  se ressemblent : 963 cases sur 1024 identiques entre les niveaux 5 et 25) ; choix du sprite
  d'un type ambigu (ex. SCAVNGR ou RATMAN au niveau 7, selon le drapeau d'histoire 64) : on
  garde le candidat le plus proche en mémoire des sprites sûrs du niveau, car une copie
  périmée du niveau précédent peut subsister.
- **2026-11-08** : seuils d'expérience et montée de niveau (code du jeu), boutons « + » par
  classe dans le panneau.
- **2026-11-08** : coffres (symbole 210 de la carte du jeu, 4 états), affichés sur la
  mini-carte avec leur état réel.
- **2026-11-08** : escaliers (symboles 25 et 26), trous (11) et passages de la fonction 0x3C,
  affichés sur la mini-carte ; portes animées dans la vue 3D.
- **2026-11-08** : mini-carte illustrée par les textures de chaque lieu, et icône réelle
  des objets seuls sur leur case.
- **2026-11-08** : téléporteurs (symbole 17 et sauts de la fonction 0x3C dans le même niveau),
  affichés sur la mini-carte avec leur destination.
- **2026-11-08** : illustration des lieux au survol (image du jeu ou capture de la vue 3D).
- **2026-11-08** : vue 3D d'Yvel (décor `YVEL1`) traitée comme un extérieur.
  - Ciel : couleur moyenne de chaque ligne du fond d'origine au-dessus de l'horizon (ligne 47).
  - Façades sur 3 étages : les étages répètent la texture unie du niveau la plus proche du
    haut de la face, sans le soubassement (12 lignes), pour ne pas répéter portes et enseignes.
  - Ce rendu est choisi par nous et n'a pas été comparé au jeu.
- **2026-11-08** : fiche d'objet, comparaison avec l'équipement porté.
  - `items.json` gagne les champs chiffrés `might` et `prot` (`tools/item_info.py`, § 8.2).
  - Pour chaque personnage et chaque emplacement possible, la fiche donne l'écart de force et
    de protection, ainsi que les effets gagnés ou perdus.
  - Les armes et boucliers sont comparés à la main principale seulement.
- **2026-11-08** : contenu des coffres (fonction 0x49), 50 coffres sur 54, affiché au survol.
- **2026-11-08** : noms français des niveaux (texte 528 + n de LANDS.FRE).
- **2026-11-09** : passages cachés, § 6.0 quinquies.
  - Les faux murs (faces opaques non bloquantes, 18 au niveau 23) sont teintés en vert d'eau.
    Leurs côtés traversables sont en pointillés.
  - Les murs effacés par un script (44 murs, `tools/hidden_walls.py`) ont un cadre pointillé.
    L'infobulle donne le mécanisme, l'objet attendu et la case qui referme le passage.
