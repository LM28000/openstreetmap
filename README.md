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
- **Sous la recherche, les pastilles des couches affichées.** Un clic ouvre leurs réglages, la croix les masque. Le bouton « Couches » ouvre le catalogue, avec un filtre et quatre scènes prêtes à l'emploi : Ce qui bouge, Météo, Énergie, Ma ville.
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
docker compose up -d --build       # installer, ou mettre à jour après un git pull
docker compose logs -f             # suivre les journaux
```

Le conteneur est isolé : son système de fichiers est en lecture seule, il n'a aucun privilège, sa mémoire est limitée à 1 Go (le pic mesuré est de 540 Mo) et ses journaux sont bornés à 30 Mo. Il n'écoute que sur l'adresse choisie et n'est pas exposé à Internet.

Les archives sont rangées dans `archive/sncf-trip-updates/AAAA-MM-JJ/HHMMSS.pb.gz`, une par version du flux temps réel.

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
  src/api.rs           l'API HTTP
  src/transit.rs       bus, trams et métros en direct (flux GTFS-RT de transport.data.gouv.fr, noms de lignes lus dans routes.txt des GTFS)
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

## Couches disponibles

| Couche | Ce qu'elle montre | Source |
|---|---|---|
| Trains | TGV, Intercités et TER à leur position, sur les vraies voies, avec leurs retards et une vitesse estimée. Couleur par type ou par retard ; de près (zoom 13), chaque rame est dessinée voiture par voiture sur sa vraie longueur, nez effilé pour la grande vitesse. Gares de trois tailles selon leur trafic. Trajet et arrêts au clic, tableau d'affichage des gares, caméra qui suit. | SNCF, OpenStreetMap |
| Voies ferrées | Les lignes empruntées par les trains de voyageurs, telles que le serveur les a calculées sur les voies OSM. Trait discret, ou nuances de gris selon la vitesse maximale de la ligne (épaisseur comprise). Fiche au clic : gares du tronçon, longueur, répartition des vitesses, lien vers OpenRailwayMap. | OpenStreetMap |
| Avions | Les avions au-dessus de la France et autour, en direct, à leur altitude réelle (couleur selon l'altitude), avec leur indicatif. Sept silhouettes vues de dessus selon le type d'appareil (biréacteur, gros-porteur, quadriréacteur, turbopropulseur, jet d'affaires, avion léger, hélicoptère), à l'envergure réelle de près ; anneau rouge pour une urgence déclarée (squawk 7500, 7600, 7700). Fiche au clic, caméra qui suit. En direct seulement. | [adsb.lol](https://adsb.lol) |
| Bateaux | Les navires autour de la France et sur les fleuves, d'après leurs émissions AIS : couleur par famille (marchandises, passagers, pêche et plaisance), huit coques selon le type AIS (porte-conteneurs, pétrolier, ferry, pêche, voilier…), sillage proportionnel à la vitesse, taille réelle de près, noms en étiquettes de carte sans chevauchement. Fiche au clic (destination, dimensions…), caméra qui suit. En direct seulement ; demande une clé aisstream.io sur le serveur. | [aisstream.io](https://aisstream.io) |
| Bus, trams et métros | Les véhicules des transports urbains en direct, dans les ~140 réseaux français qui publient leurs positions (GTFS-RT, relues toutes les 30 s). Couleur et numéro de la ligne quand le réseau les donne ; silhouettes de bus, de tram et de métro orientées selon le cap, contour en pointillé pour une position estimée d'après les horaires (47 réseaux). De loin, un rond par réseau ; de près, chaque véhicule, qui glisse d'une position à la suivante. Fiche au clic. En direct seulement. | réseaux de transport via [transport.data.gouv.fr](https://transport.data.gouv.fr) (Licence Ouverte 2.0 ou ODbL) |
| Vélos en libre-service | Les 5 800 stations des 84 réseaux de France (Vélib', Vélo'v, VélôToulouse…), relues chaque minute. Mode « Vélos » pour en trouver un, « Places » pour le rendre ; vu de près, une jauge en anneau donne la part de vélos disponibles, avec le nombre. Une station hors service est un simple anneau gris. | réseaux GBFS via [transport.data.gouv.fr](https://transport.data.gouv.fr) |
| Vigilance crues | Niveau de vigilance des 337 tronçons de rivières surveillés, de vert à rouge (épaisseur du trait selon le niveau). Couche MapLibre drapée sur le relief. | [Vigicrues](https://www.vigicrues.gouv.fr) |
| Bornes de recharge | Les 45 000 stations de recharge pour véhicules électriques, colorées selon leur puissance maximale (quatre classes de turquoise) ; pictogramme de prise et puissance écrite de près. Réglages : puissance (toutes, rapides, ultra-rapides) et accès. Fiche : opérateur, prises, tarif, horaires. Pas de disponibilité en temps réel. | Base nationale des IRVE, [transport.data.gouv.fr](https://transport.data.gouv.fr) (Licence Ouverte 2.0) |
| Trafic routier | Événements du réseau routier national non concédé (bouchons, accidents, fermetures, travaux, dangers ; un pictogramme par famille) et état de la circulation (fluide à coupé) autour des grandes villes. Réglage Événements / État / Les deux. Les autoroutes concédées ne sont pas couvertes. | Bison Futé via transport.data.gouv.fr (Licence Ouverte 2.0), Rennes Métropole (ODbL) |
| Vigilance météo | Niveau de vigilance de chaque département, aujourd'hui et demain (suit l'horloge), doublé d'une trame et d'un contour. Fiche : phénomènes et créneaux. | Météo-France via data.gouv.fr (Licence Ouverte 2.0), contours IGN Admin Express |
| Feux | Points chauds détectés par satellite sur 7 jours (incendies, brûlages agricoles, sites industriels). La couleur dit l'âge à l'instant affiché, la taille la puissance du feu : on les voit apparaître en rejouant la semaine. | [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov) (VIIRS) |
| Séismes | Les 7 derniers jours : tous autour de la France, magnitude 4,5 et plus dans le monde. Ceux de moins de 3 h pulsent. | [EMSC](https://www.seismicportal.eu) |
| Électricité | Sur chaque région, une colonne 3D empile la production par filière, et un anneau blanc marque la consommation. Au quart d'heure, et suit la frise temporelle. | RTE éCO2mix via [ODRÉ](https://odre.opendatasoft.com) |
| Carburants | Prix actuels dans les 9 800 stations-service, colorés par rapport au reste de la France (bleu moins cher, rouge plus cher), au choix du carburant. Vu de près, une étiquette de prix ; la moins chère l'emporte quand deux étiquettes se gêneraient. | [prix-carburants.gouv.fr](https://www.prix-carburants.gouv.fr) |
| Satellites | Stations spatiales (ISS, Tiangong), satellites de navigation, météo et les plus brillants, en silhouettes neutres, à leur position calculée pour l'instant affiché (replay compris) ; Starlink en option. Altitude figurée par une tige (échelle non respectée), trace au sol de l'orbite au clic, visibilité de l'ISS depuis le centre de la carte. | [CelesTrak](https://celestrak.org) |
| Jour et nuit | Le fond de carte passe à sa palette sombre la nuit (soleil au centre de la vue), l'ombre de la nuit et des crépuscules se voit de loin. Les bâtiments 3D sont éclairés depuis la vraie position du soleil. | calcul astronomique |
| Radar de pluie | Les précipitations mesurées par radar, des deux dernières heures, drapées sur le relief. | [RainViewer](https://www.rainviewer.com) |
| Vent | Le vent à 10 m, animé en traînées, d'après la prévision ARPEGE (suit l'horloge). | Météo-France ARPEGE via [Open-Meteo](https://open-meteo.com) |
| Ombres des bâtiments | L'ombre portée de chaque bâtiment selon la position du soleil, à partir du zoom 14. | calcul astronomique, bâtiments OpenStreetMap |

Les couleurs des trains ont été vérifiées pour le daltonisme. Trois familles (TER, grande vitesse, Intercités) reprennent les trois premières couleurs de la palette de référence. Le mode « retard » utilise une seule teinte, de plus en plus sombre, car le vert et le rouge sont confondus par les daltoniens.

## Sources et licences

| Quoi | Source | Licence / condition |
|---|---|---|
| Fond de carte | [OpenFreeMap](https://openfreemap.org), données OpenStreetMap | ODbL : l'attribution doit rester visible |
| Voies ferrées | OpenStreetMap, via l'API [Overpass](https://overpass-api.de) | ODbL |
| Horaires et temps réel | SNCF, via [transport.data.gouv.fr](https://transport.data.gouv.fr) | ODbL |
| Relief | [Mapterhorn](https://mapterhorn.com/attribution) | attribution |
| Séismes | EMSC | attribution |
| Vigilance crues | Vigicrues (SCHAPI) | licence ouverte |
| Électricité | RTE éCO2mix, via ODRÉ | licence ouverte |
| Carburants | prix-carburants.gouv.fr (ministère de l'Économie) | licence ouverte |
| Vélos en libre-service | chaque réseau, via transport.data.gouv.fr | licence ouverte ou ODbL selon le réseau |
| Feux | NASA FIRMS (capteurs VIIRS) | libre, citer la NASA |
| Avions | adsb.lol (récepteurs ADS-B de la communauté) | ODbL |
| Bateaux | aisstream.io (récepteurs AIS de la communauté) | gratuit, clé personnelle à garder sur le serveur |
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
| **2. Couches rapides** (en cours) | Fait : carburants, vigilance crues et météo, électricité par région, vélos en libre-service, bornes de recharge, feux, trafic routier. Reste : qualité de l'air (l'API d'Atmo France demande un compte) |
| **3. Tout ce qui bouge** (fait) | Avions, bateaux, satellites, bus, trams et métros (positions en direct, ou estimées d'après les horaires en temps réel) |
| **Refonte** (fait) | Recherche universelle, interface neutre, scènes, frise, fiche unifiée, adresse partageable, téléphone, fond de carte calme et nuit sombre, nouveaux symboles (silhouettes d'avions, coques, rames voiture par voiture) |
| 4. Gros volumes | Population en 3D, immobilier, élections, accidents, couverture mobile, monuments |
| 5. Rendu avancé (en cours) | Fait : vent animé, radar de pluie, ombres des bâtiments. Reste : LiDAR, photos anciennes |
| 6. Intelligence | Isochrones, replay d'une journée, croisement des couches, questions en langage naturel, visite guidée |
