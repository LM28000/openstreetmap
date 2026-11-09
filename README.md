# Carte vivante

Une carte 3D interactive de la France, avec des couches de données en temps réel : trains, météo, énergie, séismes…
Projet personnel pour apprendre.

## Lancer le projet

```bash
cd web
pnpm install
pnpm dev        # http://localhost:5173
```

Autres commandes : `pnpm typecheck` (vérifie les types), `pnpm build` (version de production dans `web/dist`).

En développement, la carte est accessible depuis la console du navigateur via `window.__carte` (`map`, `overlay`, `clock`, `manager`).

## Organisation

```
web/                 le site (TypeScript, React, Vite)
  src/core/          le moteur, sans dépendance à React
    clock.ts         horloge globale (direct, pause, vitesse, saut dans le temps)
    module.ts        contrat d'un module de couche
    moduleManager.ts visibilité, chargements périodiques, rendu à chaque image
  src/map/           la carte : fond OSM, globe, relief, branchement de deck.gl
  src/modules/       une couche = un module
  src/ui/            panneau des couches, frise temporelle, fiche d'info
server/              (phase 1) le serveur Rust
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
  async load(signal) { /* fetch… */ },
  deckLayers({ data, time, terrain }) { /* couches deck.gl pour l'instant t */ },
  describe(objet) { /* contenu de la fiche au clic */ },
});
```

2. L'ajouter à la liste de `web/src/modules/index.ts`.

Deux options utiles :
- `followsTerrain: true` pour poser les objets sur le relief, avec `terrain.elevation(lon, lat)` ;
- `followsView: true` pour redessiner la couche après chaque déplacement de la carte.

Pour les images drapées sur le relief (nuit, radar de pluie, photos anciennes), un module peut utiliser des couches MapLibre natives (`native`) au lieu de deck.gl.

## Couches disponibles

| Couche | Ce qu'elle montre | Source |
|---|---|---|
| Séismes | Les 7 derniers jours : tous autour de la France, magnitude 4,5 et plus dans le monde. Ceux de moins de 3 h pulsent. | [EMSC](https://www.seismicportal.eu) |
| Jour et nuit | L'ombre de la nuit et des crépuscules. Les bâtiments 3D sont éclairés depuis la vraie position du soleil. | calcul astronomique |

## Sources et licences

| Quoi | Source | Licence / condition |
|---|---|---|
| Fond de carte | [OpenFreeMap](https://openfreemap.org), données OpenStreetMap | ODbL : l'attribution doit rester visible |
| Relief | [Mapterhorn](https://mapterhorn.com/attribution) | attribution |
| Séismes | EMSC | attribution |

Le crédit de chaque module s'affiche dans le panneau des couches, et ceux du fond de carte en bas à droite.

## Points à connaître

- **MapLibre est volontairement en version 5.** deck.gl 9.4 utilise des éléments internes de MapLibre que la version 6 a renommés : la carte plante dès que le relief 3D est actif. Il faudra repasser en v6 quand deck.gl la prendra en charge.
- **Des erreurs 404 sur `tiles.mapterhorn.com` apparaissent dans la console.** C'est normal : Mapterhorn ne fournit pas de tuiles au-dessus de l'océan.

## Feuille de route

| Phase | Contenu |
|---|---|
| **0. Socle** (fait) | Carte 3D, globe, relief, modules, horloge, fiche au clic, jour/nuit, séismes |
| 1. Trains | Horaires SNCF, recalage sur les voies OSM, retards en temps réel, serveur Rust, caméra qui suit un train, début de l'archivage |
| 2. Couches rapides | Carburants, rivières, qualité de l'air, incendies, vélos, réseau électrique |
| 3. Tout ce qui bouge | Bus, métros et trams, avions, bateaux, satellites |
| 4. Gros volumes | Population en 3D, immobilier, élections, accidents, couverture mobile, monuments |
| 5. Rendu avancé | Vent animé, radar de pluie, ombres, LiDAR, photos anciennes |
| 6. Intelligence | Isochrones, replay d'une journée, croisement des couches, questions en langage naturel, visite guidée |
