#!/bin/sh
# Lance Lands of Lore dans le navigateur : http://localhost:8000
cd "$(dirname "$0")/public" && exec python3 -m http.server 8000 --bind 127.0.0.1
