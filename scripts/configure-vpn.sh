#!/usr/bin/env bash
# Configuration locale uniquement : ce script ne crée ni ne démarre de tunnel VPN.
set -euo pipefail
umask 077

lock=''
temporary=''
backup=''

usage() {
  cat <<'HELP'
Usage : bash scripts/configure-vpn.sh [--check] <IPv4-locale-du-serveur> [port]

Prépare .env.vpn pour un serveur accessible par un tunnel VPN déjà installé.
Le port par défaut est 3000. L'adresse doit être attribuée à cette machine.
Le projet est déterminé par l'emplacement du script, quel que soit le dossier courant.

--check valide sans écrire de fichier. Aucun conteneur ni tunnel n'est démarré.
.env, les sources, les données et le dépôt Git restent inchangés.
Une ancienne .env.vpn modifiée est sauvegardée dans un fichier privé avant remplacement.
HELP
}

fail() { printf 'Configuration VPN refusée : %s\n' "$1" >&2; exit 1; }
cleanup() {
  [[ -z "$temporary" ]] || rm -f -- "$temporary"
  [[ -z "$lock" ]] || rmdir -- "$lock" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

check_only=0
case "${1-}" in
  -h|--help) usage; exit 0 ;;
  --check) check_only=1; shift ;;
esac
if (( $# < 1 || $# > 2 )); then usage >&2; exit 2; fi

bind_address="$1"
port="${2-3000}"
[[ "$bind_address" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail 'Indiquez une adresse IPv4, sans URL ni port.'
IFS=. read -r -a octets <<< "$bind_address"
for octet in "${octets[@]}"; do
  [[ "$octet" == 0 || "$octet" != 0* ]] || fail 'Les octets IPv4 ne doivent pas commencer par zéro.'
  (( 10#$octet <= 255 )) || fail 'Adresse IPv4 invalide.'
done
(( 10#${octets[0]} > 0 && 10#${octets[0]} < 224 )) || fail 'Utilisez une adresse IPv4 unicast locale, jamais 0.0.0.0.'
[[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] && (( 10#$port <= 65535 )) || fail 'Le port doit être un entier entre 1 et 65535.'

for tool in ip awk dirname mktemp cmp chmod cp mv rm rmdir mkdir stat; do
  command -v "$tool" >/dev/null 2>&1 || fail "Commande requise absente : $tool (Linux avec iproute2)."
done

# Refuser aussi les liens présents dans les composants parents, avant tout cd.
reject_links() {
  local path="$1"
  while [[ "$path" != / && "$path" != . ]]; do
    [[ ! -L "$path" ]] || fail 'Un chemin utilisé par le script est un lien symbolique.'
    path="$(dirname -- "$path")"
  done
}
script_path="${BASH_SOURCE[0]}"
[[ "$script_path" == /* ]] || script_path="$PWD/$script_path"
reject_links "$script_path"
[[ -f "$script_path" ]] || fail 'Le script doit être un fichier ordinaire.'
project="$(cd -- "$(dirname -- "$script_path")/.." && pwd -P)"
for source_file in "$project/package.json" "$project/docker-compose.yml" "$project/deploy/compose.vpn.yml"; do
  reject_links "$source_file"
  [[ -f "$source_file" ]] || fail 'Le script doit être installé dans le projet Atelier Board complet.'
done

addresses="$(ip -o -4 addr show 2>/dev/null)" || fail 'Impossible de lire les interfaces locales avec iproute2.'
printf '%s\n' "$addresses" | awk -v wanted="$bind_address" '
  $3 == "inet" { split($4, address, "/"); if (address[1] == wanted) found = 1 }
  END { exit !found }
' || fail 'Cette adresse IPv4 n’est pas attribuée à la machine. Utilisez l’adresse locale du serveur dans le tunnel.'

environment_file="$project/.env.vpn"
lock_path="$project/.atelier-board-vpn.lock"
reject_links "$environment_file"
reject_links "$lock_path"
[[ ! -e "$environment_file" || -f "$environment_file" ]] || fail '.env.vpn doit être un fichier ordinaire.'
[[ ! -e "$lock_path" ]] || fail 'Une configuration est déjà en cours ou un verrou existe : .atelier-board-vpn.lock.'
if (( check_only )); then
  printf 'Configuration VPN valide. Aucun fichier modifié.\n'
  exit 0
fi

# mkdir est exclusif : deux exécutions ne peuvent pas remplacer .env.vpn ensemble.
mkdir -- "$lock_path" 2>/dev/null || fail 'Une autre configuration vient de prendre le verrou.'
lock="$lock_path"
reject_links "$environment_file"
[[ ! -e "$environment_file" || -f "$environment_file" ]] || fail '.env.vpn doit être un fichier ordinaire.'
temporary="$(mktemp "$project/.env.vpn.tmp.XXXXXXXX")"
public_url="http://$bind_address:$port"
input=/dev/null
[[ ! -f "$environment_file" ]] || input="$environment_file"
# Lire le fichier comme du texte, sans source/eval ni exécution de ses valeurs.
awk -v address="$bind_address" -v port="$port" -v url="$public_url" '
  /^[[:space:]]*(export[[:space:]]+)?VPN_BIND_ADDRESS[[:space:]]*=/ {
    if (!address_seen++) print "VPN_BIND_ADDRESS=" address; next
  }
  /^[[:space:]]*(export[[:space:]]+)?PORT[[:space:]]*=/ {
    if (!port_seen++) print "PORT=" port; next
  }
  /^[[:space:]]*(export[[:space:]]+)?VPN_PUBLIC_URL[[:space:]]*=/ {
    if (!url_seen++) print "VPN_PUBLIC_URL=" url; next
  }
  { print }
  END {
    if (!address_seen) print "VPN_BIND_ADDRESS=" address
    if (!port_seen) print "PORT=" port
    if (!url_seen) print "VPN_PUBLIC_URL=" url
  }
' "$input" > "$temporary"
chmod 600 -- "$temporary"

if [[ -f "$environment_file" ]] && cmp -s -- "$environment_file" "$temporary" && [[ "$(stat -c '%a' -- "$environment_file")" == 600 ]]; then
  printf 'Configuration VPN déjà à jour. Aucun fichier modifié.\n'
  exit 0
fi
if [[ -f "$environment_file" ]]; then
  backup="$(mktemp "$project/.env.vpn.backup.XXXXXXXX")"
  cp -- "$environment_file" "$backup"
  chmod 600 -- "$backup"
fi
reject_links "$environment_file"
mv -fT -- "$temporary" "$environment_file"
temporary=''
printf 'Configuration VPN enregistrée dans .env.vpn (permissions 600).\n'
[[ -z "$backup" ]] || printf 'Ancienne configuration conservée dans une sauvegarde privée .env.vpn.backup.*.\n'
printf 'Aucun conteneur ni tunnel démarré. Suivez deploy/DEPLOYMENT.md pour lancer le profil VPN.\n'
