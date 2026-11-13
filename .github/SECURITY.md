# Politique de sécurité

## Signaler une vulnérabilité

Merci de **ne pas ouvrir de ticket public** pour une faille de sécurité. Utilisez le signalement privé de GitHub : onglet **Security** du dépôt, puis **Report a vulnerability**. Décrivez ce que vous avez observé, comment le reproduire et l'effet possible. Il s'agit d'un projet personnel : les réponses se font au mieux de la disponibilité de son auteur.

## Comment les secrets sont gérés

Vigie n'a besoin d'aucun secret pour démarrer. Trois couches utilisent des clés ou des comptes gratuits :

| Secret | Couche |
|---|---|
| `AISSTREAM_API_KEY` | Bateaux (aisstream.io) |
| `ATMO_USERNAME`, `ATMO_PASSWORD` | Qualité de l'air (Atmo Data) |
| `IDFM_PRIM_API_KEY` | Transports d'Île-de-France (PRIM) |

Règles appliquées dans le dépôt :

- **Les secrets passent uniquement par des variables d'environnement**, lues par le serveur (`server/src/`). Aucune clé n'est écrite dans le code, dans la documentation ni dans les exemples.
- **Le fichier `.env` n'est jamais versionné** : `.gitignore` exclut `.env` et `.env.*` (sauf le modèle vide [`.env.example`](../.env.example)), et `.dockerignore` les exclut de l'image Docker. Pour le créer, copier `.env.example`, remplir les valeurs et restreindre les droits (`chmod 600 .env`).
- **Les clés ne sortent jamais du serveur** : le navigateur ne les reçoit pas. Les appels aux sources qui demandent une clé sont faits par le serveur, qui ne renvoie que les données.
- **Saisie sans affichage** : la documentation de déploiement propose de saisir les clés avec `read -rs`, pour qu'elles n'apparaissent ni à l'écran ni dans l'historique du terminal.
- **Conteneur durci** : système de fichiers en lecture seule, aucun privilège (`cap_drop: ALL`, `no-new-privileges`), utilisateur non administrateur, mémoire et processeur bornés, port publié sur l'adresse choisie seulement (voir [docs/deploiement.md](../docs/deploiement.md)).

## Si une clé a été exposée

Révoquer immédiatement la clé auprès du fournisseur et en générer une nouvelle ; supprimer un secret d'un commit ne suffit pas, il reste dans l'historique git. Avant de contribuer, vérifier que `git status` ne contient aucun fichier `.env`.

## Données personnelles

Les données affichées sont des données ouvertes ; pour les prix de l'immobilier, des mesures empêchent la ré-identification des personnes (voir [docs/sources-et-licences.md](../docs/sources-et-licences.md)). Les accidents de la route sont servis sans donnée individuelle (ni âge ni sexe).
