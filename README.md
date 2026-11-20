# Lands of Lore in the browser

Play **Lands of Lore: The Throne of Chaos** (Westwood Studios, 1993) in a web browser. The original game is wrapped in a page with modern controls, a live map, a 3D view and optional cheats.

The game runs unmodified in one of two engines, and you can switch between them from the page:

- **DOSBox** (js-dos): the original DOS executable, emulated.
- **ScummVM** (WebAssembly): ScummVM's reimplementation of the Kyra engine, with a small patch that lets the page read the game state and send it commands.

The page reads the game's memory (or the state published by ScummVM) in real time. From it, the page draws a map and a 3D view, and adds panels the original game never had.

## Demo videos

[![Demo video 1](https://img.youtube.com/vi/1258-77oyu4/hqdefault.jpg)](https://www.youtube.com/watch?v=1258-77oyu4)
[![Demo video 2](https://img.youtube.com/vi/64bViN8zTmk/hqdefault.jpg)](https://www.youtube.com/watch?v=64bViN8zTmk)
[![Lands of Lore - Cheating and spoilers](https://img.youtube.com/vi/HGVtNnCF890/hqdefault.jpg)](https://www.youtube.com/watch?v=HGVtNnCF890)

- [Demo video 1](https://www.youtube.com/watch?v=1258-77oyu4)
- [Demo video 2](https://www.youtube.com/watch?v=64bViN8zTmk)
- [Lands of Lore - Cheating and spoilers](https://www.youtube.com/watch?v=HGVtNnCF890)

> **Game files are not included.** You need your own copy of the game: the French CD version is the one supported and tested. This project is not affiliated with Westwood Studios or Electronic Arts.

## Features

### Modern controls
- **ZQSD / WASD movement**: the AZERTY or QWERTY keys, plus A/E (or Q/E) to strafe, alongside the original keys. Toggle it from the page.
- **Keyboard shortcuts**: <kbd>Tab</kbd> opens the full map, <kbd>I</kbd> the inventory.
- **Audio controls**: a master volume, plus separate music, sound effects and voice sliders (ScummVM).
- **Web UI saves**: save and load games from a dialog (ScummVM).
- **Settings kept** between sessions: subtitles, volumes and map options.

### Live map
- **Mini-map** next to the game. It shows:
  - walls and doors (open or closed);
  - stairs, holes and teleporters;
  - chests, locks, levers and other clickable spots;
  - fragile walls and hidden passages;
  - items on the floor;
  - monsters (hostile or peaceful).
- **Display options**: map size and zoom are separate settings. Cells can be textured or plain. The map can follow the party automatically.
- **Fog of war**, three modes:
  - the whole map;
  - the page's own exploration, remembered per level;
  - exactly the in-game automap. Under ScummVM this covers every visited level.
- **Full map** (<kbd>Tab</kbd>): any level, with the same options and a legend.
- **Teleport**: double-click any cell to teleport the party there.

### 3D view
- **Real 3D view** under the game, rebuilt from the level data: walls, floors, ceilings and decorations. Doors and monsters are live.
- **"Game perspective" mode**: imitates the original engine's distance scale.
- **Monsters**: drawn as the game draws them (attack and hit frames, translucent ghosts), with a **health bar** above each one.

### Party, inventory and magic
- **Character sheets**: stats, skills and experience, in a dialog.
- **Party slots**: pick the companions (ScummVM).
- **Inventory and equipment** (<kbd>I</kbd>): drag and drop, item details, and empty slots drawn with the game's own silhouettes.
- **Item directory**: every item, by category, with its description. You can create any item.
- **Cast spells** from the page, at any level, without going through the game's menus.

### Cheats (all optional)
- Infinite health and infinite magic.
- Extra crowns (money).
- Level up a skill.
- **Auto-attack**: for each character, choose the weapon, or a spell cast at the highest level the character can afford.
- **Unlock**: spells, the spell book, the atlas (in-game automap) and the compass.
- Empty the inventory.
- Teleport anywhere, on any level.

Most commands that change the game run inside ScummVM through the engine patch. The DOSBox version has the map, the 3D view and part of the cheats.

## Getting started

Requirements:
- **Python 3**: the tools have no dependencies;
- **innoextract**: unpacks the game installer;
- a **WebGL-capable browser**, which ScummVM needs.

1. **Extract the game.** The CD installer (Inno Setup) unpacks to `extracted-cd/app/C/LOLCD`:
   ```sh
   innoextract -d extracted-cd <your Lands of Lore CD installer>.exe
   ```
2. **Generate the map and 3D view data:**
   ```sh
   python3 -I tools/extract_maps.py extracted-cd/app/C/LOLCD maps
   python3 -I tools/export_viewer.py extracted-cd/app/C/LOLCD maps web/public/viewer/data
   ```
3. **Start the server.** It serves both engines, and also links the game files into the layout ScummVM expects. The game folder itself is not modified.
   ```sh
   python3 -I tools/scummvm_web.py 8000
   ```
   - http://localhost:8000/lol.html runs ScummVM.
   - http://localhost:8000/ runs DOSBox. It needs a js-dos bundle, `web/public/lands-cd-v2.jsdos`. The bundle is a zip holding the `LOLCD` folder plus a `.jsdos/dosbox.conf` whose `[autoexec]` runs `LANDS C:\LOLCD`.

Saves and settings are stored in the browser (IndexedDB), separately for each engine.

## How it works

- **Under DOSBox**: `tools/patch_jsdos.py` adds a channel to the js-dos workers so the page can read the emulated RAM. `web/public/memscan.js` reads the memory, and `web/public/minimap.js` decodes it: grid, monsters, items, party.
- **Under ScummVM**: the patched engine publishes the same state at the same addresses, plus a few extra zones (spells, monster types, automap), and runs commands sent by the page.
  - The patch is kept in `tools/scummvm/lol-web-state.patch`, and its history on the `lol-web` branch of [infocris/scummvm](https://github.com/infocris/scummvm/tree/lol-web).
  - The build used is described in `web/scummvm/VERSION.txt`.
- **Data**: `tools/` decodes the game files: PAK archives, LCW compression, level grids, wall types, EMC scripts, graphics, items. Those exports feed the maps and the 3D view.

Every file format and memory address found during the work is documented, in French, in [`docs/retro-conception.md`](docs/retro-conception.md).

## Layout

| Path | Content |
|---|---|
| `web/public/` | The page (DOSBox version), map, 3D viewer, js-dos |
| `web/scummvm/` | ScummVM WebAssembly build and the generated ScummVM pages |
| `tools/` | Extraction and export tools, the ScummVM web server, the engine patch |
| `docs/` | Reverse-engineering notes (French) |

## Notes

- **Language**: the page is in French, and it was developed and tested with the French CD version.
- **Third-party code**: two GPL builds are included:
  - ScummVM, under GPL-3.0; its licence and authors are in `web/scummvm/doc`;
  - js-dos 8.5.3 with DOSBox-X, under GPL-2.0, from the `js-dos` npm package (`web/public/emulators`).
