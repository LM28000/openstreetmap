# Carte vivante

Une carte 3D interactive de la France, avec des couches de données en temps réel : trains, météo, énergie, séismes…
Projet personnel pour apprendre.

## Utiliser la carte

Le serveur maison sert la carte en permanence, sur le réseau de la maison : **http://192.168.0.75:8787/**. Aucun programme n'a besoin de tourner sur l'ordinateur qui l'affiche.

L'écran a quatre zones fixes. Au repos, elles couvrent moins de 15 % de la carte.
- **En haut à gauche, la recherche** (`⌘K` ou `/`) trouve d'une seule barre :
  - une ville ou une adresse (géocodage de l'IGN) ;
  - une gare et ses départs ;
  - un train par son numéro ;
  - un vol, un navire, une ligne de bus ;
  - une station de vélos, une borne, une couche, une scène ;
  - une date (« demain 8h », « il y a 2 h », « direct »).
- **Sous la recherche, les pastilles des couches affichées.** Un clic ouvre leurs réglages, la croix les masque. Le bouton « Couches » ouvre le catalogue, avec un filtre et cinq scènes prêtes à l'emploi : Ce qui bouge, Météo, Qualité de l'air, Énergie, Ma ville.
- **À droite, la fiche de l'objet choisi.** Elle montre :
  - le type ;
  - un statut : en direct, rejoué, estimé ou prévu ;
  - trois chiffres clés ;
  - le détail ;
  - les actions : Suivre, Partager, Source.
- **En bas, la frise du temps.** Elle couvre de −7 jours à +2 jours, avec les bandes de jour et de nuit, la vitesse et des sauts rapides.

L'adresse de la page garde tout : la vue, les couches, les réglages, l'instant et l'objet choisi. Un lien partagé rouvre exactement la même carte.

Raccourcis :

| Touche | Effet |
|---|---|
| `Espace` | Lecture ou pause |
| `←` / `→` | Une heure avant ou après |
| `L` | Ouvrir les couches |
| `Échap` | Fermer |

Sur téléphone, tout passe dans une feuille qui monte du bas, à trois hauteurs.

Le fond de carte (OpenFreeMap Liberty) est retouché au chargement (`map/calmStyle.ts`) :
- les routes sont en gris chaud, l'eau en bleu-gris, avec moins de libellés de loin ;
- il passe à une vraie palette sombre la nuit, selon le soleil au centre de la vue.

La couleur reste ainsi réservée aux données.

Les véhicules sont des **maquettes 3D** de près : avions (dès le zoom 6,5), bateaux (zoom 10), trains voiture par voiture (zoom 13), bus, trams et métros (zoom 15). En deçà, ce sont des silhouettes à plat. Les maquettes sont construites dans le code (`web/src/models/`, aucun fichier à télécharger), à leurs dimensions réelles de près et agrandies jusqu'à une taille minimale à l'écran de loin. Le vrai soleil de l'instant affiché les éclaire quand la couche « Jour et nuit » est allumée. Elles passent derrière le relief et les bâtiments ; un train en tunnel reste visible en fantôme à plat. Chaque couche de véhicules a un réglage « Rendu » pour revenir aux symboles à plat.

## Lancer le projet (développement)

Deux programmes tournent ensemble, chacun dans son terminal :

```bash
# 1. Le serveur (Rust) : horaires, temps réel et tracés des trains
cd server
cargo run --release          # http://127.0.0.1:8787

# 2. Le site (TypeScript) : la carte
cd web
pnpm install
pnpm dev                     # http://localhost:5173
```

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

## Serveur permanent (Docker)

Le serveur tourne en permanence dans Docker (`compose.yaml`, `server/Dockerfile`) : il archive le temps réel en continu et sert le site. L'image se construit depuis la racine du dépôt : une étape Node construit le site, une étape Rust le serveur, et l'image finale (Debian minimale) contient les deux.

```bash
git clone https://github.com/LM28000/openstreetmap.git carte-vivante && cd carte-vivante
mkdir -p data archive              # avant le premier démarrage : sinon Docker les crée au nom de root
cat > .env <<EOF
BIND_ADDRESS=192.168.0.75          # adresse d'écoute (127.0.0.1 par défaut : la machine seule)
RUN_AS=1000:1000                   # utilisateur:groupe propriétaire de data/ et archive/
ARCHIVE_PATH=./archive             # où garder les archives (environ 50 Mo par jour)
EOF
# Facultatif, couche « Bateaux » : clé gratuite d'aisstream.io, saisie sans l'afficher.
read -rsp "Clé aisstream : " k && printf 'AISSTREAM_API_KEY=%s\n' "$k" >> .env && chmod 600 .env && unset k
# Facultatif, couche « Qualité de l'air » : compte gratuit Atmo Data (admindata.atmo-france.org).
# Le conteneur doit recevoir ATMO_USERNAME et ATMO_PASSWORD (comme AISSTREAM_API_KEY) ; entre apostrophes.
read -rp "Identifiant Atmo Data : " u && printf "ATMO_USERNAME='%s'\n" "$u" >> .env
read -rsp "Mot de passe Atmo Data : " p && printf "ATMO_PASSWORD='%s'\n" "$p" >> .env && chmod 600 .env && unset u p
# Facultatif, métro, RER, Transilien et tramways d'Île-de-France : clé gratuite de la plateforme PRIM
# (prim.iledefrance-mobilites.fr, quota de 1 000 requêtes par jour, dont la carte n'en prend que 480).
read -rsp "Clé PRIM : " k && printf "IDFM_PRIM_API_KEY='%s'\n" "$k" >> .env && chmod 600 .env && unset k
docker compose up -d --build       # installer, ou mettre à jour après un git pull
docker compose logs -f             # suivre les journaux
```

Le conteneur est isolé : son système de fichiers est en lecture seule, il n'a aucun privilège, sa mémoire est limitée à 1 Go (le pic mesuré est de 540 Mo) et ses journaux sont bornés à 30 Mo. Il n'écoute que sur l'adresse choisie et n'est pas exposé à Internet.

Les archives sont rangées dans `archive/sncf-trip-updates/AAAA-MM-JJ/HHMMSS.pb.gz` (heure UTC), une par version du flux temps réel.

### Historique : remonter la frise rejoue le passé

Avec `ARCHIVE_DIR` défini (c'est le cas dans le conteneur : `/archive`), le serveur enregistre ce que montrent les couches mobiles, et le site le relit quand l'horloge est à plus de 2 minutes dans le passé.

- **Ce qui est enregistré** : les positions que le serveur sert déjà, sans second contact avec les sources. Avions (`archive/avions/`), bateaux (`archive/bateaux/`), bus, trams et métros, positions estimées comprises et marquées comme telles (`archive/transports/`). Les trains ne sont pas enregistrés position par position : le site calcule leur position d'après les horaires, et l'archive du flux GTFS-RT donne les retards connus à chaque instant.
- **Format** (`server/src/history/codec.rs`, qui le décrit en détail) : un tronçon par couche et par tranche de 10 minutes, `archive/<couche>/AAAA-MM-JJ/HHMM.cvh.gz`, plus un `index.json` par jour. Colonnes (tous les instants, puis toutes les longitudes…), entiers quantifiés (cent-millièmes de degré, paliers de 25 ft…), codés en différences avec prédiction linéaire des positions, identité des objets (indicatif, nom du navire, ligne…) écrite une fois par tronçon, répétitions d'un objet immobile fusionnées, puis gzip. Chaque tronçon est autonome pour l'interpolation (il porte le dernier point d'avant son début et le premier d'après sa fin) et immuable une fois fermé. Un tronçon est fermé 160 s après sa fin et écrit via un fichier temporaire renommé : un arrêt brutal ne perd que les tronçons ouverts (10 à 13 minutes).
- **Conservation** : `HISTORIQUE_JOURS` (7 par défaut, comme la frise). Les jours entièrement plus vieux sont supprimés toutes les heures (il reste donc jusqu'à 8 jours sur le disque). L'archive brute `sncf-trip-updates` n'est pas concernée : elle est gardée sans limite (environ 120 Mo par jour), pour analyser les retards plus tard.
- **Volume** : voir « Points à connaître ». Le relevé n'écrit que dans son propre sous-dossier par couche et ne ralentit jamais les collecteurs (tâche séparée, lecture de la réponse déjà servie).
- **API** : `GET /api/historique` (plages enregistrées par couche : tout le reste est un trou), `GET /api/historique/{couche}/{début}` (tronçon, `Content-Encoding: gzip`, cache d'un an s'il est fermé), `GET /api/historique/trains?from=&to=&at=` (comme `/api/trains`, avec les retards annoncés par la SNCF à l'instant `at`, d'après la dernière version archivée du flux qui ne le dépasse pas ; au-delà de 20 min d'écart, horaires prévus).
- **Sur le site** : filet clair sous la frise là où il y a un enregistrement ; les statuts disent « En direct » ou « Relecture du 9 nov. à 18:05 » ; sans enregistrement, la couche se masque (« Pas d'enregistrement avant le 10 nov. à 21 h »). Les fiches, la sélection et la caméra qui suit un avion (à son altitude enregistrée) fonctionnent en relecture, et un lien partagé avec un instant passé s'ouvre en relecture.

## Organisation

```
web/                   le site (TypeScript, React, Vite)
  src/core/            le moteur, sans dépendance à React
    clock.ts           horloge globale (direct, pause, vitesse, saut dans le temps)
    module.ts          contrat d'un module de couche
    moduleManager.ts   visibilité, réglages, chargements, rendu à chaque image
    scenes.ts          les scènes (ensembles de couches qui vont ensemble)
    shareState.ts      l'état complet dans l'adresse de la page
    infoStatus.ts      pastilles de statut communes des fiches
  src/map/             la carte : fond OSM calmé (jour et nuit), globe, relief, branchement de deck.gl
  src/modules/         une couche = un module ; symbols.ts : halo, contour, atlas d'icônes, anneau de sélection
  src/models/          maquettes 3D construites dans le code (mesh.ts), éclairage par le soleil (sunLight.ts),
                       réglages communs (meshLayer.ts) ; une famille par fichier : avions, trains, bateaux, transports
  src/search/          la recherche universelle (un fournisseur de résultats par source)
  src/ui/              pastilles, catalogue, frise, fiche, accueil, feuille du téléphone
server/                le serveur (Rust : tokio, axum)
  src/timetable.rs     horaires SNCF (GTFS) en mémoire, trains en circulation sur une période
  src/realtime.rs      retards en temps réel (GTFS-RT), archivage optionnel
  src/gtfs_rt.rs       le format protobuf du temps réel, déclaré à la main (pas besoin de protoc)
  src/rails.rs         voies OSM : téléchargement, graphe, plus court chemin (A*)
  src/satellites.rs    éléments orbitaux CelesTrak (toutes les 3 h, gardés dans data/satellites/)
  src/dem.rs           altitudes du relief (tuiles Mapterhorn)
  src/tracks.rs        tracé réel de chaque tronçon entre deux gares, avec altitude
  src/network.rs       le réseau (gares et tracés) tel que l'envoie l'API, sous une version
  src/raptor.rs        isochrones : algorithme RAPTOR sur les horaires (lignes, tours, correspondances, groupes de modes)
  src/multimodal.rs    isochrones multimodales : arrêts supplémentaires (cars, métro, RER), rattachement aux gares, ressource /api/arrets
  src/multimodal/      lecture en flux des GTFS (feed.rs), Île-de-France (idfm.rs), cars régionaux (regional.rs), chargement de fond (load.rs)
  src/api.rs           l'API HTTP
  src/tiles/           moteur de tuiles vectorielles : mvt.rs, pmtiles.rs, geom.rs, proj.rs, builder.rs, serve.rs ; jeux population.rs, couverture.rs (ARCEP) et dvf.rs (prix de l'immobilier, source dvf_source.rs), grille des isochrones popgrid.rs ; jeu élections (polygones) elections.rs et ses formes elections_geo.rs
  src/transit.rs       bus, trams et métros en direct (flux GTFS-RT de transport.data.gouv.fr, noms de lignes lus dans routes.txt des GTFS)
  src/estimates.rs     positions estimées d'après les horaires en temps réel (GTFS compact dans gtfs_compact.rs)
  src/idf.rs           Île-de-France : SIRI global de PRIM rapproché du GTFS d'IDFM (voir « Bus, trams et métros »)
  src/bikes.rs …       collecteurs des autres couches (vélos, feux…)
data/                  données téléchargées (jamais versionnées)
```

## Les deux idées clés

**1. Le temps est au cœur du système.** L'horloge (`core/clock.ts`) donne l'instant affiché, en direct ou non. Chaque module répond à une seule question : *quel est ton état à l'instant t ?* C'est ce qui permet de rejouer le passé ou d'accélérer le temps sans code particulier dans les couches.

**2. Chaque couche est un module.** Un module déclare sa source de données, sa fréquence de rafraîchissement, son affichage et sa fiche au clic. Le gestionnaire s'occupe du reste : chargement, erreurs, redessin au bon moment, activation et désactivation.

### Ajouter une couche

1. Créer `web/src/modules/maCouche.ts` :

```ts
export const maCouche = defineModule<MesDonnees>({
  id: 'ma-couche',
  name: 'Ma couche',
  category: 'environnement',
  description: 'Ce que montre la couche.',
  attribution: 'Nom de la source',      // obligatoire : chaque source a sa licence
  refreshIntervalMs: 5 * 60_000,         // recharger toutes les 5 minutes
  timeStepMs: 60_000,                    // redessiner une fois par minute simulée (0 = à chaque image ; une fonction du zoom est admise)
  async load({ signal, time }) { /* fetch… */ },
  deckLayers({ data, time, terrain, settings }) { /* couches deck.gl pour l'instant t */ },
  describe(objet) { /* contenu de la fiche au clic */ },
});
```

2. L'ajouter à la liste de `web/src/modules/index.ts`.

Options utiles :

| Option | Effet |
|---|---|
| `needsReload(data, time)` | Recharge après un saut dans le temps hors de la période chargée. |
| `settings` | Réglages proposés dans le panneau (ex. « Par type / Par retard »). |
| `legend` | Légende affichée sous la couche. |
| `summary` | Résumé court, recalculé chaque seconde. |
| `followsTerrain` | Pose les objets sur le relief, avec `terrain.elevation(lon, lat)`. |
| `followsView` | Redessine la couche après chaque déplacement de la carte. |
| `drawOrder` | Ordre de dessin, indépendant de celui du panneau (ex. les voies sous les trains). |
| `native` | Couches MapLibre natives, pour les images drapées sur le relief (nuit, radar de pluie, photos anciennes). |

La fiche (`describe`) renvoie un `InfoContent` :
- un titre, et au besoin :
  - `kind` : le type, en petites capitales ;
  - `status` : la pastille, avec les aides de `core/infoStatus.ts` ;
  - `figures` : trois chiffres clés au plus, le plus important en premier (c'est lui que montre la poignée sur téléphone) ;
  - `fields`, `tables` et `note` : le détail ;
  - `actions` : par exemple un lien « Source ».
- « Suivre » et « Partager » sont ajoutés par la fiche elle-même.

Le contexte de rendu donne aussi `night`, la part de nuit du fond (de 0 à 1). Une couleur qui se perdrait sur le fond sombre s'adapte avec.

## Comment les trains sont placés

1. Le serveur charge les horaires théoriques (52 000 trajets) et interroge le temps réel SNCF toutes les 30 secondes.
2. Pour chaque paire de gares consécutives, il cherche le chemin sur les voies OSM : c'est un plus court chemin sur un graphe d'environ un million de points (A*). Il attribue ensuite à chaque point l'altitude du relief. Sur les ponts et dans les tunnels, une pente régulière remplace le sol, qui n'y est pas à la hauteur du rail.
3. Le site télécharge une fois le **réseau** (toutes les gares et tous les tracés, 1,7 Mo compressés), publié sous une version qui est l'empreinte de son contenu : le navigateur le garde en cache, même d'une visite à l'autre. Puis il demande chaque minute les trains de quelques heures autour de l'instant affiché (environ 170 Ko compressés à l'heure de pointe, contre 1,5 Mo quand les tracés étaient renvoyés à chaque fois). Pour chaque tronçon entre deux gares, il calcule un **profil de vitesse** : le train accélère au départ, roule à la vitesse permise de la voie (balise OSM `maxspeed`, connue pour 96 % des points), sans dépasser celle de son matériel (320 km/h en grande vitesse, 200 en Intercités, 160 en TER), puis freine avant la gare. Ce profil « au plus vite » est ensuite étiré pour tomber pile sur l'horaire, réel ou prévu, car les horaires comportent toujours une marge.
4. À chaque image, le site place chaque train le long de son tracé selon ce profil, et le dessine dans son sens de marche. Seule la portion des chemins proche de l'instant affiché est envoyée à la carte graphique pour les traînées (dix fois moins de sommets) : le rafraîchissement du temps réel ne fige plus l'animation.
5. Si un tronçon n'a pas de tracé (voie absente d'OSM, gare trop loin d'une voie), le train y va en ligne droite. La fiche du train l'indique.

La vitesse affichée est donc une **estimation**. La SNCF ne publie pas la position GPS de ses trains en open data.

**Clic sur un train** : tout son trajet est surligné, avec la partie déjà faite en gris. Sa fiche liste les arrêts avec leurs horaires et retards, et donne la vitesse estimée et la vitesse autorisée de la ligne. Le bouton « Suivre » fait suivre le train par la caméra ; déplacer la carte arrête le suivi.

**Clic sur une gare** (visibles à partir du zoom 8,5) : son tableau des départs et des arrivées, trains supprimés compris. Chaque ligne d'un tableau mène au train ou à la gare correspondante.

## Comment les isochrones sont calculés

Le serveur (`server/src/raptor.rs`) utilise **RAPTOR** (Round-bAsed Public Transit Optimized Router), un algorithme de calcul d'itinéraires en transports en commun :

1. les trains qui desservent les mêmes gares dans le même ordre forment une **ligne** (8 700 lignes pour 52 000 trajets) ; sur une ligne, le premier train qu'on peut prendre est aussi celui qui arrive le plus tôt, une recherche dichotomique le trouve ;
2. on procède par **tours** : le tour *k* donne la meilleure arrivée à chaque gare avec au plus *k* trains. Un tour reprend les gares améliorées au tour précédent, monte dans le premier train possible de chaque ligne qui y passe, le suit jusqu'au terminus en notant chaque arrivée qui bat les précédentes, puis ajoute les correspondances à pied ;
3. chaque amélioration garde une étiquette (« train 6607 pris à Paris », « à pied depuis… »), qui permet de **remonter l'itinéraire** tour par tour. Le nombre de correspondances est un résultat du calcul, pas une pénalité.

Les choix de modélisation : une gare est une zone d'arrêt (tous les quais ensemble) ; une correspondance dans la même gare demande 8 minutes pour un train (5 pour un car, 4 pour le métro : le plus long des deux modes s'applique), sauf au départ ; deux gares à moins de 1,2 km sont reliées à pied (3 min de marge, plus 1,3 × la distance à 4,5 km/h), une gare et un arrêt de car ou de métro à moins de 1 km, deux de ces arrêts à moins de 500 m. Le **temps réel** (retards, suppressions) est appliqué aux trains quand l'heure de départ est entre 2 h avant et 6 h après maintenant ; ailleurs, l'horaire théorique.

**Multimodal.** RAPTOR ne sait pas ce qu'est un train : il reçoit des arrêts, des lignes et des marches. Les gares SNCF gardent leurs indices (le réseau partagé avec la couche des trains ne change pas) ; des **arrêts supplémentaires** les suivent, servis à part sous `GET /api/arrets/{version}` (immuable, en cache, ~3 Mo avant compression) : les réponses d'isochrone ne portent que leurs numéros. Chaque ligne a un groupe de modes (`train`, `car`, `idf`) que la requête choisit (`&modes=train,car,idf`, défaut : tout). Sources, chargées en tâche de fond (le serveur répond en rail seul dès le démarrage, puis se met à jour à chaque étape) : les **Car TER** du GTFS SNCF (~1 000 courses sur la fenêtre), le **métro, RER, Transilien et tramway** du GTFS d'Île-de-France Mobilités (même fichier que les positions estimées, ~67 000 courses ; les TER qu'il recopie et les bus sont écartés), et les **cars interurbains** de 57 réseaux du catalogue transport.data.gouv.fr (BreizhGo, Aléop, liO, Fluo, Rémi, Mobigo, ZOU !, Nomad, départements…, ~41 000 courses). Choix des réseaux régionaux : jeux de type `public-transit` dont le titre contient « interurbain » (sans agrégats, trains, bateaux, TAD, scolaires, Île-de-France) ; lignes de type bus ou car hors scolaire et à la demande ; circulations d'au moins 8 km de bout en bout avec un arrêt tous les 500 m ou plus (écarte les lignes urbaines que ces jeux contiennent). Les calendriers sont réduits à hier–dans 3 jours (départs jusqu'à après-demain). Les arrêts d'Île-de-France sont rattachés aux gares SNCF par proximité (300 m) et nom, les cars TER par code UIC, et les arrêts de cars de même nom à moins de 200 m sont fusionnés. Les temps fixes de 20 à 45 min entre terminus parisiens ne valent plus que « Trains seulement » et « Trains et cars » : avec Île-de-France, on prend le vrai métro ou RER. `GET /api/isochrone?depuis=<code UIC>&depart=<secondes>&max=<minutes>&correspondances=<n>&modes=<…>` répond en 3 à 15 ms (de 1 à 4 ms en rail seul) ; `/api/isochrone/trajet?…&vers=<code UIC ou xN>` donne l'itinéraire (étapes avec ligne, destination et couleurs officielles).

**Habitants atteints.** La réponse porte aussi `population` : le total des habitants à portée et leur répartition par tranche de 30 min (`bands`, `bandMinutes`). Règle (`server/src/tiles/popgrid.rs`) : un carreau INSEE de 200 m compte si, pour au moins un arrêt atteint, *arrivée à l'arrêt + marche de l'arrêt au centre du carreau ≤ durée demandée*. La marche reprend celle des correspondances à pied : 4,5 km/h sur la distance à vol d'oiseau × 1,3, plafonnée à 1,2 km autour d'une gare et 1 km autour d'un arrêt de car ou de métro, sans la marge de 3 min ; les carreaux autour de la gare de départ comptent. C'est un minimum : ni bus urbains, ni vélo. La grille tient en mémoire en ~16 Mo (2,29 M de carreaux métropolitains : un octet de position dans une case de 1 km, un `f32` d'habitants, un index de cases) ; chaque arrêt ne visite que les cases que son disque de marche touche. Surcoût mesuré : de 0,1 à 0,7 ms par requête usuelle (`&habitants=non` le supprime pour le mesurer). Le site l'affiche dans le résumé (« … 1,2 million d'habitants à moins de 3 h ») et dans la fiche de la gare de départ.

Variables d'environnement : `ISO_CARS_TER`, `ISO_IDF`, `ISO_CARS_REGIONAUX` (`non` pour désactiver une source), `ISO_CACHE_MO` (cache des GTFS régionaux, `transit-interurbain/`, 800 par défaut ; ~520 Mo utilisés), `ISO_MEMOIRE_MO` (budget des cars régionaux, 80). Aucune clé d'API n'est nécessaire.

## Les tuiles vectorielles (gros jeux de données)

Les 2,3 millions de carreaux de population de l'INSEE ne se téléchargent pas dans le navigateur : le serveur (`server/src/tiles/`) les prépare **une fois**, les **généralise par zoom** et les sert en **tuiles**. C'est un moteur réutilisable ; la couche « Population » est son premier jeu de données.

- **Format** : tuiles Mapbox Vector Tiles (MVT, du protobuf écrit à la main : `mvt.rs`), rangées dans une archive **PMTiles v3** (`pmtiles.rs` : numéros de tuile de Hilbert, répertoires racine et feuilles, tuiles identiques stockées une fois, gzip) avec son lecteur.
- **Fabrication à mémoire bornée** (`builder.rs`) : la source est lue en flux et déposée dans des fichiers « seaux » (une tuile du zoom 10 chacun) ; les zooms bas (4 à 9) sont faits en un passage global, qui agrège au fil de l'eau ; les zooms hauts (10 à 12), seau par seau. Elle tourne dans un **processus enfant** du serveur (`carte-vivante-serveur --construire-tuiles <jeu>`) : toute sa mémoire est rendue à la fin. Tant qu'elle tourne, l'ancienne archive reste servie ; elle n'est refaite que si le millésime de la source ou le schéma change. Résultat dans `DATA_DIR/tuiles/` (archive, fiche `<jeu>.json`, fichiers annexes), source téléchargée dans `DATA_DIR/sources-tuiles/<jeu>/`.
- **Généralisation par zoom** : carreaux → carreaux plus gros (`GridAggregator` : les **comptes sont additionnés, les ratios recalculés** à partir des sommes, jamais moyennés) ; points → grappes (`PointCluster`) ; polygones → découpés au carré de la tuile plus 64 unités de marge et simplifiés à la résolution de la tuile (Douglas-Peucker, `geom.rs`), ceux de moins d'un pixel sont écartés. Une tuile ne dépasse pas 500 Ko (non compressée) : au-delà, les objets les moins importants (`Feature::weight`) sont retirés et un avertissement est journalisé.
- **Service** : `GET /api/tuiles/<jeu>` (fiche : version, zooms, emprise, crédit, plages de valeurs pour les légendes ; jamais en cache) et `GET /api/tuiles/<jeu>/<version>/{z}/{x}/{y}` (une tuile gzippée, **cache immuable d'un an** : une nouvelle fabrication change de version, donc d'adresse). *Pourquoi servir les tuiles par le serveur plutôt que le fichier `.pmtiles` avec des requêtes `Range` et le paquet npm `pmtiles` ?* Le site reste une source MapLibre ordinaire sans dépendance de plus ; le format d'archive reste interne au serveur ; l'adresse versionnée donne le cache immuable. Le prix (le serveur lit chaque tuile non encore en cache, un `pread` de quelques Ko) est négligeable à cette échelle.
- **Site** : `web/src/map/vectorTiles.ts` (fiche, source MapLibre) ; le module met ses couches `fill-extrusion` (3D) et `fill` (à plat) sous les étiquettes, un clic ouvre la fiche commune.

### Ajouter un jeu de données

1. Créer `server/src/tiles/mon_jeu.rs` avec un type qui implémente `Dataset` (voir le commentaire de module de `tiles/mod.rs` et l'exemple `population.rs`) : `id`, `layer`, `keys` (propriétés), `zooms`, `source_id` (millésime de la source), `acquire` (téléchargement), `scan` (lecture **en flux**, un `emit(Feature)` par point, polygone ou carreau, avec ses propriétés) et `generalizer(zoom)` : `PassThrough` pour des polygones, `PointCluster` pour des points, `GridAggregator` pour une grille.
2. L'ajouter dans `datasets()` de `tiles/serve.rs`. Au démarrage, le serveur fabrique l'archive en tâche de fond si elle manque.
3. Côté site : `loadTileSheet('<jeu>')` dans le `load()` du module, `addTileSource` et des couches MapLibre (`source-layer` = `sheet.couche`) dans `native` ; la fiche vient de `select`/`describe`.

Pour des **polygones** (couverture mobile, bureaux de vote) : ne fabriquer que les zooms où le jeu a un sens (`zooms().0`), car aux zooms bas tous les polygones passent en mémoire. Pour des **points** (prix de l'immobilier) : la dernière propriété est le nombre de points d'une grappe.

## Population (carreaux INSEE)

Couche « Population » : les habitants au carreau de 200 m (Filosofi 2019, INSEE, licence ouverte Etalab 2.0), France métropolitaine, Martinique et La Réunion (les seuls départements d'outre-mer du fichier). Hauteur de la colonne = densité (racine carrée) ; couleur au choix : densité, niveau de vie moyen, part de ménages pauvres, part des 65 ans et plus ; mode « à plat ». Une teinte, sept classes, seuils calculés par le serveur sur la distribution **des habitants** (palette validée sur fond clair et sombre).

La source (zip de 58 Mo qui contient un 7z qui contient trois CSV) est lue en flux : l'identifiant d'un carreau (`CRS3035RES200mN2029800E4252400`) donne sa position dans le repère LAEA (EPSG:3035) ; la Martinique et La Réunion sont en UTM (`tiles/proj.rs`, projections écrites à la main). **Secret statistique** : sous 11 ménages fiscaux, l'INSEE publie une valeur *imputée* (approchée), signalée par `i_est_200` ; c'est le cas de 79 % des carreaux (mais de 20 % des habitants : les carreaux ruraux). La fiche donne la part d'habitants concernée. Variables d'environnement : `INSEE_CARREAUX_URL` (millésime par défaut : 2019), `TUILES_EFFACER_SOURCES` (effacer la source après la fabrication), `TUILES_JEUX` (ne mettre en service que certains jeux, ex. `population,dvf`). Les fabrications passent une par une, tous jeux confondus.

## Couverture mobile (ARCEP, polygones rastérisés)

Couche « Couverture mobile » : où l'on capte, opérateur par opérateur (Orange, SFR, Bouygues Telecom, Free Mobile), en 4G ou en voix (2G/3G), et combien d'opérateurs couvrent chaque endroit, zones blanches comprises. Source : ARCEP, « Mon réseau mobile », cartes de couverture théorique du dernier trimestre (2026 T2), <https://data.arcep.fr/mobile/couvertures_theoriques/> (jeu <https://www.data.gouv.fr/datasets/mon-reseau-mobile>), Licence Ouverte ; à citer « ARCEP, Mon réseau mobile ». Ce sont des **simulations** des opérateurs, publiées sous le contrôle de l'ARCEP : pas des mesures. La 5G n'est pas publiée par l'ARCEP, et la 2G de Free Mobile non plus (d'où « voix = 2G/3G ») ; l'outre-mer n'est pas pris en compte.

**Volumes.** Huit GeoPackage en 7z (4G et 2G/3G voix × 4 opérateurs) : 2,1 Go à télécharger, ~6 Go décompressés (une ligne par département et niveau de qualité, géométries de 1 à 40 Mo en Lambert-93). Le serveur les télécharge l'un après l'autre (`acquire`), puis, dans le processus de fabrication, décompresse chaque fichier, le lit (SQLite embarquée, `rusqlite`), le rastérise, et **efface le 7z et le GeoPackage** aussitôt : jamais plus d'un fichier décompressé sur le disque. Les contours des départements (Etalab, 2,7 Mo) servent de masque de terre.

**Rastérisation** (`server/src/tiles/couverture.rs`, commentaires de module : remplissage par lignes de balayage expliqué). Grille de 250 m en LAEA (comme les carreaux INSEE, donc un `Cell` ordinaire : aucun changement du moteur), un octet par carreau et par technologie (2 bits par opérateur : aucune, limitée, bonne, très bonne), ~4 400 × 4 500 carreaux, 37 Mo. Les sommets sont lus un à un dans le blob WKB, projetés (Lambert-93 vers LAEA, par interpolation bilinéaire d'un quadrillage de 5 km), et seuls les croisements avec les lignes de centres de carreaux sont gardés. Les carreaux de terre sans couverture sont émis aussi : ce sont les zones blanches. Aux zooms bas, `GridAggregator` additionne des comptes (niveaux, « couvert », « zone blanche ») par carreau agrégé (de 250 m au zoom 11 à 32 km au zoom 4, ~6 pixels d'écran à chaque zoom) et `finalize` recalcule la qualité moyenne, la part de surface couverte par opérateur, le nombre moyen d'opérateurs et la part sans opérateur.

**Mesures** (Mac, un cœur, fabrication complète) : ~6 min de fabrication hors téléchargement (rastérisation des 8 fichiers : 3 min), archive de 111 Mo (4 574 tuiles), pointe de mémoire du processus enfant ~100 Mo (< 150 Mo), serveur principal inchangé en régime établi. Variables d'environnement : `ARCEP_OPERATEURS` (codes `OF,SFR0,BOUY,FREE`), `ARCEP_TECHNOS` (`4g,voix`) et `ARCEP_DEPARTEMENTS` (`29,22`) pour un essai réduit (elles entrent dans l'identifiant de la source) ; `ARCEP_GARDER_SOURCES` garde les 7z ; `TUILES_JEUX=couverture`. Pour changer de trimestre : `QUARTER` dans `couverture.rs`.

Côté site (`web/src/modules/couverture.ts`) : à plat, technologie (4G, voix) et vue (nombre d'opérateurs, ou un opérateur). Une seule teinte (vert olive, ni les couleurs des opérateurs ni celles des autres couches), la **carence la plus visible** : zéro opérateur ou aucune couverture est le cran le plus foncé de jour, le plus clair de nuit ; palette validée (`validate_palette.js --ordinal`, jour et nuit). Fiche : opérateurs en 4G et en voix, niveau de chacun, date des cartes, rappel « simulations, pas mesures ». Scène « Réseau mobile ».

## Prix de l'immobilier (DVF)

Couche « Prix de l'immobilier » : prix de vente au m² des logements, France métropolitaine (Alsace-Moselle absente du fichier, DOM écartés), 5 dernières années complètes (2021-2025 ; l'année courante s'ajoute si Etalab la publie). Source : DVF géolocalisées d'Etalab (`files.data.gouv.fr/geo-dvf/latest/csv/<année>/full.csv.gz`, ~110 Mo par an), licence ouverte 2.0, mention « DGFiP, DVF ; Etalab ». Jeu `dvf` du moteur de tuiles (`server/src/tiles/dvf.rs`, source et nettoyage dans `dvf_source.rs`, tout y est commenté).

- **Carte** : de loin (zoom < 14), des carreaux de 32 km à 100 m (~10 pixels d'écran à chaque zoom) colorés par la **médiane** du prix au m², palette divergente autour d'une médiane de référence (bleu moins cher, gris autour de la médiane, rose plus cher ; validée jour et nuit) : par défaut celle de la **zone affichée** (médiane des carreaux à l'écran pondérée par leur nombre de ventes, recalculée quand la carte s'arrête), sinon la médiane nationale du type choisi (réglage « Référence ») ; à Paris, tout dépasse 2,8 fois la médiane nationale ; de près (zoom ≥ 14), une vente par point. Réglages : biens (tous, appartements, maisons), période (5 ans, 12 derniers mois jusqu'au dernier mois publié), affichage à plat ou en relief (hauteur = densité de ventes). Fiche d'un carreau : médiane, quartiles, nombre de ventes, période, répartition appartements/maisons ; fiche d'une vente : prix, surface, pièces, mois, écart à la médiane nationale ; lien vers l'explorateur officiel (`explore.data.gouv.fr/fr/immobilier`).
- **Une médiane ne s'additionne pas** : un carreau de zoom bas rassemble des centaines de carreaux plus fins. Chaque carreau porte donc un *histogramme* de 128 classes de prix au m² espacées en logarithme (300 à 30 000 €/m², précision de la médiane ~2 %), par type et par période ; les histogrammes se fusionnent en s'additionnant, et la médiane et les quartiles ne sont lus qu'à la fin (`finalize`). En mémoire, ils sont creux (triplets carreau/classe/décompte de 12 octets, fusionnés sur place).
- **Nettoyage** (règles complètes en tête de `dvf_source.rs`) : une vente s'étale sur plusieurs lignes (parcelles, lots) au même prix, on regroupe les lignes consécutives d'une mutation ; on garde les « Vente » à une disposition, avec **un seul** logement (maison ou appartement), sans local commercial, prix ≥ 10 000 €, surface bâtie de 9 à 400 m² (appartement) ou 20 à 600 m² (maison, au plus 1 ha de terrain), prix au m² de 300 à 30 000 €, avec coordonnées. Comptes par année dans la fiche du jeu (`/api/tuiles/dvf`) : en 2021, 1,73 M de mutations lues, 885 707 ventes gardées (417 590 appartements, 468 117 maisons) ; 3 753 107 ventes pour 2021-2025.
- **Conditions de réutilisation de la DGFiP** (art. R112 A-3 du LPF) : pas de ré-identification des personnes, pas d'indexation par les moteurs de recherche. Mesures : aucune adresse, aucun identifiant de mutation ou de parcelle ; date réduite au **mois** ; position des ventes **arrondie à ~20 m** ; ventes de plusieurs biens écartées ; données servies seulement en tuiles binaires avec l'en-tête `X-Robots-Tag: noindex, nofollow, noarchive` (sur toutes les tuiles).
- **Fabrication** : les fichiers bruts sont téléchargés un à un, nettoyés en flux puis supprimés (au plus ~120 Mo bruts sur le disque) ; il reste ~25 Mo par année dans `DATA_DIR/sources-tuiles/dvf/`. Etalab publie en avril et en octobre environ : l'archive est refaite chaque semestre (`source_id`), les fichiers ne sont retéléchargés que si leur date de modification a changé. Archive : 180 Mo, 175 622 tuiles (aucune au plafond de 500 Ko).

## Élections (polygones par bureau de vote)

Couche « Élections » : présidentielle 2022 (1er et 2nd tour), européennes 2024, législatives 2024 (1er et 2nd tour), par bureau de vote. **Un jeu de tuiles par scrutin** (`elec-p22t1`, `elec-p22t2`, `elec-eu24`, `elec-l24t1`, `elec-l24t2`), pour garder les tuiles légères. Généralisation par niveau administratif, sans dissolution : départements (zooms 4-7), communes (8-10), bureaux (11-12) ; les totaux de chaque niveau sont les **sommes** des bureaux, les pourcentages sont recalculés dans le navigateur. Affichages : participation, « en tête » (familles politiques, légende et nom dans la fiche), part d'un candidat ; relief optionnel (hauteur = votants).

Sources : résultats définitifs par bureau (ministère de l'Intérieur, data.gouv.fr), contours des bureaux (Etalab, Licence Ouverte, approximation à partir du répertoire électoral unique, **sans valeur officielle**, datés de juin 2022), communes et départements (IGN, ADMIN EXPRESS COG CARTO, service WFS de la Géoplateforme, Licence Ouverte 2.0). Les fichiers de travail (~150 Mo) sont rangés dans `DATA_DIR/sources-tuiles/elections-sources/` ; les effacer force un nouveau téléchargement. Jointure sur `commune_bureau` (`01001_0001`), mesurée à la fabrication (bureaux / inscrits, hors Français de l'étranger, sans contour) : présidentielle 98,8 % / 98,7 %, européennes 97,7 % / 97,3 %, législatives 1er tour 97,7 % / 97,3 %, 2nd tour 97,8 % / 97,4 %. Cinq archives de 71 à 80 Mo (~380 Mo), 18 850 tuiles chacune, aucune au plafond de 500 Ko ; 1 à 2 minutes de fabrication chacune, pic de mémoire du processus enfant 138 Mo (`/usr/bin/time -l`, européennes), fichiers temporaires jusqu'à ~450 Mo pendant la fabrication. Les communes dont un bureau n'a pas de contour sont dessinées entières sous les bureaux. Pistes pour la suite (non faites) : les municipales de mars 2026 (résultats par bureau publiés par le ministère ; au niveau des listes ils sont locaux, donc plutôt la participation) et un petit point d'accès JSON pour le détail complet des 38 listes des européennes au clic (aujourd'hui, les 26 listes sous 1 % sont regroupées dans « autres »). Pour ne fabriquer que ces jeux : `TUILES_JEUX=elec-p22t1,elec-p22t2,elec-eu24,elec-l24t1,elec-l24t2`.

## Couches disponibles

| Couche | Ce qu'elle montre | Source |
|---|---|---|
| Trains | TGV, Intercités et TER à leur position, sur les vraies voies, avec leurs retards et une vitesse estimée. Couleur par type ou par retard ; de près (zoom 13), chaque rame est une suite de voitures en 3D sur sa vraie longueur, qui suit la voie et sa pente (motrice à nez effilé et voitures à deux niveaux pour le TGV, cabines arrondies pour le TER, locomotive et voitures Corail pour l'Intercités), en fantôme à plat dans les tunnels. Gares de trois tailles selon leur trafic. Trajet et arrêts au clic, tableau d'affichage des gares, caméra qui suit. | SNCF, OpenStreetMap |
| Voies ferrées | Les lignes empruntées par les trains de voyageurs, telles que le serveur les a calculées sur les voies OSM. Trait discret, ou nuances de gris selon la vitesse maximale de la ligne (épaisseur comprise). Fiche au clic : gares du tronçon, longueur, répartition des vitesses, lien vers OpenRailwayMap. | OpenStreetMap |
| Isochrones | Jusqu'où va-t-on en train, en car et en métro depuis une gare, en partant à l'heure de la frise ? Gares et arrêts atteints (cars, métro, RER : plus petits, cernés ambre ou bleu, nommés de près) colorés par heure de trajet, zone lisse autour d'elles (le temps qui reste converti en rayon à 15 km/h, 30 km au plus), gare de départ marquée. Se choisit par l'action « Jusqu'où en train ? » d'une fiche de gare, ou en cherchant « depuis Rennes » ; la gare vit dans l'adresse (`#depuis=87471003`). Réglages : durée maximale, correspondances (aucune à sans limite), transports pris en compte (trains seulement, trains et cars, tous y compris Île-de-France), zone ou gares seules. Fiche d'une gare atteinte : durée, correspondances, itinéraire étape par étape avec pastille de ligne aux couleurs officielles. Une teinte (framboise), une tranche par heure, palette validée sur fond clair et sombre. | SNCF (ODbL) ; Île-de-France Mobilités (ODbL) ; cars interurbains des régions et départements via transport.data.gouv.fr (licences ouvertes de chaque réseau) ; calcul RAPTOR sur le serveur |
| Population | Les habitants au carreau de 200 m : colonnes dont la hauteur est la densité, couleur au choix (densité, niveau de vie moyen, ménages pauvres, 65 ans et plus), ou à plat. Aux zooms bas, des carreaux agrégés (jusqu'à 16 km), ratios recalculés depuis les sommes. Fiche : habitants, niveau de vie, pauvreté, part de valeurs imputées (secret statistique). Tuiles vectorielles préparées par le serveur. | INSEE, Filosofi 2019, données carroyées (licence ouverte Etalab 2.0) |
| Couverture mobile | Couverture 4G et voix (2G/3G) des quatre opérateurs au carreau de 250 m, à plat : nombre d'opérateurs (zones blanches en évidence) ou qualité d'un opérateur. Polygones de l'ARCEP rastérisés par le serveur, agrégés aux zooms bas. Fiche : niveau par opérateur, date des cartes, simulations et non mesures. | ARCEP, Mon réseau mobile (Licence Ouverte) |
| Avions | Les avions au-dessus de la France et autour, en direct, à leur altitude réelle (couleur selon l'altitude), avec leur indicatif. Sept maquettes 3D selon le type d'appareil (biréacteur, gros-porteur, quadriréacteur, turbopropulseur, jet d'affaires, avion léger, hélicoptère), cabrées en montée, inclinées en virage, avec leur ombre au sol, à l'envergure réelle de près (silhouettes à plat de loin) ; anneau rouge pour une urgence déclarée (squawk 7500, 7600, 7700). Fiche au clic, caméra qui suit. En direct seulement. | [adsb.lol](https://adsb.lol) |
| Bateaux | Les navires autour de la France et sur les fleuves, d'après leurs émissions AIS : couleur par famille (marchandises, passagers, pêche et plaisance), maquettes 3D selon le type AIS (porte-conteneurs avec ses conteneurs, pétrolier, ferry, paquebot, pêche, voilier, plaisance, remorqueur…) aux dimensions AIS, ligne de flottaison comprise, sillage proportionnel à la vitesse, taille réelle de près, noms en étiquettes de carte sans chevauchement. Fiche au clic (destination, dimensions…), caméra qui suit. En direct seulement ; demande une clé aisstream.io sur le serveur. | [aisstream.io](https://aisstream.io) |
| Bus, trams et métros | Les véhicules des transports urbains en direct, dans les ~140 réseaux français qui publient leurs positions (GTFS-RT, relues toutes les 30 s). Couleur et numéro de la ligne quand le réseau les donne ; maquettes 3D de bus, bus articulé, tram et métro orientées selon le cap (silhouettes à plat sous le zoom 15) ; une position estimée d'après les horaires (47 réseaux) est translucide, sur une empreinte en pointillé. De loin, un rond par réseau ; de près, chaque véhicule, qui glisse d'une position à la suivante. Fiche au clic. En direct seulement. **Île-de-France** (avec une clé PRIM, `IDFM_PRIM_API_KEY`) : métro, RER, Transilien, tramways et câble, aux couleurs officielles des lignes (GTFS d'Île-de-France Mobilités). IDFM ne publie pas de positions : les prochains passages de sa requête globale SIRI (un relevé toutes les 180 s, soit 480 des 1 000 requêtes quotidiennes du quota) sont rapprochés des courses du GTFS (par identifiant pour les trains SNCF, par arrêts et heures pour le métro et les tramways) et placent chaque rame sur son tracé ; le retard est affiché quand le SIRI donne aussi l'horaire théorique (RER, Transilien). Les RER et Transilien ont la maquette de rame du métro. Tous sont translucides (positions estimées), le métro sous terre aussi. Les bus (≈ 200 000 courses, environ 100 Mo de plus) sont facultatifs : `IDFM_MODES=metro,tram,train,cable,bus`. | réseaux de transport via [transport.data.gouv.fr](https://transport.data.gouv.fr) (Licence Ouverte 2.0 ou ODbL) ; Île-de-France : [Île-de-France Mobilités / PRIM](https://prim.iledefrance-mobilites.fr) (ODbL) |
| Vélos en libre-service | Les 5 800 stations des 84 réseaux de France (Vélib', Vélo'v, VélôToulouse…), relues chaque minute. Mode « Vélos » pour en trouver un, « Places » pour le rendre ; vu de près, une jauge en anneau donne la part de vélos disponibles, avec le nombre. Une station hors service est un simple anneau gris. | réseaux GBFS via [transport.data.gouv.fr](https://transport.data.gouv.fr) |
| Vigilance crues | Niveau de vigilance des 337 tronçons de rivières surveillés, de vert à rouge (épaisseur du trait selon le niveau). Couche MapLibre drapée sur le relief. | [Vigicrues](https://www.vigicrues.gouv.fr) |
| Bornes de recharge | Les 45 000 stations de recharge pour véhicules électriques, colorées selon leur puissance maximale (quatre classes de turquoise) ; pictogramme de prise et puissance écrite de près. Réglages : puissance (toutes, rapides, ultra-rapides) et accès. Fiche : opérateur, prises, tarif, horaires. Pas de disponibilité en temps réel. | Base nationale des IRVE, [transport.data.gouv.fr](https://transport.data.gouv.fr) (Licence Ouverte 2.0) |
| Trafic routier | Événements du réseau routier national non concédé (bouchons, accidents, fermetures, travaux, dangers ; un pictogramme par famille) et état de la circulation (fluide à coupé) autour des grandes villes. Réglage Événements / État / Les deux. Les autoroutes concédées ne sont pas couvertes. | Bison Futé via transport.data.gouv.fr (Licence Ouverte 2.0), Rennes Métropole (ODbL) |
| Vigilance météo | Niveau de vigilance de chaque département, aujourd'hui et demain (suit l'horloge), doublé d'une trame et d'un contour. Fiche : phénomènes et créneaux. | Météo-France via data.gouv.fr (Licence Ouverte 2.0), contours IGN Admin Express |
| Qualité de l'air | Indice ATMO de près de 29 000 communes ou intercommunalités de métropole (palette officielle, du bon à l'extrêmement mauvais), pour le jour de l'horloge : aujourd'hui, demain, parfois après-demain (l'indice n'a pas d'historique). De loin un champ de couleur continu, de près des pastilles. Fiche : niveau, polluant dominant, cinq sous-indices, association régionale, épisodes de pollution du département. Demande `ATMO_USERNAME` et `ATMO_PASSWORD` côté serveur ; sans eux, la couche est désactivée. | Atmo France / AASQA via [Atmo Data](https://admindata.atmo-france.org) (données ouvertes) |
| Feux | Points chauds détectés par satellite sur 7 jours (incendies, brûlages agricoles, sites industriels). La couleur dit l'âge à l'instant affiché, la taille la puissance du feu : on les voit apparaître en rejouant la semaine. | [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov) (VIIRS) |
| Séismes | Les 7 derniers jours : tous autour de la France, magnitude 4,5 et plus dans le monde. Ceux de moins de 3 h pulsent. | [EMSC](https://www.seismicportal.eu) |
| Électricité | Sur chaque région, une colonne 3D empile la production par filière, et un anneau blanc marque la consommation. Au quart d'heure, et suit la frise temporelle. | RTE éCO2mix via [ODRÉ](https://odre.opendatasoft.com) |
| Carburants | Prix actuels dans les 9 800 stations-service, colorés par rapport au reste de la France (bleu moins cher, rouge plus cher), au choix du carburant. Vu de près, une étiquette de prix ; la moins chère l'emporte quand deux étiquettes se gêneraient. | [prix-carburants.gouv.fr](https://www.prix-carburants.gouv.fr) |
| Prix de l'immobilier | Prix de vente au m² des logements (DVF 2021-2025) : médiane par carreau (32 km à 100 m selon le zoom, histogrammes fusionnés), ventes une à une de près ; biens, période (12 mois / 5 ans), relief. Fiche : médiane, quartiles, nombre de ventes, lien vers l'explorateur officiel. | DGFiP, DVF ; Etalab (licence ouverte 2.0) |
| Élections | Résultats par bureau de vote, commune et département : présidentielle 2022 (deux tours), européennes 2024, législatives 2024 (deux tours). Participation, nuance en tête ou part d'un candidat, à plat ou en relief ; fiche avec chaque nuance ou liste. Tuiles vectorielles, une archive par scrutin. | Ministère de l'Intérieur ; Etalab (contours des bureaux de vote) ; IGN |
| Satellites | Stations spatiales (ISS, Tiangong), satellites de navigation, météo et les plus brillants, en silhouettes neutres, à leur position calculée pour l'instant affiché (replay compris) ; Starlink en option. Altitude figurée par une tige (échelle non respectée), trace au sol de l'orbite au clic, visibilité de l'ISS depuis le centre de la carte. | [CelesTrak](https://celestrak.org) |
| Jour et nuit | Le fond de carte passe à sa palette sombre la nuit (soleil au centre de la vue), l'ombre de la nuit et des crépuscules se voit de loin. Les bâtiments 3D sont éclairés depuis la vraie position du soleil. | calcul astronomique |
| Radar de pluie | Les précipitations mesurées par radar, des deux dernières heures, drapées sur le relief. | [RainViewer](https://www.rainviewer.com) |
| Photos aériennes anciennes | Les orthophotographies de l'IGN, des années 1950 (couche principale, 1950–1965) à aujourd'hui (1965–1980, 1980–1995, 2000–2005, 2006–2010, 2011–2015, actuelle), avec un **rideau avant / après** : une poignée verticale que l'on glisse (souris, doigt ou clavier) ; à gauche la photo, à droite la carte d'aujourd'hui. Réglage « Transparence » (curseur d'opacité) à la place du rideau. Drapée sur le relief 3D, étiquettes et couches par-dessus. Fiche : époque, ce que l'on voit, lien « Remonter le temps ». Indisponible sur le globe. | IGN, Géoplateforme (WMTS, sans clé), Licence Etalab 2.0 |
| Monuments historiques | Les 44 500 immeubles protégés de la base Mérimée. Le **pictogramme** dit le genre (religieux, château et demeure, militaire, civil et urbain, archéologique, industriel et ouvrage d'art, funéraire et commémoratif), la **forme du badge** dit la protection : carré sombre pour un monument classé, rond clair pour un inscrit (aucune couleur : le noir et blanc ressort de jour comme de nuit). Points de loin, pictogrammes dès le zoom 11, noms dès le 14 (désencombrés, les classés d'abord). Réglages : protection, genre. Fiche : nom, commune, protection et date, époque, description quand la base en a une, lien vers la notice POP. | Base Mérimée, ministère de la Culture, via [data.gouv.fr](https://www.data.gouv.fr/datasets/immeubles-proteges-au-titre-des-monuments-historiques-2) (Licence Ouverte 2.0) |
| Accidents de la route | Les ~270 000 accidents corporels des cinq dernières années (métropole). De loin : une grille de cases, **hauteur** = nombre d'accidents (colonnes 3D, ou « Aplat »), **teinte** = part des accidents ayant fait un tué ou un hospitalisé. À partir du zoom 12,5 : un point par accident, coloré par la **pire issue** parmi les personnes impliquées (indemne, blessé léger, blessé hospitalisé, tué ; une seule teinte ocre-brun du clair au foncé, taille et liseré en plus). Réglages : période (5, 3 ou 1 an), gravité (tous, avec hospitalisés ou tués, mortels). Fiche : date et heure, luminosité, météo, route, décomptes de personnes par gravité, véhicules impliqués. **Aucune donnée individuelle** : ni âge ni sexe, jamais lus par le serveur. | ONISR, [data.gouv.fr](https://www.data.gouv.fr/datasets/bases-de-donnees-annuelles-des-accidents-corporels-de-la-circulation-routiere-annees-de-2005-a-2024/) (Licence Ouverte) |
| Vent | Le vent à 10 m, animé en traînées, d'après la prévision ARPEGE (suit l'horloge). | Météo-France ARPEGE via [Open-Meteo](https://open-meteo.com) |
| Ombres des bâtiments | L'ombre portée de chaque bâtiment selon la position du soleil, à partir du zoom 14. | calcul astronomique, bâtiments OpenStreetMap |

Les couleurs des trains ont été vérifiées pour le daltonisme. Trois familles (TER, grande vitesse, Intercités) reprennent les trois premières couleurs de la palette de référence. Le mode « retard » utilise une seule teinte, de plus en plus sombre, car le vert et le rouge sont confondus par les daltoniens.

### Le rideau des photos aériennes

MapLibre ne sait pas découper une couche à l'écran, et avec le relief 3D ses couches raster sont dessinées dans des textures par tuile, puis plaquées sur le terrain : un masque d'écran n'y change rien. Le module (`web/src/modules/aerialCurtain.ts`) dessine donc lui-même les tuiles de l'IGN dans une **couche WebGL « custom »** : chaque tuile est un maillage de 8 × 8 cases dont les sommets prennent l'altitude affichée du relief (`queryTerrainElevation`), et un `discard` dans le shader sur `gl_FragCoord.x` fait le rideau. La couche s'intercale sous les étiquettes : noms de lieux et couches deck.gl restent par-dessus la photo. Une deuxième carte synchronisée aurait coûté un second rendu du relief et caché ces couches du côté photo. Limites : les bâtiments 3D d'aujourd'hui dépassent de la photo quand la carte est inclinée ; indisponible sur le globe.

### Les accidents de la route

`server/src/accidents.rs` retrouve dans le catalogue de data.gouv.fr les quatre fichiers des cinq dernières années complètes (leurs noms changent d'une année à l'autre, et la clé de 2022 s'appelle `Accident_Id`), les télécharge un par un, les joint sur `Num_Acc` et ne garde que 24 octets par accident, servis **en colonnes** et compressés en gzip (`/api/accidents`, 5 Mo environ). Seuls des *décomptes* de personnes par gravité sont lus (colonnes `grav` et `catu`) ; l'âge et le sexe ne sont jamais chargés. Le cache vit dans `DATA_DIR/accidents/` ; le catalogue est relu chaque mois.

## Sources et licences

| Quoi | Source | Licence / condition |
|---|---|---|
| Fond de carte | [OpenFreeMap](https://openfreemap.org), données OpenStreetMap | ODbL : l'attribution doit rester visible |
| Voies ferrées | OpenStreetMap, via l'API [Overpass](https://overpass-api.de) | ODbL |
| Horaires et temps réel | SNCF, via [transport.data.gouv.fr](https://transport.data.gouv.fr) | ODbL |
| Photos aériennes anciennes | IGN, Géoplateforme : `data.geopf.fr/wmts` (couches `ORTHOIMAGERY.ORTHOPHOTOS.1950-1965`, etc.) | Licence Etalab 2.0, mention « IGN » |
| Monuments historiques | Base Mérimée (CSV hebdomadaire, ~100 Mo, lu en continu par le serveur puis effacé) | Licence Ouverte 2.0, mention « Ministère de la Culture » |
| Accidents de la route | ONISR : quatre CSV par année (caractéristiques, lieux, usagers, véhicules) trouvés par l'API de data.gouv.fr, lus un par un en continu puis effacés | Licence Ouverte, mention « ONISR » |
| Relief | [Mapterhorn](https://mapterhorn.com/attribution) | attribution |
| Séismes | EMSC | attribution |
| Vigilance crues | Vigicrues (SCHAPI) | licence ouverte |
| Électricité | RTE éCO2mix, via ODRÉ | licence ouverte |
| Carburants | prix-carburants.gouv.fr (ministère de l'Économie) | licence ouverte |
| Vélos en libre-service | chaque réseau, via transport.data.gouv.fr | licence ouverte ou ODbL selon le réseau |
| Feux | NASA FIRMS (capteurs VIIRS) | libre, citer la NASA |
| Qualité de l'air | Atmo France / AASQA, via Atmo Data (compte requis) | données ouvertes, citer « Atmo France / AASQA » |
| Avions | adsb.lol (récepteurs ADS-B de la communauté) | ODbL |
| Bateaux | aisstream.io (récepteurs AIS de la communauté) | gratuit, clé personnelle à garder sur le serveur |
| Population | INSEE, Filosofi 2019, revenus, pauvreté et niveau de vie, données carroyées de 200 m | licence ouverte Etalab 2.0, citer « INSEE, Filosofi 2019 » |
| Couverture mobile | ARCEP, Mon réseau mobile, cartes de couverture théorique 2026 T2 (data.arcep.fr) ; contours des départements Etalab / IGN Admin Express (masque de terre) | Licence Ouverte, citer « ARCEP, Mon réseau mobile » |
| Prix de l'immobilier | DGFiP, DVF géolocalisées par Etalab (ventes de logements) | licence ouverte 2.0, citer « DGFiP, DVF ; Etalab » ; ni ré-identification ni indexation par les moteurs de recherche |

| Élections | Ministère de l'Intérieur (résultats par bureau de vote) ; Etalab (contours des bureaux de vote) ; IGN (ADMIN EXPRESS COG CARTO) | Licence Ouverte 2.0 ; la présidentielle 2022 n'a pas de licence déclarée sur data.gouv.fr |
| Satellites | CelesTrak (éléments orbitaux GP) | libre ; au plus un téléchargement par groupe toutes les 2 h |

Le crédit de chaque module s'affiche dans le panneau des couches, et ceux du fond de carte en bas à droite.

## Points à connaître

- **MapLibre est volontairement en version 5.** deck.gl 9.4 utilise des éléments internes de MapLibre que la version 6 a renommés : la carte plante dès que le relief 3D est actif. Il faudra repasser en v6 quand deck.gl la prendra en charge.
- **Le globe et le relief ne vont jamais ensemble.** MapLibre 5 ne gère pas complètement le relief sur le globe, et faire pivoter la carte peut alors la figer. Passer au globe coupe donc le relief. Le réactiver ramène la carte à plat.
- **Des erreurs 404 sur `tiles.mapterhorn.com` apparaissent dans la console.** C'est normal : Mapterhorn ne fournit pas de tuiles au-dessus de l'océan.
- **Satellites : CelesTrak n'autorise qu'un téléchargement par groupe et par renouvellement (toutes les 2 h)**, sous peine d'erreur 403 puis de blocage de l'adresse. Seul le serveur télécharge, au plus toutes les 3 h, et garde chaque réponse dans `data/satellites/` : relancer le serveur ne retélécharge rien. Les positions sont calculées par le navigateur (SGP4, `satellite.js`).
- **Sur le globe, les icônes et les textes de deck.gl 9.4 ne s'affichent que si l'élimination des faces arrière est coupée.** Tous les modules passent donc les paramètres communs `OVER_MAP` de `map/parameters.ts`, qui contiennent `cullMode: 'none'`.
- **Ombres des bâtiments : calcul côté navigateur, pas deck.gl.** Les empreintes et hauteurs sont relues dans les tuiles que MapLibre a déjà chargées (`querySourceFeatures`), l'ombre de chaque bâtiment est balayée à l'opposé du soleil dans un canvas 2D, que MapLibre drape sur le relief sous les bâtiments 3D. Les effets d'ombre de deck.gl (`LightingEffect`) ne conviennent pas ici : ils demandent de redessiner les bâtiments par deck.gl, et ses couches se posent à l'altitude 0, sans suivre le relief de MapLibre. Visible à partir du zoom 14 ; le relief est ignoré dans le calcul de la longueur (l'ombre est seulement drapée sur la pente).
- **Les dépendances doivent avoir plus de 24 h.** pnpm refuse sur cette machine les paquets publiés depuis moins de 24 heures. Il ne faut pas contourner cette règle par une exemption.

## Feuille de route

| Phase | Contenu |
|---|---|
| **0. Socle** (fait) | Carte 3D, globe, relief, modules, horloge, fiche au clic, jour/nuit, séismes |
| **1. Trains** (fait) | Horaires et temps réel SNCF, serveur Rust, trains sur les vraies voies avec leur altitude et un profil de vitesse réaliste, couleur par type ou par retard, trajet et arrêts au clic, tableau d'affichage des gares, caméra qui suit, voies ferrées par vitesse. Le réseau est mis en cache par le navigateur et le rafraîchissement ne fige plus l'animation. Le serveur maison archive aussi le temps réel brut. |
| **2. Couches rapides** (en cours) | Fait : carburants, vigilance crues et météo, électricité par région, vélos en libre-service, bornes de recharge, feux, trafic routier, qualité de l'air (Atmo Data, avec un compte) |
| **3. Tout ce qui bouge** (fait) | Avions, bateaux, satellites, bus, trams et métros (positions en direct, ou estimées d'après les horaires en temps réel) |
| **Refonte** (fait) | Recherche universelle, interface neutre, scènes, frise, fiche unifiée, adresse partageable, téléphone, fond de carte calme et nuit sombre, nouveaux symboles (silhouettes d'avions, coques, rames voiture par voiture) |
| 4. Gros volumes | Population en 3D, immobilier, élections, accidents, couverture mobile, monuments |
| 5. Rendu avancé (en cours) | Fait : vent animé, radar de pluie, ombres des bâtiments. Reste : LiDAR, photos anciennes |
| 6. Intelligence | Fait : isochrones ferroviaires (RAPTOR). Reste : replay d'une journée, croisement des couches, questions en langage naturel, visite guidée |
