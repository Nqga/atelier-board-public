#!/usr/bin/env bash
# Généré par scripts/build-offline-update.mjs. Aucune connexion réseau nécessaire.
set -euo pipefail
umask 077

target_version='@@TARGET_VERSION@@'
archive_sha256='@@ARCHIVE_SHA256@@'
installer_path='releases/atelier-board-v2-to-v2.1.sh'
manifest_name='__atelier_update_manifest.tsv'
workspace=''
backup=''
lock=''
temporary_file=''
applying=0
applied=()
created_directories=()
changes=()

usage() {
  cat <<'HELP'
Usage : bash atelier-board-v2-to-v2.1.sh [--check] /chemin/atelier-board

Applique toutes les sources de la v2.1 sans réseau, Git, Node ou Docker.
--check valide le script et la destination sans modifier le projet.
Arrêtez l'application avant d'appliquer. Aucun service n'est lancé ou arrêté.
Les fichiers sources existants sont sauvegardés dans un dossier privé voisin.
Les données, .env, node_modules et .git restent inchangés.
HELP
}

fail() { printf 'Mise à jour impossible : %s\n' "$*" >&2; exit 1; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{print $1}'
  else
    shasum -a 256 -- "$1" | awk '{print $1}'
  fi
}

file_mode() {
  stat -c '%a' -- "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

safe_path() {
  local path="$1" part
  [[ "$path" =~ ^[A-Za-z0-9._/-]+$ && "$path" != /* && "$path" != */ ]] || return 1
  case "/$path/" in *//*|*/../*|*/./*) return 1 ;; esac
  IFS='/' read -r -a path_parts <<< "$path"
  for part in "${path_parts[@]}"; do
    case "$part" in .git|node_modules|data|test-results|.openai|.npmrc|.netrc|id_rsa|id_dsa|id_ecdsa|id_ed25519) return 1 ;; esac
  done
  case "$path" in .env.example|.env.production.example) return 0 ;; esac
  case "$path" in .env|.env.*|*/.env|*/.env.*|*.sqlite|*.sqlite-shm|*.sqlite-wal|*.db|*.pem|*.key|*.p12|*.pfx) return 1 ;; esac
}

# Reject links, even dangling ones, and every file/directory collision in managed paths.
check_target_path() {
  local path="$1" cursor="$target" part index
  IFS='/' read -r -a path_parts <<< "$path"
  for ((index=0; index<${#path_parts[@]}; index++)); do
    part="${path_parts[index]}"
    cursor="$cursor/$part"
    [[ ! -L "$cursor" ]] || fail "Lien symbolique interdit dans un chemin source : $path"
    if (( index + 1 < ${#path_parts[@]} )); then
      [[ ! -e "$cursor" || -d "$cursor" ]] || fail "Un fichier remplace un dossier source : $path"
    else
      [[ ! -e "$cursor" || -f "$cursor" ]] || fail "La cible source n'est pas un fichier régulier : $path"
    fi
  done
}

make_parents() {
  local path="$1" cursor="$target" part index
  IFS='/' read -r -a path_parts <<< "$path"
  for ((index=0; index + 1 < ${#path_parts[@]}; index++)); do
    part="${path_parts[index]}"
    cursor="$cursor/$part"
    if [[ ! -d "$cursor" ]]; then
      created_directories+=("$cursor")
      printf '%s\n' "${cursor#"$target/"}" >> "$backup/created-directories.list"
      mkdir -m 755 -- "$cursor"
    fi
  done
}

rollback() {
  local index path rollback_failed=0
  set +e
  for ((index=${#applied[@]}-1; index>=0; index--)); do
    path="${applied[index]}"
    # A concurrent modification of ancestors is not safe to follow during recovery.
    if ! (check_target_path "$path"); then rollback_failed=1; continue; fi
    if [[ -f "$backup/files/$path" ]]; then
      temporary_file=$(mktemp "$(dirname -- "$target/$path")/.atelier-rollback.XXXXXX") || { rollback_failed=1; continue; }
      cp -p -- "$backup/files/$path" "$temporary_file" && mv -f -- "$temporary_file" "$target/$path" || rollback_failed=1
      [[ ! -e "$temporary_file" ]] || rm -f -- "$temporary_file"
      temporary_file=''
    else
      rm -f -- "$target/$path" || rollback_failed=1
    fi
  done
  for ((index=${#created_directories[@]}-1; index>=0; index--)); do
    rmdir -- "${created_directories[index]}" 2>/dev/null || true
  done
  if (( rollback_failed )); then
    printf 'La restauration automatique est incomplète. Sauvegarde conservée : %s\n' "$backup" >&2
  else
    printf 'Les modifications appliquées ont été annulées. Sauvegarde : %s\n' "$backup" >&2
  fi
  return "$rollback_failed"
}

finish() {
  local status=$?
  trap - EXIT INT TERM HUP
  [[ -z "$temporary_file" ]] || rm -f -- "$temporary_file"
  temporary_file=''
  if (( applying )); then rollback || true; fi
  [[ -z "$lock" ]] || rmdir -- "$lock" 2>/dev/null || true
  [[ -z "$workspace" ]] || rm -rf -- "$workspace"
  exit "$status"
}

trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

check_only=0
if [[ "${1-}" == '--help' || "${1-}" == '-h' ]]; then usage; exit 0; fi
if [[ "${1-}" == '--check' ]]; then check_only=1; shift; fi
(( $# == 1 )) || { usage >&2; exit 2; }
[[ -n "$1" && -d "$1" ]] || fail "La destination doit être un dossier Atelier Board existant."
[[ ! -L "$1" ]] || fail "Le dossier destination est un lien symbolique."
target=$(cd -- "$1" && pwd -P)
[[ "$target" != *$'\n'* && "$target" != *$'\r'* ]] || fail "Le chemin destination ne doit pas contenir de retour à la ligne."
for utility in tar gzip base64 mktemp awk sed sort cmp cp mv chmod stat mkdir rmdir rm dirname cat; do
  command -v "$utility" >/dev/null 2>&1 || fail "Outil manquant : $utility"
done
command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || fail "sha256sum ou shasum est nécessaire."

workspace=$(mktemp -d "${TMPDIR:-/tmp}/atelier-board-update.XXXXXX")
archive="$workspace/payload.tar.gz"
payload="$workspace/payload"
mkdir -- "$payload"
cat > "$workspace/payload.base64" <<'ATELIER_PAYLOAD_BASE64'
@@PAYLOAD_BASE64@@
ATELIER_PAYLOAD_BASE64
if ! base64 --decode < "$workspace/payload.base64" > "$archive" 2>/dev/null; then
  base64 -D < "$workspace/payload.base64" > "$archive" || fail "Archive Base64 invalide."
fi
[[ "$(sha256 "$archive")" == "$archive_sha256" ]] || fail "Le contenu embarqué est corrompu (SHA-256)."
gzip -t -- "$archive" || fail "Archive gzip invalide."
tar -tzf "$archive" > "$workspace/archive-paths"
while IFS= read -r path; do
  [[ "$path" == "$manifest_name" ]] || safe_path "$path" || fail "Chemin archive interdit : $path"
done < "$workspace/archive-paths"
# The verified archive is built exclusively from regular source files.
tar -tvzf "$archive" | awk 'substr($0, 1, 1) != "-" {bad=1} END {exit bad}' || fail "L'archive contient un lien ou un fichier spécial."
tar -xzf "$archive" -C "$payload"
[[ -f "$payload/$manifest_name" && ! -L "$payload/$manifest_name" ]] || fail "Manifeste absent."
: > "$workspace/expected-paths"
printf '%s\n' "$manifest_name" >> "$workspace/expected-paths"
while IFS=$'\t' read -r checksum mode path extra; do
  [[ -z "${extra-}" && "$checksum" =~ ^[a-f0-9]{64}$ && "$mode" =~ ^(644|755)$ ]] || fail "Manifeste invalide."
  safe_path "$path" || fail "Chemin manifeste interdit : $path"
  [[ -f "$payload/$path" && ! -L "$payload/$path" ]] || fail "Source manquante : $path"
  [[ "$(sha256 "$payload/$path")" == "$checksum" ]] || fail "Source corrompue : $path"
  chmod "$mode" -- "$payload/$path"
  printf '%s\n' "$path" >> "$workspace/expected-paths"
done < "$payload/$manifest_name"
sort "$workspace/archive-paths" > "$workspace/archive-sorted"
sort "$workspace/expected-paths" > "$workspace/expected-sorted"
cmp -s -- "$workspace/archive-sorted" "$workspace/expected-sorted" || fail "Le manifeste ne décrit pas exactement l'archive."
[[ "$(sort -u "$workspace/expected-paths" | awk 'END {print NR}')" == "$(awk 'END {print NR}' "$workspace/expected-paths")" ]] || fail "Doublon dans le manifeste."

# The installer itself is copied separately: embedding it inside its archive would recurse.
[[ -f "$0" ]] || fail "Exécutez le script depuis un fichier, pas depuis l'entrée standard."
mkdir -p -- "$payload/releases"
cp -- "$0" "$payload/$installer_path"
chmod 755 -- "$payload/$installer_path"
printf '%s\t755\t%s\n' "$(sha256 "$payload/$installer_path")" "$installer_path" >> "$payload/$manifest_name"

validate_destination() {
  check_target_path 'package.json'
  [[ -f "$target/package.json" ]] || fail "package.json est absent."
  local project version
  project=$(sed -n 's/^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$target/package.json" | sed -n '1p')
  version=$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$target/package.json" | sed -n '1p')
  # v2.1.0 is the released container baseline; never replace a newer release.
  [[ "$project" == 'atelier-board' && ( "$version" =~ ^2\.0\.[0-9]+$ || "$version" == '2.1.0' || "$version" == "$target_version" ) ]] || fail "La destination doit être Atelier Board v2.0.x, v2.1.0 ou v$target_version."
  while IFS=$'\t' read -r checksum mode path; do check_target_path "$path"; done < "$payload/$manifest_name"
}

validate_destination
if (( check_only )); then
  printf 'Vérification réussie : sources v%s et destination valides. Aucune modification appliquée.\n' "$target_version"
  exit 0
fi
lock="$target/.atelier-board-update.lock"
if ! mkdir -- "$lock" 2>/dev/null; then lock=''; fail "Une mise à jour est déjà en cours, ou .atelier-board-update.lock existe. Vérifiez avant de retirer ce verrou."; fi
validate_destination
while IFS=$'\t' read -r checksum mode path; do
  if [[ ! -f "$target/$path" ]] || [[ "$(sha256 "$target/$path")" != "$checksum" ]] || [[ "$(file_mode "$target/$path")" != "$mode" ]]; then
    changes+=("$path")
  fi
done < "$payload/$manifest_name"
if (( ${#changes[@]} == 0 )); then
  printf 'Les sources v%s sont déjà appliquées. Aucun fichier remplacé.\n' "$target_version"
  exit 0
fi

backup=$(mktemp -d "$(dirname -- "$target")/.atelier-board-v2.1-backup-XXXXXX")
mkdir -- "$backup/files"
printf '%s\n' "$target" > "$backup/target.path"
: > "$backup/changes.tsv"
: > "$backup/new-files.list"
: > "$backup/created-directories.list"
for path in "${changes[@]}"; do
  check_target_path "$path"
  if [[ -f "$target/$path" ]]; then
    mkdir -p -- "$(dirname -- "$backup/files/$path")"
    cp -p -- "$target/$path" "$backup/files/$path"
    printf 'existing\t%s\t%s\t%s\n' "$(sha256 "$backup/files/$path")" "$(sha256 "$payload/$path")" "$path" >> "$backup/changes.tsv"
  else
    printf 'new\t-\t%s\t%s\n' "$(sha256 "$payload/$path")" "$path" >> "$backup/changes.tsv"
    printf '%s\n' "$path" >> "$backup/new-files.list"
  fi
done
cat > "$backup/README.txt" <<'BACKUP_HELP'
Sauvegarde privée des fichiers sources remplacés, sans données, .env ou dépôt Git.
target.path contient la destination d'origine ; changes.tsv décrit les seuls fichiers touchés.
files/ conserve le contenu, les permissions et les dates des fichiers préexistants.
new-files.list liste les nouveaux fichiers, à retirer uniquement pour revenir à la version précédente.
created-directories.list liste les dossiers créés, à retirer uniquement s'ils sont vides.

Restauration manuelle après une mise à jour réussie :
1. Arrêter l'application et sauvegarder les éventuelles modifications de code plus récentes.
2. Vérifier qu'aucun chemin source concerné n'est devenu un lien symbolique.
3. Copier le contenu de files/ sur la destination en conservant les permissions (cp -a).
4. Retirer seulement les fichiers énumérés dans new-files.list, puis les dossiers créés s'ils sont vides.
5. Recréer les conteneurs de la version restaurée si nécessaire. Ne pas toucher aux volumes de données.
En cas d'échec d'application, une restauration automatique est déjà tentée.
BACKUP_HELP
printf 'Arrêtez l’application avant application. Sauvegarde privée : %s\n' "$backup"
applying=1
for path in "${changes[@]}"; do
  check_target_path "$path"
  make_parents "$path"
  temporary_file=$(mktemp "$(dirname -- "$target/$path")/.atelier-update.XXXXXX")
  cp -p -- "$payload/$path" "$temporary_file"
  # Record before rename so a signal immediately after it also restores this file.
  applied+=("$path")
  mv -f -- "$temporary_file" "$target/$path"
  temporary_file=''
done
applying=0
printf 'Atelier Board v%s appliqué (%s fichiers).\n' "$target_version" "${#changes[@]}"
printf 'Données et configuration privée conservées. Aucun conteneur lancé.\n'
printf 'Sauvegarde à conserver : %s\n' "$backup"
