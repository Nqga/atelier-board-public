# Collaboration — architecture de la V2

La V2 conserve les tableaux locaux de la V1 et ajoute un mode partagé. Un projet partagé appartient au serveur ; les clients manipulent un document Yjs, échangent ses modifications par WebSocket et attendent un accusé de réception durable. Les invitations permettent de rejoindre un projet sans compte ni mot de passe.

## Parcours et identité

`CollaborationClient` appelle les API sur la même origine que l'interface. Un visiteur choisit un nom de 1 à 80 caractères et reçoit une identité aléatoire, distincte de ce nom. Deux personnes portant le même nom restent deux participants différents.

Le serveur reconnaît cette identité grâce au cookie `atelier_session`, `HttpOnly`, `SameSite=Lax`, avec `Secure` en HTTPS. Une session dure 365 jours. Le nom, le rôle et les identifiants affichés dans le navigateur ne prouvent pas une identité : les contrôles du serveur utilisent la session et les droits enregistrés dans SQLite.

Les projets sont privés. Les rôles sont :

| Rôle | Accès |
| --- | --- |
| `viewer` | Consulter le projet et sa présence. |
| `editor` | Consulter et modifier le document, voter et ajouter des images. |
| `owner` | Modifier le document, gérer invitations et participants et supprimer le projet. |

Le partage d'un tableau local crée une copie serveur et ajoute son créateur comme propriétaire. L'original local reste disponible. Le fichier JSON portable décrit le contenu du tableau ; il ne contient pas de session ou de droits d'accès.

## Invitations

Un lien d'invitation contient une capacité aléatoire de 256 bits dans le fragment `#invite=…`. Le fragment n'est pas envoyé au serveur lors de la requête de navigation ; le client transmet ensuite le jeton dans le corps de la requête d'admission. La base conserve uniquement son empreinte SHA-256. Le jeton brut est remis lors de la création du lien et n'est pas récupérable en listant les invitations.

Le propriétaire choisit `editor` ou `viewer` et une durée de validité de 1 à 30 jours, sept jours par défaut. Les invitations peuvent être désactivées. Désactiver ou laisser expirer une invitation ferme les nouvelles admissions ; une personne déjà admise garde son rôle enregistré. Pour retirer cet accès, supprimer son appartenance au projet.

Le lien privé de gestion est une invitation `owner` de trente jours, créée explicitement par le propriétaire. Il sert à retrouver la gestion depuis une autre identité navigateur. Il donne les droits de gestion et doit être conservé comme un secret. Ce mécanisme ne fournit ni vérification d'adresse e-mail ni récupération automatique d'une identité perdue après expiration de tous ses liens.

## Modèle partagé

`dist/shared-model.js` convertit entre le document JSON validé et un `Y.Doc` avec deux racines :

```text
meta : Y.Map
  title : string
  description : string

objects : Y.Map<objectId, Y.Map>
  propriétés de l'objet : valeurs JSON
  text : Y.Text
  votes : Y.Map<userId, 0 | 1>
```

Les identifiants d'objets sont stables. Les propriétés sont indépendantes : modifier la couleur d'un objet et déplacer cet objet peuvent se combiner. Quand deux participants modifient le même champ simultanément, Yjs détermine la valeur retenue de façon identique chez tous les clients ; l'heure des appareils ne décide pas du résultat. Les textes sont des `Y.Text` : le client remplace seulement la partie modifiée, afin de fusionner les insertions et suppressions concurrentes.

Les votes sont séparés par participant, avec un vote par idée. Une suppression retire l'objet de la table Yjs ; une modification concurrente sur cet objet supprimé ne le recrée pas. Annuler une suppression est une restauration explicite produisant une nouvelle modification. Le serveur conserve les votes d'un objet supprimé dans la table SQLite `deleted_votes` pour valider leur restauration, y compris après un redémarrage, sans permettre de modifier les votes des autres participants.

`CollaborativeBoardStore` conserve les commandes utilisées par l'interface et expose un document JSON par `board`. Son `Y.UndoManager` suit les modifications d'origine locale et ignore les modifications reçues. L'historique est propre au client ouvert ; il n'est pas un journal global de toutes les actions du projet et ne survit pas au rechargement de la page.

Le `BoardStore` et `LocalBoardRepository` de la V1 continuent à gérer les tableaux non partagés, leur stockage local et la synchronisation entre onglets avec `BroadcastChannel`. Les opérations Lamport de ce mode local ne sont pas le protocole utilisé par les projets serveur.

## API HTTP

Les réponses sont JSON, sauf les images et les fichiers de l'interface. Les requêtes de mutation JSON portent `Content-Type: application/json`. L'interface utilise des cookies de même origine ; aucun jeton de session n'est placé dans l'URL WebSocket.

| Route | Fonction |
| --- | --- |
| `GET /api/session` | Disponibilité de la collaboration et identité courante. |
| `POST /api/session` | Créer une identité invitée avec `{ name }`. |
| `PATCH /api/session` | Modifier son nom avec `{ name }`. |
| `DELETE /api/session` | Fermer la session et ses connexions actives. |
| `GET /api/boards` | Lister les projets accessibles à la session. |
| `POST /api/boards` | Créer un projet à partir de `{ board }`. |
| `GET /api/boards/:id` | Lire le document, son état Yjs, son rôle et sa révision. |
| `DELETE /api/boards/:id` | Supprimer un projet, réservé au propriétaire. |
| `GET /api/boards/:id/members` | Lister les participants selon les droits du projet. |
| `PATCH /api/boards/:id/members/:userId` | Changer un rôle avec `{ role }`, réservé au propriétaire. |
| `DELETE /api/boards/:id/members/:userId` | Retirer un accès, réservé au propriétaire. |
| `GET /api/boards/:id/invitations` | Lister les invitations, sans leurs jetons bruts. |
| `POST /api/boards/:id/invitations` | Créer une invitation avec `{ role, expiresInDays }`. |
| `DELETE /api/boards/:id/invitations/:inviteId` | Désactiver une invitation. |
| `POST /api/invitations/join` | Admettre la session courante avec `{ token }`. |
| `POST /api/boards/:id/assets` | Envoyer une image binaire avec son type MIME. |
| `GET /api/boards/:id/assets/:assetId` | Lire une image du projet avec une session autorisée. |

Les opérations de gestion d'invitations appartiennent au propriétaire. Connaître un identifiant de projet ou une URL d'image ne suffit pas à accéder à un projet privé : le serveur vérifie son appartenance.

## WebSocket et confirmation durable

Chaque tableau utilise `/api/boards/:id/live`, en `ws:` pour le développement local et `wss:` derrière HTTPS. Le serveur vérifie la session, l'appartenance au projet et l'origine à la connexion. Les droits de modification sont aussi contrôlés pendant la vie de la connexion.

Les messages sont des objets JSON. Les états, différences et vecteurs Yjs sont des données binaires encodées en base64 :

| Sens | `type` | Contenu principal |
| --- | --- | --- |
| Serveur → client | `sync` | `state`, `vector`, `role`, `revision`, `updatedAt`, `users`. |
| Client → serveur | `update` | Identifiant `id` de la demande et différence Yjs `update`. |
| Serveur → client | `ack` | Identifiant accepté, `revision`, `updatedAt`. |
| Serveur → autres clients | `update` | Différence acceptée, `revision`, `updatedAt`. |
| Client → serveur | `presence` | `cursor`, `selection`, `editing`. |
| Serveur → clients | `presence` | Liste des présences `users`. |
| Serveur → client | `role` | Nouveau rôle. |
| Serveur → client | `error` | Code et message de refus. |

À l'ouverture ou à la reconnexion, le client fusionne l'état serveur dans son document ; il ne remplace pas sa copie avec un JSON distant. Il utilise le vecteur serveur pour renvoyer les changements manquants. Le serveur applique une mise à jour à un document candidat, valide la structure Yjs et le document complet, puis conserve le nouvel état avant de confirmer et de le diffuser. Les identifiants de demandes servent à reconnaître les répétitions.

L'état `synced` et `lastSaved` n'est atteint qu'après réception des accusés de réception et lorsqu'aucun changement local n'attend sa confirmation. Un message envoyé, une connexion ouverte ou une sauvegarde IndexedDB ne suffisent pas. Si l'accusé tarde, le client rétablit la connexion et reprend la synchronisation.

La présence est éphémère. Les curseurs et sélections utilisent les coordonnées du tableau, avec l'identité fournie par le serveur. Ils ne font pas partie du document, du stockage durable ou de l'historique d'annulation. La vue, le mode présentation et le minuteur restent personnels ; le minuteur n'est pas synchronisé.

## Déconnexion et cache de récupération

`IndexedDBCollaborationCache` conserve des snapshots Yjs dans la base `atelier-board:collaboration:v2`, avec une clé composée de l'identité invitée et du projet. Les écritures sont sérialisées afin qu'une sauvegarde ancienne ne remplace pas une sauvegarde récente. `cacheSaved` représente cette sauvegarde locale ; `lastSaved` représente la confirmation du serveur.

Au chargement d'un projet, le store restaure le cache avant d'ouvrir le WebSocket, puis fusionne les changements. La reconnexion est automatique, avec délai progressif et variation aléatoire. Il est possible de continuer à modifier un tableau déjà ouvert pendant une coupure réseau, si le droit local permet encore l'édition.

Les erreurs temporaires `SAVE_FAILED`, `RATE_LIMIT`, `SERVER_UNAVAILABLE` et `TEMPORARY_FAILURE` gardent les changements en attente et déclenchent une reconnexion avec délai progressif. Elles ne constituent pas une sauvegarde confirmée et ne bloquent pas définitivement le client.

Un refus définitif de validation ou d'accès suspend les modifications et les renvois automatiques, conserve une copie de récupération et affiche un état d'erreur ou d'accès refusé. Un client devenu lecteur ne renvoie pas son brouillon d'édition. Une copie refusée ou inaccessible est conservée séparément du document autorisé. Le retrait d'accès reste prioritaire sur les changements préparés hors ligne.

L'interface propose **Récupérer ma copie locale** puis **Exporter ma copie locale** pour sauvegarder ce brouillon comme JSON et l'importer dans un tableau local. Les images encore accessibles sont embarquées. Une image devenue inaccessible est remplacée par un texte **Image à réajouter** au même emplacement ; sa référence d'origine est conservée dans `recoveryImageSource`. Cette métadonnée ne donne aucun droit d'accès à l'image. Le JSON de récupération reste importable même après le retrait d'accès au projet. Le cache n'est pas supprimé automatiquement lors du refus.

La récupération dépend du stockage navigateur et de la même identité. Le cache n'est pas partagé entre navigateurs. Cette version ne fournit pas de service worker : elle ne garantit pas de démarrer ou de recharger l'application sans réseau. Exporter une copie avant de quitter en cas de cache indisponible ou d'erreur persistante.

## Stockage serveur et limites

SQLite est fourni par `node:sqlite` de Node.js 24. Le répertoire `DATA_DIR` contient :

- `atelier.sqlite` : utilisateurs, sessions, projets, appartenances, invitations, états Yjs, votes d'objets supprimés et métadonnées de mises à jour.
- Les fichiers temporaires SQLite `atelier.sqlite-wal` et `atelier.sqlite-shm` pendant l'exécution.
- `assets/` : images importées dans les projets, avec des noms générés côté serveur.

La base utilise le journal WAL, les clés étrangères et `synchronous=FULL`. Les changements acceptés produisent un état Yjs durable et une révision serveur. La révision permet de suivre les confirmations ; elle ne remplace pas les règles de fusion CRDT.

Le serveur valide les racines et types Yjs, refuse les structures incomplètes et les données non JSON, puis applique les limites du document. Une requête de création est limitée à 24 Mio, un document portable à 20 Mio, un projet à 3 000 objets et un champ texte à 20 000 caractères. Une mise à jour Yjs est limitée à 4 Mio et l'état Yjs complet à 32 Mio ; le transport limite les mises à jour à 120 par seconde par participant et la présence à 25 par seconde par connexion.

La base conserve les métadonnées de déduplication des mises à jour acceptées. Cette version ne fournit pas de politique automatique de purge de ce registre ni des images devenues inutilisées ; suivre l'espace disque disponible lors d'une exploitation prolongée.

Les images sont limitées à 5 Mio et aux signatures PNG, JPEG, WebP ou GIF ; les SVG importés ne sont pas admis. Les images du serveur sont rattachées à un projet et soumises à son contrôle d'accès. Les exports JSON et SVG embarquent ces images en données base64 pour ne pas dépendre des URL privées ou du cookie de leur auteur.

## Déploiement et portée

La V2 demande un processus Node.js 24 avec disque persistant et un proxy HTTPS compatible WebSocket. `PUBLIC_URL` doit désigner l'origine publique du site. `TRUST_PROXY` ne doit être activé que derrière un proxy de confiance, avec un accès direct au serveur fermé. Voir [README.md](README.md) et [.env.example](.env.example).

Cette implémentation fonctionne avec une seule instance serveur. Plusieurs processus n'ont pas de canal commun pour les documents en mémoire et les WebSockets. Une montée en charge horizontale demanderait un stockage et une coordination supplémentaires ; elle ne consiste pas à ajouter des réplicas sur le fichier SQLite actuel.

Le site statique V1 ne sert pas ce serveur. ChatGPT Sites déploie son code serveur dans Cloudflare Workers et propose D1/R2 ; cette implémentation Node/SQLite ne s'y publie pas telle quelle. La livraison du code V2 ne modifie pas automatiquement l'application V1 en ligne.

La sauvegarde serveur doit inclure la base et les images. Arrêter le processus puis copier `DATA_DIR` fournit une sauvegarde cohérente de cette installation. Les exports JSON servent à transporter des tableaux ; les identités, invitations et droits restent des données du serveur.
