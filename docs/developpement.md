# Développement

## Prérequis

- **Node 24** et **pnpm 12** (le `server/Dockerfile` utilise `node:24.22` et `pnpm@12.8.1`) ;
- **Rust 1.94 ou plus récent** (édition 2024 ; le Dockerfile compile avec `rust:1.94`) ; aucun composant particulier n'est requis ;
- aucune clé d'API pour démarrer : les couches qui en demandent sont simplement désactivées (voir [deploiement.md](deploiement.md#variables-denvironnement)).

## Démarrer en deux commandes

```bash
cd server && cargo run --release     # terminal 1 : API sur http://127.0.0.1:8787
cd web && pnpm install && pnpm dev   # terminal 2 : site sur http://localhost:5173
```

Le serveur de développement de Vite transmet `/api` au serveur Rust (voir `web/vite.config.ts`). Premier démarrage, données téléchargées, autres commandes :

**Au premier démarrage, le serveur télécharge ses données**, environ 350 Mo rangés dans `data/` :
- les horaires SNCF ;
- les voies ferrées OpenStreetMap, en 14 fichiers ;
- les altitudes du relief.

Comptez quelques minutes. Le service Overpass, qui fournit les voies OSM, est gratuit et souvent saturé : le serveur réessaie tout seul en espaçant ses tentatives. Pendant ce temps, la carte fonctionne déjà, avec des trains en ligne droite. Les démarrages suivants prennent quelques secondes.

Sans le serveur, la carte s'ouvre quand même. Seule la couche des trains affiche une erreur.

Autres commandes :
- `pnpm typecheck` et `pnpm build` dans `web/` ; après `pnpm build`, le serveur sert aussi le site construit (`web/dist`) à sa racine, sur http://127.0.0.1:8787/ ;
- `cargo test` et `cargo clippy` dans `server/`.

En développement, la carte est accessible depuis la console du navigateur via `window.__carte` (`map`, `overlay`, `clock`, `manager`).

### Utiliser un serveur installé ailleurs

Le site peut interroger un serveur qui tourne sur une autre machine, sans lancer Rust localement :

```bash
cd web
CARTE_API=http://192.168.0.75:8787 pnpm dev
```

## Vérifications avant de proposer un changement

| Où | Commande | Ce que ça vérifie |
|---|---|---|
| `web/` | `pnpm typecheck` | Types TypeScript (`tsc --noEmit`, mode strict). |
| `web/` | `pnpm build` | Typage puis construction de production (`dist/`). |
| `server/` | `cargo test` | Tests unitaires du serveur (RAPTOR, isochrones multimodales, historique, tuiles, rapprochement SIRI, accidents, monuments…). Les mesures sur de vrais fichiers sont marquées `#[ignore]` : elles demandent des téléchargements et des variables d'environnement décrites dans leurs commentaires. |
| `server/` | `cargo clippy` | Lints. Le code n'est pas encore exempt d'avertissements : ils ne bloquent pas l'intégration continue. |

`cargo fmt` n'est pas imposé : le code n'est pas formaté avec `rustfmt` (lignes longues volontaires), et le reformater en bloc brouillerait l'historique.

L'intégration continue (`.github/workflows/ci.yml`) rejoue `pnpm typecheck`, `pnpm build` et `cargo test` à chaque push et pull request.

## Dépendances : le délai de 24 heures

Les dépendances doivent avoir été publiées depuis plus de 24 heures. La machine du projet applique la règle de pnpm sur l'âge minimal des versions (`minimumReleaseAge`) : une version trop récente est refusée à l'installation. **Il ne faut pas contourner cette règle par une exemption** (liste d'exclusion ajoutée à la configuration pour « débloquer » un paquet) : si l'installation échoue pour cette raison, on attend ou on choisit la version précédente. Les versions des paquets du site sont fixées (`~` pour MapLibre, deck.gl, etc.) et le fichier `pnpm-lock.yaml` est versionné : l'intégration continue installe avec `--frozen-lockfile`.

## Approche de contrôle qualité

Le projet est développé sans suite de tests de bout en bout dans le dépôt. La vérification se fait en trois temps :

1. **Tests unitaires Rust** sur la logique la plus fragile (algorithmes d'itinéraires, codage de l'historique, généralisation des tuiles, rapprochement SIRI → GTFS, nettoyage des données), avec des jeux d'essai réduits dans `server/src/testdata/` et `server/src/fixtures/`.
2. **Mesures sur les vraies données** avant de documenter un chiffre : tests `#[ignore]` pour la mémoire et le temps (voir les mesures chiffrées dans les documents de ce dossier), `/usr/bin/time -l` pour le pic de mémoire d'un processus.
3. **Contrôle visuel dans un navigateur sans écran** (Chrome piloté par `playwright-core`, `--use-angle=metal --ignore-gpu-blocklist`) : chaque nouvelle couche est ouverte sur des vues précises (l'adresse de la page décrit tout : vue, couches, réglages, instant), avec une capture d'écran regardée avant de valider. Les scripts de ces contrôles ne sont pas versionnés ; c'est ainsi que sont produites les images de [`docs/images/`](images/).

Les mesures de performance du rendu (temps d'image, temps processeur par image sur des vues fixes) sont dans [`perf/`](../perf/) : `bench.mjs`, `echelle.mjs` et `exp.mjs` sont les scripts, les `resultats-*.json` leurs résultats (voir [rendu-3d.md](rendu-3d.md#performances)). Ces scripts importent un petit utilitaire local (`qa-lib.mjs`) qui n'est pas versionné : ils servent de trace des mesures, pas d'outil prêt à l'emploi.

## Console du navigateur

En développement, `window.__tour` donne en plus la main sur la visite guidée (`window.__tour.next()`…). Ces accès n'existent pas dans le site construit.

## Ajouter une couche

Pas à pas dans [architecture.md](architecture.md#ajouter-une-couche) (côté site) et [moteur-de-tuiles.md](moteur-de-tuiles.md#ajouter-un-jeu-de-données) (côté serveur, pour un gros jeu de données). Une couche doit aussi déclarer sa source et sa licence : ajouter une ligne à [sources-et-licences.md](sources-et-licences.md) et au tableau de [couches.md](couches.md).
