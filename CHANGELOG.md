# Historique des versions

## 2.2.0

- Profil Docker Compose pour serveur privé accessible par un VPN déjà installé : publication sur une IPv4 locale choisie et un port configurable, sans conserver la publication sur toutes les interfaces.
- Script Bash `scripts/configure-vpn.sh` avec vérification de l'IP assignée au serveur Linux, contrôle sans écriture, configuration privée `.env.vpn`, conservation des autres paramètres et sauvegarde d'une configuration VPN précédente.
- Guide pour préserver le nom de projet Compose, le volume, les sessions et les liens d'invitation ; le tunnel reste configuré séparément et `TRUST_PROXY=0` en HTTP direct.
- Script autonome `releases/atelier-board-v2-to-v2.2.sh` pour appliquer les sources V2.2 hors ligne sur V2 ou V2.1, avec sauvegarde des sources remplacées et conservation des données et configurations privées. Aucun démarrage ni changement automatique de configuration réseau.
- Les configurations HTTP direct et HTTPS Caddy restent disponibles. Les images Docker et dépendances ne sont pas embarquées dans la mise à jour hors ligne.

## 2.1.1

- Accès HTTP distant sur `0.0.0.0:3000` par défaut avec Docker Compose ; adresse d'écoute configurable et contrôle d'origine basé sur l'adresse utilisée lorsque `PUBLIC_URL` est vide.
- Documentation du parcours à deux navigateurs : création d'une identité invitée, partage par lien, synchronisation et persistance ; diagnostic distinct des erreurs `401 SESSION_REQUIRED` et `403 ORIGIN_FORBIDDEN`.
- Limites configurables de connexions et de tableaux actifs, cache de documents borné, refus temporaire de surcharge et regroupement des notifications de présence.
- Benchmark reproductible sur une installation locale temporaire, avec mesures des confirmations, latences, mémoire et convergence.
- Script de mise à jour hors ligne actualisé pour appliquer la V2.1.1 sur une V2 ou une V2.1.0, en préservant les données et la configuration privée. Une ancienne valeur `PUBLIC_URL=http://localhost:3000` doit être corrigée pour l'accès distant.

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
