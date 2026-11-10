# Carte vivante

Une carte 3D interactive de la France, avec des couches de données en temps réel : trains, météo, énergie, séismes…
Projet personnel pour apprendre.

## Lancer le projet

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
- `pnpm typecheck` et `pnpm build` dans `web/` ;
- `cargo test` et `cargo clippy` dans `server/`.

En développement, la carte est accessible depuis la console du navigateur via `window.__carte` (`map`, `overlay`, `clock`, `manager`).

### Utiliser un serveur installé ailleurs

Le site peut interroger un serveur qui tourne sur une autre machine, sans lancer Rust localement :

```bash
cd web
CARTE_API=http://192.168.0.75:8787 pnpm dev
```

## Serveur permanent (Docker)

Pour que le temps réel soit archivé en continu, le serveur tourne en permanence dans Docker (`compose.yaml`, `server/Dockerfile`).

```bash
git clone https://github.com/LM28000/openstreetmap.git carte-vivante && cd carte-vivante
mkdir -p data archive              # avant le premier démarrage : sinon Docker les crée au nom de root
cat > .env <<EOF
BIND_ADDRESS=192.168.0.75          # adresse d'écoute (127.0.0.1 par défaut : la machine seule)
RUN_AS=1000:1000                   # utilisateur:groupe propriétaire de data/ et archive/
ARCHIVE_PATH=./archive             # où garder les archives (environ 50 Mo par jour)
EOF
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
  src/map/             la carte : fond OSM, globe, relief, branchement de deck.gl
  src/modules/         une couche = un module
  src/ui/              panneau des couches, frise temporelle, fiche d'info
server/                le serveur (Rust : tokio, axum)
  src/timetable.rs     horaires SNCF (GTFS) en mémoire, trains en circulation sur une période
  src/realtime.rs      retards en temps réel (GTFS-RT), archivage optionnel
  src/gtfs_rt.rs       le format protobuf du temps réel, déclaré à la main (pas besoin de protoc)
  src/rails.rs         voies OSM : téléchargement, graphe, plus court chemin (A*)
  src/dem.rs           altitudes du relief (tuiles Mapterhorn)
  src/tracks.rs        tracé réel de chaque tronçon entre deux gares, avec altitude
  src/api.rs           l'API HTTP
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
  timeStepMs: 60_000,                    // redessiner une fois par minute simulée (0 = à chaque image)
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
| `native` | Couches MapLibre natives, pour les images drapées sur le relief (nuit, radar de pluie, photos anciennes). |

## Comment les trains sont placés

1. Le serveur charge les horaires théoriques (52 000 trajets) et interroge le temps réel SNCF toutes les 30 secondes.
2. Pour chaque paire de gares consécutives, il cherche le chemin sur les voies OSM : c'est un plus court chemin sur un graphe d'environ un million de points (A*). Il attribue ensuite à chaque point l'altitude du relief. Sur les ponts et dans les tunnels, une pente régulière remplace le sol, qui n'y est pas à la hauteur du rail.
3. Le site demande les trains de quelques heures autour de l'instant affiché. Pour chaque tronçon entre deux gares, il calcule un **profil de vitesse** : le train accélère au départ, roule à la vitesse permise de la voie (balise OSM `maxspeed`, connue pour 96 % des points), sans dépasser celle de son matériel (320 km/h en grande vitesse, 200 en Intercités, 160 en TER), puis freine avant la gare. Ce profil « au plus vite » est ensuite étiré pour tomber pile sur l'horaire, réel ou prévu, car les horaires comportent toujours une marge.
4. À chaque image, le site place chaque train le long de son tracé selon ce profil, et le dessine dans son sens de marche.
5. Si un tronçon n'a pas de tracé (voie absente d'OSM, gare trop loin d'une voie), le train y va en ligne droite. La fiche du train l'indique.

La vitesse affichée est donc une **estimation**. La SNCF ne publie pas la position GPS de ses trains en open data.

**Clic sur un train** : tout son trajet est surligné, avec la partie déjà faite en gris. Sa fiche liste les arrêts avec leurs horaires et retards, et donne la vitesse estimée et la vitesse autorisée de la ligne. Le bouton « Suivre » fait suivre le train par la caméra ; déplacer la carte arrête le suivi.

**Clic sur une gare** (visibles à partir du zoom 8,5) : son tableau des départs et des arrivées, trains supprimés compris. Chaque ligne d'un tableau mène au train ou à la gare correspondante.

## Couches disponibles

| Couche | Ce qu'elle montre | Source |
|---|---|---|
| Trains | TGV, Intercités et TER à leur position, sur les vraies voies, avec leurs retards et une vitesse estimée. Couleur par type ou par retard. Trajet et arrêts au clic, tableau d'affichage des gares, caméra qui suit. | SNCF, OpenStreetMap |
| Vigilance crues | Niveau de vigilance des 337 tronçons de rivières surveillés, de vert à rouge (épaisseur du trait selon le niveau). Couche MapLibre drapée sur le relief. | [Vigicrues](https://www.vigicrues.gouv.fr) |
| Séismes | Les 7 derniers jours : tous autour de la France, magnitude 4,5 et plus dans le monde. Ceux de moins de 3 h pulsent. | [EMSC](https://www.seismicportal.eu) |
| Électricité | Sur chaque région, une colonne 3D empile la production par filière, et un anneau blanc marque la consommation. Au quart d'heure, et suit la frise temporelle. | RTE éCO2mix via [ODRÉ](https://odre.opendatasoft.com) |
| Carburants | Prix actuels dans les 9 800 stations-service, colorés par rapport au reste de la France (bleu moins cher, rouge plus cher), au choix du carburant. Vu de près, une étiquette de prix ; la moins chère l'emporte quand deux étiquettes se gêneraient. | [prix-carburants.gouv.fr](https://www.prix-carburants.gouv.fr) |
| Jour et nuit | L'ombre de la nuit et des crépuscules. Les bâtiments 3D sont éclairés depuis la vraie position du soleil. | calcul astronomique |

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

Le crédit de chaque module s'affiche dans le panneau des couches, et ceux du fond de carte en bas à droite.

## Points à connaître

- **MapLibre est volontairement en version 5.** deck.gl 9.4 utilise des éléments internes de MapLibre que la version 6 a renommés : la carte plante dès que le relief 3D est actif. Il faudra repasser en v6 quand deck.gl la prendra en charge.
- **Le globe et le relief ne vont jamais ensemble.** MapLibre 5 ne gère pas complètement le relief sur le globe, et faire pivoter la carte peut alors la figer. Passer au globe coupe donc le relief. Le réactiver ramène la carte à plat.
- **Des erreurs 404 sur `tiles.mapterhorn.com` apparaissent dans la console.** C'est normal : Mapterhorn ne fournit pas de tuiles au-dessus de l'océan.
- **Les dépendances doivent avoir plus de 24 h.** pnpm refuse sur cette machine les paquets publiés depuis moins de 24 heures. Il ne faut pas contourner cette règle par une exemption.

## Feuille de route

| Phase | Contenu |
|---|---|
| **0. Socle** (fait) | Carte 3D, globe, relief, modules, horloge, fiche au clic, jour/nuit, séismes |
| **1. Trains** (en cours) | Fait : horaires et temps réel SNCF, serveur Rust, trains sur les vraies voies avec leur altitude et un profil de vitesse réaliste, couleur par type ou par retard, trajet et arrêts au clic, tableau d'affichage des gares, caméra qui suit. Reste : archivage sur le serveur maison, réponse plus légère (à chaque rafraîchissement du temps réel, une image de ~150 ms le temps que deck.gl renvoie les traînées à la carte graphique) |
| **2. Couches rapides** (en cours) | Fait : carburants, vigilance crues, électricité par région. Reste : qualité de l'air, incendies, vélos en libre-service |
| 3. Tout ce qui bouge | Bus, métros et trams, avions, bateaux, satellites |
| 4. Gros volumes | Population en 3D, immobilier, élections, accidents, couverture mobile, monuments |
| 5. Rendu avancé | Vent animé, radar de pluie, ombres, LiDAR, photos anciennes |
| 6. Intelligence | Isochrones, replay d'une journée, croisement des couches, questions en langage naturel, visite guidée |
