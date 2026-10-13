# Déployer Atelier Board V2.2.0

La V2.2.0 s'exécute sur une machine distante avec Docker Engine et Docker Compose. Le déploiement de base expose l'application sur **`http://ADRESSE_DU_SERVEUR:3000`**. Les configurations VPN et HTTPS demandent **Compose 2.24.4 ou plus récent** pour remplacer ou retirer la publication du port de l'application. Utiliser les commandes ci-dessous depuis la racine du projet.

Les étapes de construction peuvent télécharger `node:24-alpine`, les paquets npm et, en HTTPS, `caddy:2-alpine`. Le script de mise à jour hors ligne transporte les modifications du code ; il ne transporte ni ces images ni une installation de dépendances.

## Serveur privé accessible par VPN

La machine et ses participants doivent déjà disposer d'un tunnel fonctionnel et des routes et droits d'accès nécessaires. Cette recette fonctionne avec un VPN de type WireTunnel/WireGuard qui transporte directement les connexions IP. Elle ne crée pas le tunnel, ne distribue pas de clés et ne modifie pas ses routes ou ses règles de pare-feu. Le tunnel n'est pas un proxy HTTP : le serveur garde `TRUST_PROXY=0`.

### Choisir l'adresse du serveur

Sur le serveur Linux, identifier une IPv4 qui lui est **réellement attribuée** et que les participants peuvent joindre depuis leur tunnel :

```bash
ip -4 address show
```

L'IP peut être celle de l'interface VPN du serveur ou une IP d'une interface réseau locale accessible par routage à travers le VPN. Elle doit être présente sur **cette machine**. Ne pas utiliser l'adresse d'une passerelle VPN distante, ni une adresse publique traduite par NAT qui n'est pas attribuée à une interface locale. Dans ce cas, utiliser l'IP locale atteinte par le routage déjà configuré et vérifier les routes/ACL du VPN existant.

Dans les commandes suivantes, **`192.0.2.10` est un exemple documentaire à remplacer** par cette IPv4 locale. Le helper refuse une IP qui n'est pas assignée au serveur et n'ajoute aucune adresse à ses interfaces. Il demande Linux, Bash et `ip` du paquet `iproute2`, ainsi que les outils shell courants. Docker Engine et Compose 2.24.4 ou plus récent sont nécessaires au démarrage.

### Configurer et démarrer

Depuis la racine du projet, après sauvegarde si l'application contient déjà des données :

```bash
bash scripts/configure-vpn.sh --check 192.0.2.10 3000
bash scripts/configure-vpn.sh 192.0.2.10 3000
```

`--check` vérifie l'adresse locale et la destination sans rien écrire. L'application de la configuration produit `.env.vpn` avec les permissions `600` :

```dotenv
VPN_BIND_ADDRESS=192.0.2.10
PORT=3000
VPN_PUBLIC_URL=http://192.0.2.10:3000
```

Le port est facultatif dans la commande du helper et vaut `3000` par défaut. Une configuration `.env.vpn` précédente est sauvegardée dans un fichier privé avant remplacement ; ses autres réglages sont conservés. Une nouvelle exécution avec les mêmes valeurs et permissions ne crée pas une nouvelle sauvegarde. `.env` reste inchangé : conserver les quotas, limites et éventuel `COMPOSE_PROJECT_NAME` existants. Ne pas remplacer un `.env` privé par l'exemple et ne pas créer un `.env` vide.

Construire la commande avec `.env` **seulement s'il existe**, puis `.env.vpn` qui fournit les valeurs du profil VPN :

```bash
atelier_compose=(docker compose)
if test -f .env; then
  atelier_compose+=(--env-file .env)
fi
atelier_compose+=(--env-file .env.vpn -f docker-compose.yml -f deploy/compose.vpn.yml)

# Si l'installation précédente utilisait « -p ancien-nom », ajouter cette
# même option à atelier_compose avant d'exécuter les commandes.
"${atelier_compose[@]}" config --quiet
"${atelier_compose[@]}" up -d --build
"${atelier_compose[@]}" ps
curl http://192.0.2.10:3000/api/health
```

Conserver **le nom de projet Compose et le volume de données existants**. Si l'ancien déploiement utilisait `-p ancien-nom`, ajouter `atelier_compose+=(-p ancien-nom)` après la construction du tableau de commande. Si le nom vient de `.env`, le premier `--env-file` le conserve. Reprendre exactement les mêmes options pour `logs`, `stop`, `start`, les sauvegardes et les mises à jour suivantes. Les tableaux de commandes ci-dessus demandent Bash.

Le profil utilise `!override` pour remplacer toute la liste des ports de `atelier` : il reste **un seul port lié à l'IPv4 choisie**, sans seconde publication sur `0.0.0.0`. Il fixe l'origine HTTP à `VPN_PUBLIC_URL` et `TRUST_PROXY=0`. Le conteneur écoute toujours sur `3000` en interne ; le nom du service et le volume `atelier-data` ne changent pas. Le helper n'arrête ni ne démarre les conteneurs : `up -d --build` est une action explicite après la configuration.

Chaque participant ouvre **`http://IP_LOCALE_DU_SERVEUR:3000`**, ou le port choisi, après connexion à son tunnel. Tous doivent utiliser cette même origine, également présente dans les liens d'invitation. Le VPN chiffre son segment de trajet ; HTTP reste HTTP au niveau de l'application. Si le VPN se termine sur une passerelle, la protection du segment jusqu'au serveur dépend aussi du réseau qui les relie. Une publication sur une IP ne limite pas à elle seule les clients autorisés : conserver les règles VPN et pare-feu qui autorisent TCP sur ce port uniquement depuis les réseaux souhaités. Aucune redirection Internet n'est requise pour les participants du tunnel.

Depuis un second appareil connecté au VPN, contrôler `/api/health` puis suivre le [parcours à plusieurs](#vérifier-le-parcours-à-plusieurs). Pour constater la publication Docker choisie, utiliser les mêmes options Compose avec `port atelier 3000`. Ne pas utiliser seulement `docker compose up` après avoir adopté le profil VPN : cela réactiverait la recette de base sur toutes les interfaces.

Les profils VPN et HTTPS sont des alternatives : ne pas empiler leurs fichiers Compose. Pour un proxy HTTP/HTTPS déjà installé, suivre la [recette correspondante](#accès-local-seulement-ou-proxy-existant) ; une IP privée du VPN ne donne pas automatiquement un certificat public Caddy.

## Installation HTTP sur une machine distante

1. Télécharger les sources sur la machine qui hébergera l'application :

```bash
git clone https://github.com/Nqga/atelier-board-public.git
cd atelier-board-public
cp .env.example .env
```

2. Dans `.env`, utiliser les valeurs suivantes :

```dotenv
PORT=3000
BIND_ADDRESS=0.0.0.0
PUBLIC_URL=
TRUST_PROXY=0
```

Le conteneur écoute sur `3000` et Docker publie ce port sur toutes les interfaces de l'hôte. `PUBLIC_URL` vide permet au serveur de contrôler l'origine à partir de l'adresse effectivement utilisée dans la requête. Si une seule adresse doit être utilisée, on peut fixer `PUBLIC_URL=http://ADRESSE_DU_SERVEUR:3000`, sans chemin, en remplaçant le nom par l'IP ou le DNS réel.

3. Autoriser le **port TCP 3000** dans le pare-feu de la machine et dans les règles réseau de l'hébergeur. Une machine derrière un routeur demande aussi une redirection de ce port vers son IP privée. Une IP privée, telle que `192.168.x.x`, n'est accessible que depuis un réseau qui sait la joindre.
4. Construire et démarrer :

```bash
docker compose up -d --build
docker compose ps
curl http://localhost:3000/api/health
```

5. Depuis **un autre appareil**, ouvrir `http://ADRESSE_DU_SERVEUR:3000`. L'adresse `/api/health` doit également répondre avec `status: "ok"` et `version: "2.2.0"`. `localhost` sur cet autre appareil ne désigne pas le serveur.

Tout visiteur qui peut joindre cette adresse peut ouvrir l'application et choisir une identité invitée. Les projets partagés restent privés et demandent une invitation ou des droits existants. Le volume `atelier-data` conserve les projets, les utilisateurs invités, leurs sessions et les images après recréation du conteneur.

En HTTP direct, les sessions et liens d'invitation circulent sans chiffrement. Utiliser la recette HTTPS ci-dessous pour chiffrer les connexions, tout en conservant le même fonctionnement de collaboration.

**Après une mise à jour**, vérifier l'ancien `.env` : le script hors ligne le conserve. Une ancienne valeur `PUBLIC_URL=http://localhost:3000` doit devenir vide ou correspondre à la véritable adresse du serveur, protocole et port compris. Si Docker écoute encore uniquement sur l'hôte, vérifier aussi `BIND_ADDRESS` et recréer le service avec `docker compose up -d --build --force-recreate`.

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

## Accès local seulement ou proxy existant

Pour publier le port uniquement sur la machine hôte, fixer `BIND_ADDRESS=127.0.0.1` dans `.env`. Avec un proxy HTTPS installé sur ce même hôte, renseigner `PUBLIC_URL=https://domaine-reel` et `TRUST_PROXY=1`, puis configurer le proxy pour transmettre `X-Forwarded-Proto` et les connexions WebSocket. Garder Node inaccessible directement depuis Internet. En HTTP direct ou local, laisser `TRUST_PROXY=0`.

Le contrôle de santé appelle `/api/health`, vérifie SQLite et ne crée pas de session. Compose indique `healthy` lorsque l'application répond ; consulter les journaux si elle reste `unhealthy`. L'état sain du conteneur ne vérifie ni sa joignabilité depuis un autre appareil, ni le DNS, ni le certificat du proxy.

## Vérifier le parcours à plusieurs

1. Sur le premier appareil, ouvrir l'adresse du serveur, créer un tableau et utiliser **Partager**. Choisir un pseudonyme et cliquer sur **Activer le partage**. Cette action crée une identité invitée et une copie privée du tableau sur le serveur.
2. Créer un lien d'invitation **Modification**, le copier et l'envoyer au second participant.
3. Sur un autre appareil, un deuxième navigateur ou une fenêtre privée, ouvrir **ce lien complet**, choisir un autre pseudonyme et cliquer sur **Rejoindre le tableau**. Deux onglets d'un même navigateur partagent normalement le cookie et la même identité ; ils ne simulent donc pas deux invités distincts.
4. Créer et déplacer un post-it depuis le premier participant, puis modifier son texte depuis le second. Vérifier que chacun reçoit les changements et que l'interface confirme leur sauvegarde. Faire aussi des modifications simultanées sur deux objets distincts.
5. Recharger les deux pages : le tableau et les droits doivent être conservés. Arrêter puis redémarrer le service avec le même volume pour contrôler la persistance serveur.
6. Créer un autre lien **Lecture** et l'ouvrir avec une troisième identité : le projet doit être visible sans possibilité de modifier son contenu. Retirer ensuite son accès depuis le propriétaire et vérifier que cette identité ne peut plus rouvrir le projet.

Il s'agit d'identités invitées conservées par cookie, sans compte par e-mail ni mot de passe. Deux personnes peuvent choisir le même pseudonyme sans avoir les mêmes droits. Perdre le cookie ne permet pas de retrouver ses projets en ressaisissant son nom : conserver au préalable le lien privé de gestion proposé au propriétaire.

## Diagnostiquer les erreurs de session et d'origine

`collaboration.js` affiche les refus de l'API ; lire dans l'onglet Réseau du navigateur le **statut HTTP**, la route, la méthode et le champ JSON `code`. Une erreur `401` et une erreur `403` correspondent à des causes différentes :

| Réponse | Cause et contrôle |
| --- | --- |
| `403 ORIGIN_FORBIDDEN` | L'origine du navigateur ne correspond pas à `PUBLIC_URL`, ou la requête vient d'un autre site. En HTTP distant, laisser `PUBLIC_URL` vide ou utiliser `http://ADRESSE_DU_SERVEUR:3000` exactement. Ne pas conserver `http://localhost:3000` ni `https://…` pour une application ouverte en HTTP. |
| `401 SESSION_REQUIRED` | Une action protégée n'a pas reçu de session valide : cookie absent, session expirée ou supprimée. Vérifier que le navigateur accepte le cookie `atelier_session` et que les appels utilisent la même origine. Un cookie `Secure` ne sera pas transmis en HTTP distant ; vérifier `PUBLIC_URL` et laisser `TRUST_PROXY=0` en accès direct. |
| `403 READ_ONLY` ou `403 OWNER_REQUIRED` | L'identité existe mais n'a pas le rôle nécessaire. Demander au propriétaire le droit correspondant. |
| `404 BOARD_NOT_FOUND` | Le projet n'existe plus ou cette identité n'a pas accès. Rejoindre avec une invitation valide ; ne pas confondre un pseudonyme identique avec l'ancien cookie. |
| `429 RATE_LIMIT` | Trop de requêtes ou d'admissions dans la fenêtre de temps. Attendre, puis ajuster les limites documentées si de nombreux participants partagent une même IP. |
| `SERVER_BUSY`, fermeture WebSocket `1013` | Limite temporaire de capacité. Le client conserve ses changements en attente et réessaie progressivement. Vérifier les limites et la charge du serveur. |

Avant le choix d'un pseudonyme, **`GET /api/session` doit répondre `200` avec `collaboration: true` et `user: null`**. Cette route ne demande pas de session. Un `401` sur ce GET indique qu'il faut vérifier la version réellement lancée et un éventuel proxy qui protège `/api/`, plutôt que créer des comptes à l'extérieur de l'application. Le POST crée l'identité ; un PATCH de changement de nom exige une session existante.

Après correction de `.env`, recréer le service et rouvrir **la même adresse publique**. Le contrôle `/api/health` permet de vérifier la version déployée. Préserver les cookies et les données autant que possible : effacer tous les cookies fait perdre l'identité existante. Pour un test neuf, préférer une fenêtre privée. Ne pas publier de valeur de cookie ou de jeton d'invitation dans un rapport de diagnostic.

## Charge et limites de l'installation

La V2.2.0 utilise **une instance serveur** avec SQLite et un volume persistant. Ne pas lancer `docker compose up --scale atelier=…` ni plusieurs processus partageant `DATA_DIR` : leurs états Yjs et leurs connexions ne seraient pas coordonnés. Pour augmenter la capacité, mesurer une instance et ajuster ses ressources et limites ; plusieurs instances demanderont une autre architecture de coordination et de stockage.

Dans `.env` ou `.env.production`, les limites d'admission sont des entiers strictement positifs :

| Variable | Défaut | Limite |
| --- | --- | --- |
| `MAX_CONNECTIONS` | `500` | Connexions WebSocket simultanées sur tout le serveur. |
| `MAX_CONNECTIONS_PER_BOARD` | `50` | Connexions simultanées par projet. |
| `MAX_CONNECTIONS_PER_USER` | `12` | Connexions simultanées d'une identité invitée, sur l'ensemble des projets. |
| `MAX_ACTIVE_BOARDS` | `100` | Projets distincts actuellement connectés. |
| `MAX_IDLE_BOARDS` | `100` | Documents sans connexion conservés dans le cache mémoire. |
| `SESSION_CREATIONS_PER_MINUTE` | `120` | Créations de sessions par IP et par minute. |
| `WEBSOCKET_CONNECTIONS_PER_MINUTE` | `300` | Tentatives de connexion WebSocket par IP et par minute. |
| `INVITATION_JOINS_PER_MINUTE` | `300` | Admissions par invitation par IP et par minute. |

Une valeur invalide empêche le démarrage. Un groupe derrière le même routeur ou une passerelle VPN qui traduit les adresses partage les limites par IP ; chaque onglet consomme une connexion. Les limites de stockage et de taille des documents continuent de s'appliquer. Les projets inactifs sortent du cache si nécessaire et restent stockés. Une connexion trop lente peut être fermée et reprendre ultérieurement, avec ses changements locaux conservés.

Pour exécuter un benchmark depuis les sources sur la machine à mesurer, utiliser Node.js 24 et installer les dépendances avec `npm ci`, puis :

```bash
npm run load:test -- --participants 50 --duration 10 --boards 1
npm run load:test -- --participants 100 --duration 10 --boards 10 --json /tmp/atelier-load.json
```

Le script ouvre un serveur éphémère avec des données temporaires et plusieurs identités indépendantes ; il n'accepte pas d'adresse de production. Il mesure le débit de confirmations, les latences p50/p95/p99, la mémoire du serveur et le retard de sa boucle d'événements, rapporte les refus et vérifie que tous les documents et l'état sauvegardé convergent. Il limite sa cadence à trois modifications par seconde et par participant, avec une seule modification en attente de confirmation par participant. Le fichier JSON permet de comparer les résultats après une modification des ressources ou du code.

### Mesures de cette livraison

Ces mesures ont été réalisées pour la V2.1.1 ; elles ne constituent pas de nouveaux essais de charge via le VPN. Chaque scénario ci-dessous a été exécuté une fois avec **Node.js 24.19, 4 vCPU et 16 Gio de mémoire**, en boucle locale. Le serveur utilise un processus séparé, mais le générateur partage sa machine. Les tableaux contiennent de petits objets ; l'envoi dure dix secondes, puis le script attend les confirmations restantes. Le débit inclut cette attente finale : les nombres de confirmations ne correspondent donc pas nécessairement à dix fois le débit indiqué.

| Participants / projets | Confirmations reçues | Confirmations/s | Latence p95 |
| --- | ---: | ---: | ---: |
| 50 / 1 | 1 117 | 109 | 537 ms |
| 100 / 1, limite de projet relevée pour le test | 602 | 49,8 | 4 275 ms |
| 100 / 10 | 2 976 | 296,6 | 69 ms |

La convergence de tous les clients, les modifications concurrentes de texte, les votes propres à chaque invité et la relecture de SQLite après redémarrage ont été vérifiés dans les trois scénarios. **Cent participants actifs sur un même projet saturent ce scénario** : la limite par défaut reste donc à cinquante connexions par projet. Répartir cent participants sur dix projets produit ici des latences nettement plus faibles. Ces mesures décrivent cet essai et cette machine ; cinquante connexions autorisées ne garantissent pas une latence donnée sur un autre serveur ou avec d'autres tableaux.

Pour reproduire le scénario de saturation sans modifier la configuration de production :

```bash
npm run load:test -- --participants 100 --duration 10 --boards 1 --board-limit 100
```

`--board-limit` change uniquement la limite du serveur éphémère du benchmark. Sans cette option, il conserve la limite par défaut ; une demande de cent connexions sur un projet entraîne alors des refus d'admission.

Ce scénario ne garantit pas que toute machine supporte le même nombre d'utilisateurs. La taille des documents, le nombre de projets, les images et la vitesse des connexions changent le coût réel. Suivre `docker stats`, les réponses `429`/`SERVER_BUSY`, la mémoire, le CPU et l'espace du volume avant de relever les limites. Le contrôle `/api/health` prouve que le processus et SQLite répondent ; il ne mesure pas la fluidité des participants.

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

Avec le profil VPN, reprendre le tableau `atelier_compose` de sa recette à la place des commandes `docker compose` ci-dessus, notamment pour `ps`, `stop` et `start`, avec le même nom de projet. Avec la recette HTTPS, remplacer les commandes `docker compose` ci-dessus par `docker compose --env-file .env.production -f docker-compose.yml -f deploy/compose.https.yml`, en gardant le même nom de projet. Caddy peut rester actif pendant l'arrêt temporaire de Node.

Conserver aussi les sources de la version utilisée et les fichiers privés `.env`, `.env.vpn` ou `.env.production` utilisés, dans un emplacement privé. Une copie des volumes Caddy permet de conserver les certificats lors d'un déplacement du serveur. La sauvegarde contient des données privées ; ne pas la publier dans GitHub. Vérifier qu'elle est lisible et tester périodiquement une restauration sur une installation séparée.

## Passer de la V2 ou V2.1 à la V2.2.0 hors ligne

Télécharger [atelier-board-v2-to-v2.2.sh](../releases/atelier-board-v2-to-v2.2.sh) sur une machine connectée, puis transférer ce **seul fichier** vers le serveur V2. Le projet de destination doit être `atelier-board` en version `2.0.x`, `2.1.x` ou `2.2.0` dans `package.json` ; aucun dépôt Git n'est requis.

Le script nécessite Bash et les outils courants `tar`, `gzip`, `base64`, `mktemp`, `awk`, `sed`, `sort`, `cmp`, `cp`, `mv`, `chmod`, `cat`, ainsi que `sha256sum` ou `shasum`. Il ne demande ni Git, ni Node.js, ni npm, ni Docker pour remplacer les sources.

1. Arrêter l'application V2 et sauvegarder son répertoire de données complet. Avec Docker, garder le nom de projet et appliquer la procédure précédente. Avec Node, arrêter le processus puis créer une archive :

```bash
umask 077
tar -czf /chemin/prive/atelier-data-v2.tar.gz -C /chemin/du/DATA_DIR .
```

2. Vérifier la destination et appliquer le code :

```bash
bash /chemin/atelier-board-v2-to-v2.2.sh --check /chemin/atelier-board
bash /chemin/atelier-board-v2-to-v2.2.sh /chemin/atelier-board
```

Le script vérifie le contenu embarqué avant remplacement et refuse les liens symboliques sur les chemins qu'il modifie. Il sauvegarde les sources remplacées dans un dossier privé voisin `.atelier-board-v2.2-backup-XXXXXX`, dont il affiche le chemin. Les nouveaux fichiers sont appliqués avec les autres sources ; `.git/`, `node_modules/`, `data/`, les bases SQLite et les fichiers `.env` privés, dont `.env.vpn`, restent conservés. Des modifications personnelles de fichiers sources remplacés restent dans cette sauvegarde : les revoir avant de les réappliquer.

Le script ne démarre aucun processus et ne modifie pas la base. Si le remplacement des fichiers échoue, il tente de restaurer les sources déjà remplacées. Le dossier de sauvegarde contient `files/`, `changes.tsv`, `new-files.list`, `created-directories.list`, `target.path` et un `README.txt` de restauration. Une sauvegarde de sources ne remplace pas la sauvegarde des données. Conserver le chemin affiché jusqu'à la validation de la nouvelle installation.

3. Choisir explicitement le mode d'exécution : le script ne modifie ni `.env` ni `.env.vpn` et ne configure pas automatiquement le réseau. Pour le serveur privé par VPN, exécuter `scripts/configure-vpn.sh --check IP_LOCALE_DU_SERVEUR 3000`, puis la même commande sans `--check`, et reprendre les commandes à deux fichiers Compose de la [recette VPN](#serveur-privé-accessible-par-vpn). Pour HTTP direct sans ce profil, utiliser `PUBLIC_URL=` et `TRUST_PROXY=0`, ainsi que `BIND_ADDRESS=0.0.0.0` ; une valeur `PUBLIC_URL=http://localhost:3000` héritée de la V2 doit être corrigée. Pour adopter Caddy, créer `.env.production` depuis son exemple. Garder le nom de projet Compose de l'ancienne installation dans tous les modes.
4. Reconstruire puis démarrer avec le profil choisi. Pour le profil VPN, utiliser les commandes de sa recette. Pour HTTP direct sans profil :

```bash
docker compose up -d --build
docker compose ps
curl http://localhost:3000/api/health
```

Pour HTTPS, utiliser les deux fichiers Compose et `.env.production` comme dans la première section. La construction peut utiliser Internet ; **seule l'application des modifications du code est garantie hors ligne**. Si la V2 tournait directement sous Node, importer d'abord son `DATA_DIR` dans le volume, selon la section suivante.

## Importer des données Node V2 ou restaurer une sauvegarde

Cette procédure cible un **volume Docker vide**. Garder l'ancien `DATA_DIR` ou l'ancien volume intact jusqu'à validation. Pour une restauration d'urgence, préparer une installation séparée ou un nouveau volume ; ne pas superposer une archive à une base déjà utilisée.

1. Arrêter le serveur d'origine et créer l'archive de tout son répertoire de données, comme ci-dessus.
2. Dans les sources V2.2.0, construire puis **créer sans démarrer** le service :

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

4. Démarrer avec les mêmes fichiers Compose et le même nom de projet. Vérifier la santé, ouvrir un projet existant, contrôler une image, puis connecter deux navigateurs pour valider la synchronisation. Pour le profil VPN, reprendre les options et le tableau `atelier_compose` de sa recette sur les commandes Compose des étapes 2 et 4 ; pour HTTPS, reprendre celles de la recette Caddy.

Le helper de copie utilise temporairement UID 0 pour restaurer les permissions ; le serveur tourne ensuite avec UID 1000. Si `PUBLIC_URL` est fixé, il doit correspondre à l'origine utilisée par les participants ; avec Caddy, renseigner `DOMAIN`. Le serveur V2.2.0 applique les migrations nécessaires au premier démarrage.

## Retour à une version antérieure

Un échec pendant l'application du script déclenche la restauration de ses fichiers sources. Pour restaurer manuellement les sources après une application réussie, arrêter le service et lire d'abord `README.txt` dans le dossier de sauvegarde. Vérifier `target.path` et `changes.tsv` : toute modification faite après la mise à jour doit être conservée séparément avant restauration.

Pour une destination restée inchangée depuis l'application du script :

```bash
atelier_source_backup="/chemin/.atelier-board-v2.2-backup-XXXXXX"
atelier_target="/chemin/atelier-board"
cp -a "$atelier_source_backup/files/." "$atelier_target/"
while IFS= read -r atelier_new_file; do
  test -n "$atelier_new_file" || continue
  rm -- "$atelier_target/$atelier_new_file"
done < "$atelier_source_backup/new-files.list"
```

Les anciens fichiers sont restaurés et les fichiers ajoutés par la mise à jour sont retirés ; les dossiers créés peuvent être laissés vides. Les données privées ne sont pas modifiées par cette restauration de sources.

Après un démarrage réussi de la V2.2.0, revenir aux sources V2 **ne garantit pas** la compatibilité avec une base déjà migrée. Pour un retour complet, garder le service arrêté, reprendre la configuration précédente et restaurer dans un volume vide la sauvegarde de données faite avant mise à jour.

Ne pas exécuter deux versions à la fois sur le même volume. Les changements effectués après la sauvegarde ne figurent pas dans cette sauvegarde ; conserver l'état actuel séparément avant un retour arrière. Une restauration de données et un redémarrage doivent rester des actions explicites, jamais des conséquences automatiques de l'application du script de sources.
