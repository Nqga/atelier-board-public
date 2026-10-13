# Atelier Board — V2.1.1 collaborative et conteneurisée

Un tableau visuel web en français pour organiser des idées, les relier et voter. Les projets privés se partagent par invitation, sans compte à créer, avec synchronisation en temps réel entre navigateurs et appareils. La V2.1.1 permet l'accès direct à un serveur distant sur `http://ADRESSE_DU_SERVEUR:3000`, conserve la recette HTTPS Caddy et fournit un script autonome de mise à jour du code V2 hors ligne.

## Démarrer

Prérequis : **Node.js 24 ou plus récent**, qui fournit le moteur SQLite utilisé par le serveur.

```bash
git clone https://github.com/Nqga/atelier-board-public.git
cd atelier-board-public
npm ci
npm start
```

Ouvrir `http://localhost:3000`. Le serveur sert l'interface, les API, les images des projets et les connexions WebSocket. Il stocke les projets sur disque : ce n'est plus un simple serveur de fichiers statiques.

Les fichiers de l'interface et le module Yjs pour navigateur sont déjà présents dans `dist/`. `npm run build:vendor` sert à reconstruire ce module après une modification de ses dépendances ; il n'est pas nécessaire pour un démarrage normal.

## Travailler à plusieurs

Tous les participants doivent ouvrir l'adresse de la même installation, par exemple `http://ADRESSE_DU_SERVEUR:3000`. Chacun crée une identité invitée en choisissant son prénom ou pseudonyme ; il n'y a ni inscription par e-mail ni mot de passe.

1. Ouvrir un tableau local, puis utiliser **Partager**, choisir un prénom ou un pseudonyme et cliquer sur **Activer le partage**. Une copie du tableau devient un projet privé sauvegardé sur le serveur ; le tableau local est conservé.
2. Choisir **Modification** ou **Lecture**, puis **Créer un lien d'invitation** et **Copier**.
3. Envoyer ce lien aux personnes choisies. Chacune saisit son nom et clique sur **Rejoindre le tableau**, sans inscription.
4. Les participants voient les changements, les personnes présentes et leurs curseurs. Les éditeurs peuvent modifier le tableau ; les lecteurs peuvent le consulter.

Une invitation est valable sept jours par défaut, avec une validité d'un ou trente jours également disponible. Toute personne possédant le lien peut l'utiliser pendant cette période : le transmettre uniquement aux participants souhaités. Son expiration ou sa désactivation empêche de nouvelles admissions ; elle ne supprime pas l'accès des personnes déjà admises. Le propriétaire peut changer les droits d'un participant ou utiliser **Retirer l'accès** pour supprimer son accès.

L'identité d'un visiteur est attachée à un cookie de son navigateur. Dans **Retrouver la gestion du projet sur un autre appareil**, le propriétaire peut utiliser **Créer mon lien de gestion** et conserver ce **lien privé de récupération**, valable trente jours. Il permet de retrouver son accès depuis un autre navigateur ou après avoir effacé ses cookies. Ce lien donne le rôle propriétaire : il ne doit pas être distribué comme une invitation de participant. Le créer et le conserver avant de changer de navigateur.

Les tableaux de la V1 restent locaux jusqu'à leur partage explicite. Publier un tableau crée son projet partagé ; importer un export crée une copie. L'export JSON conserve un document modifiable et l'export SVG une image du tableau. Les images privées du projet sont embarquées dans ces exports pour que les fichiers restent utilisables hors de la session d'origine.

## Synchronisation et déconnexion

Les projets partagés utilisent Yjs : les modifications indépendantes se combinent et les textes des objets fusionnent caractère par caractère. Deux modifications simultanées d'une même position, couleur ou autre propriété suivent la résolution déterministe de Yjs. Une suppression concurrente empêche une simple modification de recréer l'objet. Annuler vise les modifications du participant qui utilise la commande.

Un tableau déjà ouvert reste éditable pendant une coupure réseau. Le navigateur conserve un brouillon de récupération dans IndexedDB et renvoie les changements à la reconnexion. L'interface distingue les changements en attente de ceux confirmés après stockage par le serveur. Une copie en cache n'est pas une confirmation de sauvegarde distante. L'ouverture initiale et le rechargement de l'application nécessitent le serveur ; cette version n'installe pas de service worker.

Le brouillon est associé au projet et à l'identité du visiteur : sa récupération suppose le même cookie et un stockage navigateur disponible. Une erreur temporaire de sauvegarde ou une limite de fréquence entraîne une nouvelle tentative automatique avec un délai progressif.

Si un quota de stockage est atteint, le client conserve le brouillon sans le déclarer synchronisé et suspend l'édition et les renvois automatiques. Libérer de la capacité, puis utiliser **Réessayer la synchronisation** ; les droits sont vérifiés à nouveau. Si l'accès est retiré ou si une modification est définitivement refusée, le client conserve une copie de récupération et arrête les envois. Utiliser **Récupérer ma copie locale**, puis **Exporter ma copie locale**, pour conserver un JSON à importer dans un tableau local, y compris lorsqu'un quota bloque la sauvegarde.

Les invités utilisent le même serveur que le propriétaire : démarrer l'application séparément sur plusieurs machines ne relie pas leurs projets.

L'export de récupération embarque les images encore accessibles. Quand une image privée ne peut plus être lue, il conserve sa position sous forme d'un texte **Image à réajouter** et garde son ancienne référence dans les métadonnées. Le JSON reste importable ; cette référence ne donne aucun accès à l'image d'origine. Avec le même cookie et le stockage navigateur conservé, rouvrir le lien du projet après un retrait d'accès permet aussi d'exporter la copie locale en lecture seule ; aucun changement n'est renvoyé au serveur.

## Fonctionnalités du tableau

- Déplacement libre, zoom centré sur le pointeur, pincement tactile, mini-carte et ajustement de la vue.
- Post-it, texte, formes, zones, connexions avec flèches, dessin libre, images et liens.
- Sélection multiple, déplacement, redimensionnement, duplication, copier/coller, suppression et annuler/rétablir.
- Votes, classement des idées, minuteur, présentation et raccourcis clavier.
- Plusieurs projets, recherche et modèles de brainstorming, rétrospective et kanban.
- Import et export JSON, export SVG.

Le canevas n'a pas de pages imposées. Le zoom est borné entre 2,5 % et 1 200 % pour conserver une navigation stable. Les imports sont limités à 3 000 objets, les images aux formats PNG, JPEG, WebP et GIF et à 5 Mo par fichier.

La vue, la sélection, le mode présentation et le minuteur sont propres à chaque participant. Le minuteur n'est pas synchronisé entre les navigateurs.

## Héberger la V2.1.1 avec Docker

Prérequis : un serveur avec **Docker Engine** et **Docker Compose** ; la recette HTTPS demande Compose **2.24.4 ou plus récent**. Node.js et npm restent dans l'image : ils ne sont pas nécessaires sur l'hôte. La construction peut télécharger l'image Node et les dépendances npm.

Pour publier sur une machine distante avec son adresse et le port `3000` :

```bash
cp .env.example .env
docker compose up -d --build
docker compose ps
curl http://localhost:3000/api/health
```

Dans `.env`, conserver `PORT=3000`, `BIND_ADDRESS=0.0.0.0`, `PUBLIC_URL=` et `TRUST_PROXY=0`. Ouvrir le port TCP `3000` dans le pare-feu du serveur et chez l'hébergeur ; si le serveur est derrière un routeur, prévoir aussi sa redirection de port. Tous les participants peuvent alors ouvrir **`http://ADRESSE_DU_SERVEUR:3000`**. Une adresse privée n'est joignable que depuis les réseaux qui y ont accès. `localhost` désigne l'appareil du visiteur, pas le serveur distant.

`PUBLIC_URL` vide utilise l'adresse réelle de la requête pour le contrôle d'origine. Il est aussi possible de fixer `PUBLIC_URL=http://ADRESSE_DU_SERVEUR:3000` si tout le monde utilise exactement cette adresse. **Lors d'une mise à jour, corriger l'ancien `.env` s'il contient `PUBLIC_URL=http://localhost:3000`** : le script hors ligne préserve ce fichier privé. Pour limiter l'écoute à l'hôte, utiliser `BIND_ADDRESS=127.0.0.1`.

En HTTP, les sessions et invitations circulent sans chiffrement. Pour une publication HTTPS, faire pointer son domaine vers le serveur, ouvrir les ports 80 et 443, puis, depuis la racine du projet :

```bash
cp .env.production.example .env.production
# Modifier DOMAIN dans .env.production, par exemple board.example.com.
docker compose --env-file .env.production -f docker-compose.yml -f deploy/compose.https.yml up -d --build
```

Caddy obtient le certificat HTTPS et transmet les connexions WebSocket à `atelier:3000`. Avec cette recette, seul Caddy publie des ports sur l'hôte. Le volume `atelier-data` conserve la base SQLite, les sessions, les invitations et les images. **Ne pas utiliser `docker compose down --volumes` pour une installation à conserver.**

Voir [deploy/DEPLOYMENT.md](deploy/DEPLOYMENT.md) pour les prérequis, la sauvegarde, la migration d'un serveur Node ou Docker V2 et le retour à une sauvegarde. Il faut garder le nom de projet Compose et le volume existants lors d'une mise à jour, ainsi que l'origine publique et les cookies pour conserver l'identité des visiteurs.

L'application utilise **une seule instance serveur**. Plusieurs réplicas partageraient un fichier SQLite sans synchroniser leurs documents en mémoire ou leurs connexions WebSocket. Le site statique V1 sur ChatGPT Sites demande un déploiement distinct : publier seulement `dist/` n'active pas la collaboration.

### Configuration

Pour une installation Node classique :

```bash
PORT=3000 DATA_DIR=./data PUBLIC_URL=https://board.example.com TRUST_PROXY=1 npm start
```

En HTTP direct, utiliser `HOST=0.0.0.0`, `PORT=3000`, `PUBLIC_URL=` et `TRUST_PROXY=0`. Configurer `TRUST_PROXY=1` uniquement derrière un proxy HTTPS de confiance, sans accès public direct au serveur Node. Le proxy doit transmettre `X-Forwarded-Proto` et les en-têtes WebSocket. Node ne charge pas automatiquement les fichiers `.env` : passer les variables au processus ou utiliser son option `--env-file`. Docker Compose utilise `.env` pour ses substitutions ; la recette HTTPS utilise explicitement `.env.production`.

| Variable | Usage |
| --- | --- |
| `PORT` | Port du serveur Node, `3000` par défaut. Avec Compose, port publié sur l'hôte ; le conteneur écoute sur `3000`. |
| `HOST` | Adresse d'écoute Node, `0.0.0.0` par défaut. |
| `BIND_ADDRESS` | Adresse de publication Docker sur l'hôte, `0.0.0.0` par défaut ; `127.0.0.1` pour un accès local seulement. |
| `DATA_DIR` | Données SQLite et images : `./data` avec Node, `/data` dans le volume Docker. |
| `PUBLIC_URL` | Origine publique autorisée, protocole et port compris, sans chemin. Vide en HTTP direct pour utiliser l'adresse de la requête ; la recette HTTPS la construit depuis `DOMAIN`. |
| `TRUST_PROXY` | `1` ou `true` derrière un proxy HTTPS de confiance ; `0` en HTTP direct. La recette Caddy fixe `1`. |
| `DOMAIN` | Domaine public sans protocole ni chemin, pour la recette HTTPS. |
| `MAX_BOARDS_PER_GUEST` | Projets créés et encore stockés par identité invitée, `20` par défaut. |
| `MAX_BOARD_STORAGE_MB` | État Yjs complet et images par projet, `100` par défaut. |
| `MAX_TOTAL_STORAGE_MB` | Ces mêmes données pour l'installation, `1024` par défaut. |

Les quotas sont des entiers strictement positifs. Une unité de stockage vaut **1 048 576 octets (1 Mio)** : les valeurs par défaut sont 100 Mio par projet et 1 Gio au total. Une configuration invalide empêche le démarrage.

### Vérifier un accès distant et une invitation

Depuis un autre appareil, ouvrir `http://ADRESSE_DU_SERVEUR:3000`, créer un tableau et activer son partage avec un pseudonyme. Créer un lien **Modification** et l'ouvrir dans un deuxième navigateur ou une fenêtre privée : choisir un autre pseudonyme, rejoindre, puis vérifier qu'un post-it créé ou modifié de chaque côté apparaît chez l'autre. Recharger les deux pages pour contrôler la persistance. Un lien **Lecture** doit permettre la consultation sans modification.

Le [guide de déploiement](deploy/DEPLOYMENT.md#diagnostiquer-les-erreurs-de-session-et-dorigine) distingue une session manquante (`401 SESSION_REQUIRED`) d'une mauvaise origine configurée (`403 ORIGIN_FORBIDDEN`). `GET /api/session` répond normalement `200` avec `user: null` avant le choix du pseudonyme.

### Vérifier la montée en charge

Le benchmark lance sa propre installation temporaire et simule des participants distincts. Il ne contacte pas le serveur de production et ne modifie pas ses données :

```bash
npm run load:test -- --participants 50 --duration 10 --boards 1
npm run load:test -- --participants 100 --duration 10 --boards 10 --json /tmp/atelier-load.json
```

Il mesure les confirmations de sauvegarde, les latences, la mémoire et le retard de la boucle serveur, et vérifie la convergence des participants et de l'état stocké. La limite d'admission par défaut est de **50 connexions par projet**, avec **500 connexions au total**. Ses résultats caractérisent la machine et le scénario testés ; ils ne garantissent pas une capacité identique avec de grands tableaux, beaucoup d'images ou des clients lents. Voir les [limites de déploiement](deploy/DEPLOYMENT.md#charge-et-limites-de-linstallation) et les [mesures de cette livraison](deploy/DEPLOYMENT.md#mesures-de-cette-livraison) avant d'augmenter la capacité.

## Appliquer la V2.1.1 hors ligne sur une V2

Télécharger une seule fois [releases/atelier-board-v2-to-v2.1.sh](releases/atelier-board-v2-to-v2.1.sh), puis transférer ce fichier vers la machine qui contient la V2. Il embarque les sources V2.1.1 : ni Git, ni Node, ni npm, ni accès réseau ne sont nécessaires pour appliquer les modifications.

Arrêter l'application et sauvegarder ses données avant de l'utiliser :

```bash
bash atelier-board-v2-to-v2.1.sh --check /chemin/atelier-board
bash atelier-board-v2-to-v2.1.sh /chemin/atelier-board
```

Le script accepte un projet `atelier-board` en version `2.0.x`, `2.1.0` ou `2.1.1`, vérifie l'archive et crée une sauvegarde privée des sources remplacées à côté du projet. Il conserve les fichiers `.env` privés, `data/`, `node_modules/` et `.git/`. Il ne démarre aucun serveur et ne lance ni migration de base, ni installation de dépendances. Pour l'accès HTTP distant, vérifier ensuite que l'ancien `.env` ne fixe plus `PUBLIC_URL` à `localhost` ou à une origine HTTPS qui n'est pas utilisée.

Si un fichier `SHA256SUMS` accompagne le script sur la page de version GitHub, le télécharger pour une vérification supplémentaire. Placer les deux fichiers dans le même dossier, puis lancer `sha256sum -c SHA256SUMS` depuis ce dossier. Le script reste autonome et contrôle également l'archive qu'il embarque.

**Le mode hors ligne concerne la mise à jour du code.** Construire ou démarrer Docker peut ensuite demander Internet pour télécharger des images et des dépendances. Le script n'est pas une sauvegarde des projets, sessions et images : suivre la [procédure de déploiement et de sauvegarde](deploy/DEPLOYMENT.md).

Pour régénérer le script depuis les sources V2.1.1, le mainteneur doit disposer de Git et Node.js. Le générateur utilise uniquement les fichiers de l'index Git, afin de laisser les fichiers locaux non suivis hors de l'archive. Indexer explicitement tout nouveau fichier source avant génération, par exemple avec `git add chemin/du/fichier`, puis :

```bash
npm run build:offline-update
```

Ces prérequis concernent la génération ; appliquer le script sur la machine de destination ne demande toujours ni Git ni Node.js.

Les modifications de cette version sont résumées dans [CHANGELOG.md](CHANGELOG.md).

## Quotas de stockage

Le serveur applique les quotas aux créations de projets, aux images et aux modifications synchronisées avant de les accepter. Un dépassement ne produit ni sauvegarde confirmée ni diffusion aux autres participants. La limite de projets reste liée au créateur d'origine : ajouter un autre propriétaire ou retirer ses droits ne transfère pas son quota.

Une image importée reste comptée après la suppression de son élément du tableau, afin que l'annulation puisse la restaurer. Supprimer le projet libère son état Yjs ; la capacité de ses images est libérée lorsque leur suppression sur disque réussit. Les fichiers restants après un échec sont conservés dans le comptage et leur nettoyage est retenté au prochain démarrage.

Si l'administrateur réduit les quotas, aucun projet existant n'est supprimé : les lectures, les suppressions et les modifications qui n'augmentent pas les données mesurées restent possibles.

Ces quotas mesurent l'état Yjs et les fichiers d'images, pas toute l'occupation du disque : les métadonnées, les journaux SQLite et l'espace physique de la base sont distincts. Une suppression ne réduit pas nécessairement la taille physique de SQLite. Prévoir une limite et une surveillance du disque chez l'hébergeur.

Tout visiteur peut créer une nouvelle identité invitée. Effacer ses cookies ou utiliser un autre navigateur contourne donc la limite par identité ; le quota global de l'installation reste appliqué. Ces limites ne remplacent pas une gestion des abus ou une protection contre le déni de service pour un service ouvert au grand public.

Pour sauvegarder une installation, arrêter proprement le serveur puis copier **tout le répertoire `DATA_DIR`**, qui contient `atelier.sqlite` et le répertoire `assets/`. Restaurer ce répertoire avant de redémarrer. Le cache des navigateurs ne remplace pas cette sauvegarde.

## Recréer la structure vide

Le script Bash [scripts/create-structure.sh](scripts/create-structure.sh) recrée tous les dossiers et noms de fichiers du projet dans une nouvelle destination, avec **chaque fichier vide**, y compris les fichiers cachés et le script lui-même. Il fonctionne seul, sans Git, Node.js ni installation de dépendances.

```bash
bash scripts/create-structure.sh ./atelier-board-squelette
```

Sans argument, la destination est `./atelier-board-squelette`, relative au dossier courant. Le script refuse une destination existante. Il crée seulement la structure des sources : le squelette obtenu ne contient pas de code et ne lance pas l'application. Les données d'exécution, `.git/`, `data/` et `node_modules/` ne sont pas créés.

## Vérifier et comprendre le code

```bash
npm test
npm run check
```

Les tests vérifient le store local, le modèle partagé et les échanges serveur, notamment la convergence, les autorisations et la reprise après coupure. Voir [COLLABORATION.md](COLLABORATION.md) pour l'architecture, le protocole et les limites.

| Fichier | Rôle |
| --- | --- |
| `dist/index.html`, `dist/styles.css` | Interface et styles. |
| `dist/app.js`, `dist/dialogs.js` | Interactions du tableau, projets et invitations. |
| `dist/store.js` | Tableaux locaux et validation des documents. |
| `dist/shared-model.js` | Conversion entre document portable et structures Yjs. |
| `dist/collaboration.js`, `dist/collab-store.js` | API de partage, transport WebSocket et historique des modifications partagées. |
| `dist/collab-cache.js` | Brouillons de récupération dans IndexedDB. |
| `dist/vendor/` | Yjs pour navigateur et licences associées. |
| `dist/templates.js`, `dist/export.js` | Modèles et exports. |
| `server.mjs`, `server/` | API, WebSocket, contrôle d'accès, SQLite et fichiers. |
| `Dockerfile`, `docker-compose.yml`, `deploy/` | Conteneur, HTTPS et procédures de déploiement. |
| `scripts/build-offline-update.mjs`, `releases/` | Construction et distribution du script autonome de mise à jour. |
| `scripts/load-test.mjs` | Benchmark isolé avec plusieurs participants et contrôle de convergence. |

## Licence

Le projet est distribué sous [licence MIT](LICENSE), qui autorise sa réutilisation, sa modification et sa redistribution, y compris commerciales, en conservant la notice de copyright et le texte de la licence.

Les bibliothèques tierces conservent leurs licences propres. Les notices de Yjs, lib0 et isomorphic.js intégrées au module navigateur sont réunies dans [dist/vendor/LICENSES.txt](dist/vendor/LICENSES.txt) ; les dépendances installées par npm fournissent également leurs notices dans leurs paquets.
