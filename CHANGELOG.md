# Historique des versions

## 2.1.0

- Déploiement serveur Docker avec Node.js 24, utilisateur non privilégié, image applicative en lecture seule et volume de données persistant.
- Configuration Docker Compose pour accès HTTP local et configuration HTTPS avec Caddy, certificats automatiques et transmission des connexions WebSocket.
- Route de santé HTTP/SQLite pour suivre le démarrage et l'état du conteneur.
- Script Bash autonome pour appliquer les sources V2.1 à une V2 hors ligne, avec validation, sauvegarde privée des fichiers remplacés et restauration automatique si l'application des fichiers échoue.
- Procédures de mise à jour, sauvegarde et migration des données d'un serveur Node ou Docker V2. Les images Docker et dépendances restent téléchargeables lors de la construction.

## 2.0.0

- Projets privés, invitations sans compte et rôles propriétaire, éditeur et lecteur.
- Synchronisation Yjs par WebSocket, présence, reprise après déconnexion et brouillons de récupération.
- Persistance SQLite et images privées, imports et exports JSON/SVG.
- Quotas configurables de projets et de stockage, réessai explicite après dépassement et récupération des brouillons.
- Distribution publique sous licence MIT et script de création de la structure vide.
