# Collaboration — architecture de la V2.1

La V2.1 conserve les tableaux locaux de la V1 et le mode partagé de la V2 ; elle ajoute les recettes de déploiement conteneurisé et de mise à jour du code hors ligne. Un projet partagé appartient au serveur ; les clients manipulent un document Yjs, échangent ses modifications par WebSocket et attendent un accusé de réception durable. Les invitations permettent de rejoindre un projet sans compte ni mot de passe.

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
| `GET /api/health`, `HEAD /api/health` | Santé du processus et de sa connexion SQLite ; sans session, avec la version du serveur. |
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

L'erreur `QUOTA_EXCEEDED` conserve le brouillon, suspend l'édition et place le client dans l'état `quota`, sans confirmation de sauvegarde ni nouvelles tentatives automatiques. Après avoir libéré de la capacité, **Réessayer la synchronisation** rétablit la connexion, vérifie de nouveau les droits et propose les changements manquants. Le refus ne donne aucun droit supplémentaire : un accès retiré ou devenu lecteur empêche toujours le renvoi du brouillon. L'export de récupération reste disponible pendant ce blocage.

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

La base conserve les métadonnées des 1 000 dernières demandes de mise à jour acceptées par projet pour leur déduplication. Yjs reconnaît également les structures déjà intégrées lorsqu'une ancienne différence est renvoyée. Les images devenues inutilisées dans le tableau ne sont pas automatiquement purgées, afin de conserver la possibilité d'annuler une suppression.

Les images sont limitées à 5 Mio et aux signatures PNG, JPEG, WebP ou GIF ; les SVG importés ne sont pas admis. Les images du serveur sont rattachées à un projet et soumises à son contrôle d'accès. Les exports JSON et SVG embarquent ces images en données base64 pour ne pas dépendre des URL privées ou du cookie de leur auteur.

### Quotas

Trois quotas complètent les limites de taille et de fréquence :

| Configuration | Valeur par défaut | Données comptées |
| --- | --- | --- |
| `MAX_BOARDS_PER_GUEST` | `20` | Projets créés par une identité invitée et encore stockés, quel que soit son rôle actuel. |
| `MAX_BOARD_STORAGE_MB` | `100` | Octets de l'état Yjs complet et des fichiers d'images du projet. |
| `MAX_TOTAL_STORAGE_MB` | `1024` | Ces mêmes données pour toute l'installation. |

Les variables sont des entiers strictement positifs ; une valeur invalide arrête le démarrage. L'unité des variables `*_MB` est binaire : 1 Mio = 1 048 576 octets. Les valeurs par défaut représentent 100 Mio par projet et 1 Gio au total. Pour utiliser `createAtelierServer(options)` directement, `options.quotas` expose `maxBoardsPerGuest`, `maxBoardBytes` et `maxStorageBytes` ; les deux derniers sont exprimés en octets.

Le créateur est enregistré de façon immuable et reste utilisé pour le quota de projets quand les droits changent. Rejoindre un projet existant ne consomme pas le quota de projets du participant. Lors de la migration d'une base V2 antérieure à ces quotas, le propriétaire le plus ancien encore enregistré devient le créateur retenu pour ce comptage.

Les créations et les images sont vérifiées avant acceptation. Une limite de projets produit une réponse HTTP `409`, une limite de stockage une réponse `413`, avec le code `QUOTA_EXCEEDED`. Une modification WebSocket est appliquée à un candidat et mesurée avant sa persistance ; un dépassement produit `{ type: 'error', code: 'QUOTA_EXCEEDED', id, message }`, sans `ack`, sans changement de l'état serveur et sans diffusion. Les données en cours d'enregistrement sont réservées afin que des envois concurrents ne puissent pas consommer la même capacité disponible.

Réduire les quotas ne supprime aucune donnée existante. Un projet déjà au-dessus d'une limite reste lisible et supprimable ; les mises à jour qui n'augmentent pas les données mesurées restent admissibles. Le comptage porte sur l'état Yjs complet, qui peut conserver des structures supprimées : réduire le nombre d'objets visibles ne garantit donc pas une réduction de sa taille.

Une image reste comptée jusqu'à la suppression du projet, même quand son élément n'est plus visible. La suppression du projet libère la taille de son état ; ses images et d'éventuels fichiers résiduels restent comptés jusqu'à la réussite de leur suppression physique. Les réservations et restes d'une suppression échouée sont conservés durablement et le nettoyage est retenté au démarrage. Des fichiers ordinaires inconnus dans le stockage d'images sont conservés et comptés plutôt que supprimés sans preuve de leur origine.

Ces quotas ne représentent pas la taille complète de `DATA_DIR` : ils n'incluent pas les métadonnées, les journaux SQLite ni l'espace physique de la base. Prévoir la surveillance et les limites de disque de l'hébergeur. Le quota par invité n'est pas une limite par personne vérifiée : une nouvelle identité navigateur peut le contourner, tandis que le quota global reste appliqué. Ce mécanisme ne constitue pas une protection contre les abus ou le déni de service.

## Déploiement et portée

La V2.1 demande un processus Node.js 24 avec disque persistant et un proxy HTTPS compatible WebSocket. `PUBLIC_URL` doit désigner l'origine publique du site. `TRUST_PROXY` ne doit être activé que derrière un proxy de confiance, avec un accès direct au serveur fermé. Voir [README.md](README.md), [.env.example](.env.example) et [deploy/DEPLOYMENT.md](deploy/DEPLOYMENT.md).

Cette implémentation fonctionne avec une seule instance serveur. Plusieurs processus n'ont pas de canal commun pour les documents en mémoire et les WebSockets. Une montée en charge horizontale demanderait un stockage et une coordination supplémentaires ; elle ne consiste pas à ajouter des réplicas sur le fichier SQLite actuel.

Le site statique V1 ne sert pas ce serveur. ChatGPT Sites déploie son code serveur dans Cloudflare Workers et propose D1/R2 ; cette implémentation Node/SQLite ne s'y publie pas telle quelle. La livraison du code V2.1 ne modifie pas automatiquement l'application V1 en ligne.

La sauvegarde serveur doit inclure la base et les images. Arrêter le processus puis copier `DATA_DIR` fournit une sauvegarde cohérente de cette installation. Les exports JSON servent à transporter des tableaux ; les identités, invitations et droits restent des données du serveur.

La recette Docker exécute le serveur avec l'utilisateur `node` (UID/GID 1000), un système de fichiers applicatif en lecture seule et un volume `/data` modifiable. Le contrôle de santé consulte SQLite sans créer d'identité ni transmettre de cookie. La recette HTTPS ajoute Caddy sur le même réseau ; le port Node n'est alors pas publié sur l'hôte. Le journal et les images restent dans le volume `atelier-data`, pas dans l'image.

Le script `releases/atelier-board-v2-to-v2.1.sh` remplace uniquement les sources qu'il embarque. Il fonctionne sans réseau, sans Git et sans Node, sauvegarde les fichiers remplacés et préserve les données et les fichiers `.env` privés. Il ne démarre pas l'application : les migrations SQLite éventuelles s'exécutent seulement au prochain démarrage du serveur. Revenir aux anciennes sources n'annule pas une migration ; pour un retour complet, arrêter le serveur et restaurer la sauvegarde de données correspondante. Les images Docker et dépendances npm ne sont pas intégrées à ce script.
