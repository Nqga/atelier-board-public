#!/usr/bin/env bash
# Mettre à jour le manifeste ci-dessous quand l'arborescence du projet change.
set -euo pipefail
set -o noclobber

usage() {
  cat <<'HELP'
Usage : bash create-structure.sh [nouveau-dossier]

Recrée l'arborescence d'Atelier Board avec tous les fichiers vides.
Le dossier par défaut est ./atelier-board-squelette, dans le dossier courant.
La destination doit être nouvelle. Aucun fichier existant n'est remplacé.
HELP
}

if (( $# > 1 )); then
  usage >&2
  exit 2
fi

destination="${1-./atelier-board-squelette}"
case "$destination" in
  -h|--help) usage; exit 0 ;;
  ''|-*) usage >&2; exit 2 ;;
esac
while [[ "$destination" == */ && "$destination" != / ]]; do
  destination="${destination%/}"
done

if [[ -e "$destination" || -L "$destination" ]]; then
  printf 'La destination existe déjà : %s. Choisissez un nouveau dossier.\n' "$destination" >&2
  exit 1
fi

mkdir -p -- "$(dirname -- "$destination")"
# La création exclusive protège aussi contre deux lancements simultanés.
mkdir -- "$destination"

file_count=0
while IFS= read -r relative_path; do
  mkdir -p -- "$destination/$(dirname -- "$relative_path")"
  : > "$destination/$relative_path"
  file_count=$((file_count + 1))
done <<'FILES'
.dockerignore
.env.example
.gitignore
COLLABORATION.md
Dockerfile
LICENSE
README.md
dist/app.js
dist/collab-cache.js
dist/collab-store.js
dist/collaboration-ui.css
dist/collaboration.js
dist/dialogs.js
dist/export.js
dist/favicon.svg
dist/index.html
dist/shared-model.js
dist/store.js
dist/styles.css
dist/templates.js
dist/vendor/LICENSES.txt
dist/vendor/yjs.js
docker-compose.yml
package-lock.json
package.json
scripts/build-vendor.mjs
scripts/check.mjs
scripts/create-structure.sh
server.mjs
server/atelier-server.mjs
server/database.mjs
server/quotas.mjs
server/security.mjs
tests/quotas.test.mjs
tests/server.test.mjs
tests/shared-store.test.mjs
tests/store.test.mjs
FILES

printf 'Structure vide créée dans %s (%s fichiers).\n' "$destination" "$file_count"
