# Journal des changements

Historique du projet, regroupé par phase et par date, reconstruit à partir de l'historique git (`git log --reverse --format='%ad %s' --date=short`). Le projet n'a pas de numéro de version : les phases sont celles de la [feuille de route](docs/feuille-de-route.md). Les commits de fusion ne sont pas repris.

## 13 novembre 2026 — Analyse de zone

- Analyse de zone : outil de dessin (cercle, polygone, tactile), panneau de résultats, zone dans l'adresse (`zone=`) ([docs/analyse-de-zone.md](docs/analyse-de-zone.md)).
- Habitants sans 4G : couverture mobile croisée avec la grille de population, et moteur d'analyse côté serveur (`POST /api/analyse`).

## 12 novembre 2026 — Visite guidée, performance, nouvelles couches

- **Visite guidée** : douze étapes en trois minutes jouées sur la vraie carte (trains, pointe à Paris, avion suivi, détroit, isochrones, population, prix, zones blanches, élections, photos de 1950, météo, nuit).
- **Marées** : niveau de la mer aux marégraphes REFMAR (Shom), courbe de 48 h, marées estimées.
- **Relief LiDAR HD** : estompages MNT, MNS, MNH et hauteur du sursol en couleurs (IGN, Géoplateforme).
- **Élections** : municipales 2026, 1er et 2nd tour, nuance de la liste en tête, listes de la commune en fichier annexe.
- **Bus d'Île-de-France** : mesures sur le vrai GTFS, mémoire réduite (pas de « demain » pour les bus, heures non dupliquées), tests SIRI, recommandation de ne pas les activer avec 1 Go.
- **Performance** : échelle sans lecture du GPU pendant le mouvement, altitudes mémorisées, gares et véhicules posés sur le relief dans la vue seulement ; banc de mesure `perf/` (vues de ville de ~52 à ~17 ms par image).
- Prix de l'immobilier : fiche listant les ventes d'un même point, pastille du nombre dès le zoom 16.
- Photos anciennes sans trous ; aplats de tuiles au-dessus des ponts du fond de carte.
- Historique : l'archive brute SNCF est gardée 180 jours (`ARCHIVE_SNCF_JOURS`).

## 11 novembre 2026 — Phase 4 : gros volumes et moteur de tuiles

- **Accidents de la route** (ONISR) : collecte en colonnes, grille 3D puis un point par accident selon la gravité.
- **Population** : carreaux INSEE de 200 m en colonnes 3D.
- **Habitants atteints** par les isochrones (grille INSEE de 200 m, par tranche de 30 min).
- **Élections** : un jeu de tuiles par scrutin (présidentielle 2022, européennes 2024, législatives 2024), résultats par bureau de vote, commune et département.
- **Couverture mobile** (ARCEP) : rastérisation des polygones en grille de 250 m.
- **Prix de l'immobilier** (DVF) : source nettoyée, médianes par histogrammes fusionnables, carte divergente autour de la médiane.
- Photos aériennes anciennes, monuments historiques et accidents fusionnés.
- Fabrication des tuiles : une seule à la fois, `TUILES_JEUX`, mémoire bornée (élections sous 150 Mo).
- Mesure de mémoire des collecteurs (tests ignorés).

## 10 novembre 2026 — Moteur de tuiles, historique, isochrones, refonte, maquettes 3D

- **Moteur de tuiles vectorielles** : MVT, PMTiles v3, généralisation par zoom, service `/api/tuiles`.
- **Historique et relecture du passé** : avions, bateaux et transports enregistrés en tronçons colonnes compressés, retards des trains rejoués depuis l'archive du temps réel.
- **Photos aériennes anciennes** (IGN) avec rideau avant / après sur le relief 3D ; **monuments historiques** (base Mérimée).
- **Isochrones** : RAPTOR sur les horaires SNCF, puis multimodal (cars TER, Île-de-France, cars interurbains régionaux), itinéraire détaillé, durée au curseur, recherche « depuis Rennes », gare de départ dans l'adresse.
- **Transports d'Île-de-France** : métro, RER, Transilien, tramways d'après le GTFS d'IDFM et le SIRI global de PRIM.
- **Maquettes 3D** construites dans le code : avions (sept familles), bateaux par type AIS, trains voiture par voiture, bus, trams et métros ; éclairage par le vrai soleil.
- **Refonte de l'interface** : recherche universelle, chrome neutre, scènes, catalogue, frise du temps, fiche unifiée avec statuts (direct, rejoué, estimé, prévu), adresse partageable, feuille de téléphone ; fond de carte calme et nuit sombre ; nouveaux symboles.
- **Qualité de l'air** (Atmo Data) ; suivi d'un avion à son altitude.
- **Phase 3 : tout ce qui bouge** : avions (adsb.lol), satellites (CelesTrak, SGP4), bateaux (aisstream.io), bus, trams et métros (GTFS-RT, ~140 réseaux, positions estimées pour 47 réseaux).
- **Couches météo et ciel** : radar de pluie (RainViewer), vent animé (Open-Meteo, ARPEGE), ombres des bâtiments.
- **Couches rapides** : bornes de recharge, trafic routier, vigilance météo, carburants, vigilance crues, électricité par région, vélos en libre-service, feux détectés par satellite.
- Le serveur sert aussi le site ; image Docker : `MALLOC_ARENA_MAX=2` pour contenir l'empreinte mémoire.

## 9 et 10 novembre 2026 — Phases 0 et 1 : socle et trains

- **Phase 0 : socle** de la carte 3D : globe, relief, modules, horloge, fiche au clic, jour et nuit, séismes ; nuit plus lisible.
- **Phase 1 : trains** : serveur Rust, horaires et temps réel SNCF, trains sur les vraies voies avec leur altitude, trajet et arrêts au clic, tableau d'affichage des gares, caméra qui suit, vitesse réaliste (accélération, vitesse de la ligne, freinage), voies ferrées.
- Déploiement Docker du serveur (serveur maison) et README du serveur permanent.
