# Déployer Atelier Board V2.1

La V2.1 s'exécute sur un serveur Linux avec Docker Engine et Docker Compose. La configuration HTTPS demande **Compose 2.24.4 ou plus récent** pour retirer le port public de l'application avec `!reset`. Utiliser les commandes ci-dessous depuis la racine du projet.

Les étapes de construction peuvent télécharger `node:24-alpine`, les paquets npm et, en HTTPS, `caddy:2-alpine`. Le script de mise à jour hors ligne transporte les modifications du code ; il ne transporte ni ces images ni une installation de dépendances.

## Installation HTTPS

1. Faire pointer les enregistrements DNS A/AAAA de son domaine vers le serveur. Ouvrir les ports TCP 80 et 443 ; UDP 443 permet aussi HTTP/3. Le certificat automatique nécessite que Caddy soit joignable depuis Internet.
2. Télécharger les sources puis créer la configuration privée :

```bash
git clone https://github.com/Nqga/atelier-board-public.git
cd atelier-board-public
cp .env.production.example .env.production
```

3. Modifier `DOMAIN` dans `.env.production`, par exemple `DOMAIN=board.example.com`, sans protocole ni chemin. Ajuster les quotas si nécessaire ; chaque unité de stockage correspond à 1 Mio.
4. Démarrer :

```bash
docker compose --env-file .env.production -f docker-compose.yml -f deploy/compose.https.yml up -d --build
docker compose --env-file .env.production -f docker-compose.yml -f deploy/compose.https.yml ps
```

Ouvrir `https://board.example.com`. Caddy configure le certificat, redirige HTTP vers HTTPS et transmet HTTP et WebSocket vers le service `atelier:3000`. La recette fixe `PUBLIC_URL=https://DOMAIN` et `TRUST_PROXY=1` ; elle retire les ports publiés du service Node. L'interface, les API et les images partagent la même origine.

Si des variables de proxy réseau sont héritées, la recette ajoute le service `atelier` à `NO_PROXY` et `no_proxy` tout en conservant leurs listes existantes : Caddy joint ainsi directement le serveur Node.

Pour consulter les journaux ou arrêter cette installation, reprendre **les mêmes options** :

```bash
docker compose --env-file .env.production -f docker-compose.yml -f deploy/compose.https.yml logs --tail=100 atelier caddy
docker compose --env-file .env.production -f docker-compose.yml -f deploy/compose.https.yml stop
```

Ne pas employer la seule commande de démarrage HTTP après avoir installé la recette HTTPS : il faut conserver les deux fichiers Compose et le fichier d'environnement.

## Accès HTTP local ou proxy existant

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
curl http://localhost:3000/api/health
```

Le port est publié sur `127.0.0.1:${PORT:-3000}`. Le contrôle de santé appelle `/api/health`, vérifie SQLite et ne crée pas de session. Compose indique `healthy` lorsque l'application répond ; consulter les journaux si elle reste `unhealthy`. L'état sain du conteneur ne vérifie pas le DNS ou le certificat du proxy.

Avec un proxy HTTPS installé sur le même hôte, renseigner `PUBLIC_URL` et `TRUST_PROXY=1` dans `.env`, puis configurer le proxy pour transmettre `X-Forwarded-Proto` et les connexions WebSocket. Garder Node inaccessible directement depuis Internet. Pour HTTP local, laisser `TRUST_PROXY=0`.

## Données persistantes et identité

Le service `atelier` exécute Node.js 24 avec UID/GID 1000. Son système de fichiers applicatif est en lecture seule ; seul `/data`, fourni par le volume Compose `atelier-data`, conserve SQLite et les images. Les sessions, appartenances et invitations sont dans cette même base. Les volumes `caddy-data` et `caddy-config` conservent les certificats et la configuration d'exécution Caddy.

Le nom réel du volume est normalement `<projet-compose>_atelier-data`. **Conserver le nom de projet Compose utilisé pour la V2.** Un changement de dossier, de `-p` ou de `COMPOSE_PROJECT_NAME` peut créer un nouveau volume vide et donner l'impression que les projets ont disparu. Si le dossier doit changer, reprendre explicitement l'ancien nom avec `-p ancien-nom` sur toutes les commandes, ou définir `COMPOSE_PROJECT_NAME=ancien-nom` dans le fichier d'environnement utilisé.

Ne pas exécuter `docker compose down --volumes`, supprimer le volume ou démarrer plusieurs instances sur la même base. Pour conserver l'identité des visiteurs, garder les données serveur, l'origine publique et les cookies de leurs navigateurs. Changer de domaine ne transfère pas les cookies : conserver avant cela un lien privé de gestion du projet permet au propriétaire de retrouver son accès sur la nouvelle origine. Les brouillons IndexedDB sont également attachés à l'origine du navigateur ; les exporter avant un changement de domaine.

## Sauvegarder un serveur Docker

Arrêter proprement le service avant la copie. Sauvegarder **tout `/data`**, pas seulement `atelier.sqlite` : les images et les éventuels fichiers de journal SQLite doivent accompagner la base. Le cache navigateur et les exports de tableaux ne sauvegardent pas les sessions, invitations ou droits du serveur.

Pour une installation HTTP, cette procédure utilise le conteneur déjà créé et son image locale, sans télécharger d'image auxiliaire :

```bash
umask 077
atelier_container="$(docker compose ps -a -q atelier)"
atelier_volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$atelier_container")"
atelier_image="$(docker inspect --format '{{.Image}}' "$atelier_container")"
test -n "$atelier_volume"

docker compose stop atelier
mkdir -p ../atelier-board-backups
atelier_backup="$(pwd)/../atelier-board-backups/data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
docker run --rm --network none --user 0:0 --entrypoint sh \
  --mount "type=volume,src=$atelier_volume,dst=/data,readonly" \
  "$atelier_image" -c 'tar -cz -C /data .' > "$atelier_backup"
chmod 600 "$atelier_backup"
docker compose start atelier
```

Avec la recette HTTPS, remplacer les commandes `docker compose` ci-dessus par `docker compose --env-file .env.production -f docker-compose.yml -f deploy/compose.https.yml`, en gardant le même nom de projet. Caddy peut rester actif pendant l'arrêt temporaire de Node.

Conserver aussi les sources de la version utilisée et le fichier `.env` ou `.env.production`, dans un emplacement privé. Une copie des volumes Caddy permet de conserver les certificats lors d'un déplacement du serveur. La sauvegarde contient des données privées ; ne pas la publier dans GitHub. Vérifier qu'elle est lisible et tester périodiquement une restauration sur une installation séparée.

## Passer de la V2 à la V2.1 hors ligne

Télécharger [atelier-board-v2-to-v2.1.sh](../releases/atelier-board-v2-to-v2.1.sh) sur une machine connectée, puis transférer ce **seul fichier** vers le serveur V2. Le projet de destination doit être `atelier-board` en version `2.0.x` ou déjà `2.1.0` dans `package.json` ; aucun dépôt Git n'est requis.

Le script nécessite Bash et les outils courants `tar`, `gzip`, `base64`, `mktemp`, `awk`, `sed`, `sort`, `cmp`, `cp`, `mv`, `chmod`, `cat`, ainsi que `sha256sum` ou `shasum`. Il ne demande ni Git, ni Node.js, ni npm, ni Docker pour remplacer les sources.

1. Arrêter l'application V2 et sauvegarder son répertoire de données complet. Avec Docker, garder le nom de projet et appliquer la procédure précédente. Avec Node, arrêter le processus puis créer une archive :

```bash
umask 077
tar -czf /chemin/prive/atelier-data-v2.tar.gz -C /chemin/du/DATA_DIR .
```

2. Vérifier la destination et appliquer le code :

```bash
bash /chemin/atelier-board-v2-to-v2.1.sh --check /chemin/atelier-board
bash /chemin/atelier-board-v2-to-v2.1.sh /chemin/atelier-board
```

Le script vérifie le contenu embarqué avant remplacement et refuse les liens symboliques sur les chemins qu'il modifie. Il sauvegarde les sources remplacées dans un dossier privé voisin `.atelier-board-v2.1-backup-XXXXXX`, dont il affiche le chemin. Les nouveaux fichiers sont appliqués avec les autres sources ; `.git/`, `node_modules/`, `data/`, les bases SQLite et les fichiers `.env` privés restent conservés. Des modifications personnelles de fichiers sources remplacés restent dans cette sauvegarde : les revoir avant de les réappliquer.

Le script ne démarre aucun processus et ne modifie pas la base. Si le remplacement des fichiers échoue, il tente de restaurer les sources déjà remplacées. Le dossier de sauvegarde contient `files/`, `changes.tsv`, `new-files.list`, `created-directories.list`, `target.path` et un `README.txt` de restauration. Une sauvegarde de sources ne remplace pas la sauvegarde des données. Conserver le chemin affiché jusqu'à la validation de la nouvelle installation.

3. Vérifier les configurations locales. L'ancien `.env` n'est pas remplacé. Pour adopter Caddy, créer `.env.production` depuis son exemple et garder le nom de projet Compose de l'ancienne installation.
4. Reconstruire puis démarrer. Pour HTTP :

```bash
docker compose up -d --build
docker compose ps
curl http://localhost:3000/api/health
```

Pour HTTPS, utiliser les deux fichiers Compose et `.env.production` comme dans la première section. La construction peut utiliser Internet ; **seule l'application des modifications du code est garantie hors ligne**. Si la V2 tournait directement sous Node, importer d'abord son `DATA_DIR` dans le volume, selon la section suivante.

## Importer des données Node V2 ou restaurer une sauvegarde

Cette procédure cible un **volume Docker vide**. Garder l'ancien `DATA_DIR` ou l'ancien volume intact jusqu'à validation. Pour une restauration d'urgence, préparer une installation séparée ou un nouveau volume ; ne pas superposer une archive à une base déjà utilisée.

1. Arrêter le serveur d'origine et créer l'archive de tout son répertoire de données, comme ci-dessus.
2. Dans les sources V2.1, construire puis **créer sans démarrer** le service :

```bash
docker compose build atelier
docker compose create atelier
atelier_container="$(docker compose ps -a -q atelier)"
atelier_volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$atelier_container")"
atelier_image="$(docker inspect --format '{{.Image}}' "$atelier_container")"
atelier_backup="/chemin/absolu/prive/atelier-data-v2.tar.gz"
test -n "$atelier_volume"
```

3. Importer l'archive ; la commande refuse un volume non vide et attribue les fichiers à l'utilisateur Node :

```bash
docker run --rm --network none --user 0:0 --entrypoint sh \
  --mount "type=volume,src=$atelier_volume,dst=/data" \
  --mount "type=bind,src=$atelier_backup,dst=/backup/data.tar.gz,readonly" \
  "$atelier_image" -c '\
    test -z "$(ls -A /data)" || { echo "Le volume de destination doit être vide." >&2; exit 1; }; \
    tar -xzf /backup/data.tar.gz -C /data && chown -R 1000:1000 /data'
```

4. Démarrer avec les mêmes fichiers Compose et le même nom de projet. Vérifier la santé, ouvrir un projet existant, contrôler une image, puis connecter deux navigateurs pour valider la synchronisation. Pour HTTPS, reprendre les options de la recette Caddy sur les commandes Compose des étapes 2 et 4.

Le helper de copie utilise temporairement UID 0 pour restaurer les permissions ; le serveur tourne ensuite avec UID 1000. Le nom public doit correspondre à `PUBLIC_URL`, ou à `DOMAIN` avec Caddy. Le serveur V2.1 applique les migrations nécessaires au premier démarrage.

## Retour à une version antérieure

Un échec pendant l'application du script déclenche la restauration de ses fichiers sources. Pour restaurer manuellement les sources après une application réussie, arrêter le service et lire d'abord `README.txt` dans le dossier de sauvegarde. Vérifier `target.path` et `changes.tsv` : toute modification faite après la mise à jour doit être conservée séparément avant restauration.

Pour une destination restée inchangée depuis l'application du script :

```bash
atelier_source_backup="/chemin/.atelier-board-v2.1-backup-XXXXXX"
atelier_target="/chemin/atelier-board"
cp -a "$atelier_source_backup/files/." "$atelier_target/"
while IFS= read -r atelier_new_file; do
  test -n "$atelier_new_file" || continue
  rm -- "$atelier_target/$atelier_new_file"
done < "$atelier_source_backup/new-files.list"
```

Les anciens fichiers sont restaurés et les fichiers ajoutés par la mise à jour sont retirés ; les dossiers créés peuvent être laissés vides. Les données privées ne sont pas modifiées par cette restauration de sources.

Après un démarrage réussi de la V2.1, revenir aux sources V2 **ne garantit pas** la compatibilité avec une base déjà migrée. Pour un retour complet, garder le service arrêté, reprendre la configuration précédente et restaurer dans un volume vide la sauvegarde de données faite avant mise à jour.

Ne pas exécuter deux versions à la fois sur le même volume. Les changements effectués après la sauvegarde ne figurent pas dans cette sauvegarde ; conserver l'état actuel séparément avant un retour arrière. Une restauration de données et un redémarrage doivent rester des actions explicites, jamais des conséquences automatiques de l'application du script de sources.
