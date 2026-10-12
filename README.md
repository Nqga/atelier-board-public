# Atelier Board — V2 collaborative

Un tableau visuel web en français pour organiser des idées, les relier et voter. La V2 ajoute des projets privés partagés par invitation, sans compte à créer, avec synchronisation en temps réel entre navigateurs et appareils.

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

1. Ouvrir un tableau local, puis utiliser **Partager**, choisir un prénom ou un pseudonyme et cliquer sur **Activer le partage**. Une copie du tableau devient un projet privé sauvegardé sur le serveur ; le tableau local est conservé.
2. Choisir **Modification** ou **Lecture**, puis **Créer un lien d'invitation** et **Copier**.
3. Envoyer ce lien aux personnes choisies. Chacune saisit son nom et clique sur **Rejoindre le tableau**, sans inscription.
4. Les participants voient les changements, les personnes présentes et leurs curseurs. Les éditeurs peuvent modifier le tableau ; les lecteurs peuvent le consulter.

Une invitation est valable sept jours par défaut, avec une validité d'un ou trente jours également disponible. Toute personne possédant le lien peut l'utiliser pendant cette période : le transmettre uniquement aux participants souhaités. Son expiration ou sa désactivation empêche de nouvelles admissions ; elle ne supprime pas l'accès des personnes déjà admises. Le propriétaire peut changer les droits d'un participant ou utiliser **Retirer l'accès** pour supprimer son accès.

L'identité d'un visiteur est attachée à un cookie de son navigateur. Dans **Retrouver la gestion du projet sur un autre appareil**, le propriétaire peut utiliser **Créer mon lien de gestion** et conserver ce **lien privé de récupération**, valable trente jours. Il permet de retrouver son accès depuis un autre navigateur ou après avoir effacé ses cookies. Ce lien donne le rôle propriétaire : il ne doit pas être distribué comme une invitation de participant. Le créer et le conserver avant de changer de navigateur.

Les tableaux de la V1 restent locaux jusqu'à leur partage explicite. Publier un tableau crée son projet partagé ; importer un export crée une copie. L'export JSON conserve un document modifiable et l'export SVG une image du tableau. Les images privées du projet sont embarquées dans ces exports pour que les fichiers restent utilisables hors de la session d'origine.

## Synchronisation et déconnexion

Les projets partagés utilisent Yjs : les modifications indépendantes se combinent et les textes des objets fusionnent caractère par caractère. Deux modifications simultanées d'une même position, couleur ou autre propriété suivent la résolution déterministe de Yjs. Une suppression concurrente empêche une simple modification de recréer l'objet. Annuler vise les modifications du participant qui utilise la commande.

Un tableau déjà ouvert reste éditable pendant une coupure réseau. Le navigateur conserve un brouillon de récupération dans IndexedDB et renvoie les changements à la reconnexion. L'interface distingue les changements en attente de ceux confirmés après stockage par le serveur. Une copie en cache n'est pas une confirmation de sauvegarde distante. L'ouverture initiale et le rechargement de l'application nécessitent le serveur ; cette V2 n'installe pas de service worker.

Le brouillon est associé au projet et à l'identité du visiteur : sa récupération suppose le même cookie et un stockage navigateur disponible. Une erreur temporaire de sauvegarde ou une limite de fréquence entraîne une nouvelle tentative automatique avec un délai progressif. Si l'accès est retiré ou si une modification est définitivement refusée, le client conserve une copie de récupération et arrête les envois. Utiliser **Récupérer ma copie locale**, puis **Exporter ma copie locale**, pour conserver un JSON à importer dans un tableau local. Les invités utilisent le même serveur que le propriétaire : démarrer l'application séparément sur plusieurs machines ne relie pas leurs projets.

L'export de récupération embarque les images encore accessibles. Quand une image privée ne peut plus être lue, il conserve sa position sous forme d'un texte **Image à réajouter** et garde son ancienne référence dans les métadonnées. Le JSON reste importable ; cette référence ne donne aucun accès à l'image d'origine.

## Fonctionnalités du tableau

- Déplacement libre, zoom centré sur le pointeur, pincement tactile, mini-carte et ajustement de la vue.
- Post-it, texte, formes, zones, connexions avec flèches, dessin libre, images et liens.
- Sélection multiple, déplacement, redimensionnement, duplication, copier/coller, suppression et annuler/rétablir.
- Votes, classement des idées, minuteur, présentation et raccourcis clavier.
- Plusieurs projets, recherche et modèles de brainstorming, rétrospective et kanban.
- Import et export JSON, export SVG.

Le canevas n'a pas de pages imposées. Le zoom est borné entre 2,5 % et 1 200 % pour conserver une navigation stable. Les imports sont limités à 3 000 objets, les images aux formats PNG, JPEG, WebP et GIF et à 5 Mo par fichier.

La vue, la sélection, le mode présentation et le minuteur sont propres à chaque participant. Le minuteur n'est pas synchronisé entre les navigateurs.

## Héberger la V2

Il faut un hébergement capable d'exécuter **un processus Node.js 24**, d'accepter les connexions **WebSocket** et de conserver un **disque persistant**. L'interface et le serveur doivent être servis sur la même origine. En production, placer le serveur derrière un proxy HTTPS qui transmet les connexions WebSocket et les cookies.

La V1 publiée sur ChatGPT Sites sert des fichiers statiques. L'architecture Node.js/SQLite de la V2 demande un serveur distinct ; publier seulement `dist/` n'active pas la collaboration. Le déploiement de cette V2 ne remplace donc pas automatiquement l'ancien site.

Le fichier [.env.example](.env.example) décrit la configuration du serveur. Pour une installation Node classique, utiliser par exemple :

```bash
PORT=3000 DATA_DIR=./data PUBLIC_URL=https://board.example.com TRUST_PROXY=1 npm start
```

Configurer `TRUST_PROXY=1` uniquement quand l'application est accessible au travers d'un proxy de confiance qui termine HTTPS. Le proxy doit transmettre `X-Forwarded-Proto` et les en-têtes `Upgrade`/`Connection` de WebSocket. Le serveur ne doit pas être directement exposé à côté de ce proxy.

| Variable | Usage |
| --- | --- |
| `PORT` | Port HTTP interne, `3000` par défaut. |
| `HOST` | Adresse d'écoute, `0.0.0.0` par défaut. |
| `DATA_DIR` | Répertoire persistant des données SQLite et images des projets, `./data` par défaut. |
| `PUBLIC_URL` | Origine publique utilisée pour les invitations et le contrôle d'origine, par exemple `https://board.example.com`. |
| `TRUST_PROXY` | `1` ou `true` derrière un proxy HTTPS de confiance ; `0` en accès HTTP local. |

Une recette Docker est fournie dans [Dockerfile](Dockerfile) et [docker-compose.yml](docker-compose.yml). Le volume `atelier-data` conserve les données après un redémarrage ou une recréation du conteneur. Les fichiers `.env` ne sont pas ajoutés à Git. Node ne les charge pas automatiquement : les passer via l'environnement du processus ou utiliser l'option Node `--env-file` ; Docker Compose lit `.env` pour ses substitutions.

```bash
cp .env.example .env
docker compose up --build -d
```

La recette publie le port sur `127.0.0.1` pour un accès local ou un proxy installé sur le même hôte. Avant de la rendre publique, modifier `PUBLIC_URL` et `TRUST_PROXY` dans `.env` puis configurer le proxy HTTPS. Un proxy exécuté dans un autre conteneur peut joindre le service `atelier:3000` sur le même réseau Compose. Ne pas supprimer le volume avec `docker compose down --volumes` si les projets doivent être conservés.

Cette version utilise **une seule instance serveur**. Ne pas lancer plusieurs réplicas partageant le même fichier SQLite : leurs connexions WebSocket et documents en mémoire ne se synchronisent pas entre processus. Prévoir une architecture de coordination et de stockage adaptée avant une montée en charge horizontale.

Pour sauvegarder une installation, arrêter proprement le serveur puis copier **tout le répertoire `DATA_DIR`**, qui contient `atelier.sqlite` et le répertoire `assets/`. Restaurer ce répertoire avant de redémarrer. Le cache des navigateurs ne remplace pas cette sauvegarde.

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
