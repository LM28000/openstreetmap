# Sources de données et licences

La licence MIT du dépôt ([LICENSE](../LICENSE)) couvre **le code uniquement**. Les données affichées gardent leurs propres licences et conditions de réutilisation : elles ne sont pas redistribuées avec le dépôt (le serveur les télécharge depuis leur source à l'exécution), et le crédit de chaque couche s'affiche dans le panneau des couches ; ceux du fond de carte s'affichent en bas à droite de la carte.

Si vous déployez votre propre instance, vous devenez responsable du respect de ces conditions. Trois points demandent de l'attention :

- **DVF (prix de l'immobilier)** : réutilisation soumise à l'article R112 A-3 du Livre des procédures fiscales : **pas de ré-identification des personnes, pas d'indexation par les moteurs de recherche**. Le serveur applique des mesures techniques (aucune adresse, date réduite au mois, position arrondie à ~20 m, en-tête `X-Robots-Tag: noindex, nofollow, noarchive` sur toutes les tuiles) : ne les retirez pas. Voir [moteur-de-tuiles.md](moteur-de-tuiles.md#prix-de-limmobilier-dvf).
- **OpenStreetMap et ODbL** : le fond de carte, les voies ferrées et les bâtiments sont des données OpenStreetMap sous licence ODbL ; l'attribution doit rester visible. Les données ODbL dérivées (SNCF, Île-de-France Mobilités, adsb.lol, certains réseaux de vélos et de cars) imposent le partage à l'identique des bases de données dérivées que vous publieriez.
- **Open-Meteo (vent)** : l'API gratuite est réservée à un **usage non commercial** et demande l'attribution CC BY 4.0 (voir `server/src/wind.rs`).

Les clés personnelles (aisstream.io, Atmo Data, PRIM d'Île-de-France Mobilités) sont gratuites, strictement personnelles et ne doivent jamais être publiées : voir [SECURITY.md](../.github/SECURITY.md).

## Tableau des sources

| Quoi | Source | Licence / condition |
|---|---|---|
| Fond de carte | [OpenFreeMap](https://openfreemap.org), données OpenStreetMap | ODbL : l'attribution doit rester visible |
| Voies ferrées | OpenStreetMap, via l'API [Overpass](https://overpass-api.de) | ODbL |
| Horaires et temps réel | SNCF, via [transport.data.gouv.fr](https://transport.data.gouv.fr) | ODbL |
| Relief LiDAR HD | IGN, Géoplateforme : WMTS `data.geopf.fr/wmts` (couches `IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW`, `…MNS…SHADOW`, `…MNH…SHADOW`, TileMatrixSet `PM`, zoom 0 à 18) et WMS-Raster `data.geopf.fr/wms-r/wms` (couche `IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G`, style `hypso_mnh`, EPSG:3857), sans clé | Licence Etalab 2.0, mention « IGN, LiDAR HD » |
| Photos aériennes anciennes | IGN, Géoplateforme : `data.geopf.fr/wmts` (couches `ORTHOIMAGERY.ORTHOPHOTOS.1950-1965`, etc.) | Licence Etalab 2.0, mention « IGN » |
| Monuments historiques | Base Mérimée (CSV hebdomadaire, ~100 Mo, lu en continu par le serveur puis effacé) | Licence Ouverte 2.0, mention « Ministère de la Culture » |
| Accidents de la route | ONISR : quatre CSV par année (caractéristiques, lieux, usagers, véhicules) trouvés par l'API de data.gouv.fr, lus un par un en continu puis effacés | Licence Ouverte, mention « ONISR » |
| Relief | [Mapterhorn](https://mapterhorn.com/attribution) | attribution |
| Séismes | EMSC | attribution |
| Vigilance crues | Vigicrues (SCHAPI) | licence ouverte |
| Marégraphes (niveau de la mer) | [REFMAR](https://refmar.shom.fr), Shom et partenaires : `services.data.shom.fr/maregraphie/observation/json/<station>` (sans clé) | Licence Ouverte 2.0 (jeux « RONIM » et « partenaires » sur data.gouv.fr), mention « Shom, REFMAR » ; mesures brutes non validées |
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
| Vent | Open-Meteo (modèle ARPEGE Europe de Météo-France), API gratuite sans clé | CC BY 4.0, usage non commercial ; la grille de 0,5° et une collecte toutes les 6 h respectent les quotas |
| Radar de pluie | RainViewer, `api.rainviewer.com` | Mention de la source obligatoire ; recolorisation des images permise par les conditions d'utilisation ; 500 requêtes par minute et par adresse IP (vérifié en novembre 2026) |
| Géocodage des adresses | IGN, Géoplateforme (`data.geopf.fr/geocodage`), sans clé | Licence Etalab 2.0 |
| Vigilance météo | Météo-France via data.gouv.fr, contours IGN Admin Express | Licence Ouverte 2.0 |
| Trafic routier | Bison Futé via transport.data.gouv.fr ; Rennes Métropole | Licence Ouverte 2.0 ; ODbL |
| Bornes de recharge | Base nationale des IRVE (transport.data.gouv.fr) | Licence Ouverte 2.0 |
| Bus, trams et métros | réseaux de transport via transport.data.gouv.fr (GTFS-RT) | Licence Ouverte 2.0 ou ODbL selon le réseau (la licence de chaque réseau est affichée dans l'app) |
| Île-de-France | Île-de-France Mobilités, plateforme PRIM (GTFS et SIRI), clé personnelle ; quota de 1 000 requêtes par jour | ODbL |
| Cars interurbains (isochrones) | 57 réseaux du catalogue transport.data.gouv.fr (BreizhGo, Aléop, liO, Fluo, Rémi, Mobigo, ZOU !, Nomad, départements…) | licence ouverte de chaque réseau |

## Conditions à retenir, source par source

- **OpenStreetMap / OpenFreeMap** : ODbL, attribution « © OpenStreetMap contributors » visible (le contrôle d'attribution de MapLibre l'affiche).
- **IGN (Géoplateforme)** : photos aériennes anciennes, LiDAR HD, ADMIN EXPRESS, géocodage : Licence Etalab 2.0 ; mentions « IGN » et « IGN, LiDAR HD ».
- **INSEE** : Filosofi 2019 en licence ouverte Etalab 2.0, à citer « INSEE, Filosofi 2019 ». Secret statistique : voir la part de valeurs imputées dans [moteur-de-tuiles.md](moteur-de-tuiles.md#population-carreaux-insee).
- **ARCEP** : Licence Ouverte, à citer « ARCEP, Mon réseau mobile » ; ce sont des simulations des opérateurs, pas des mesures.
- **Ministère de l'Intérieur** : résultats électoraux en Licence Ouverte 2.0 (la présidentielle 2022 n'a pas de licence déclarée sur data.gouv.fr) ; contours des bureaux de vote d'Etalab sans valeur officielle.
- **ONISR** : Licence Ouverte, mention « ONISR » ; aucune donnée individuelle (âge et sexe ne sont jamais lus).
- **Ministère de la Culture (Mérimée)** : Licence Ouverte 2.0.
- **Shom (REFMAR)** : Licence Ouverte 2.0, mention « Shom, REFMAR » ; mesures brutes non validées ; les prédictions officielles de marée ne sont pas des données ouvertes et ne sont pas utilisées.
- **SNCF** : ODbL, via transport.data.gouv.fr.
- **adsb.lol** : ODbL, crédit affiché ; **aisstream.io** : gratuit, clé personnelle, à garder sur le serveur.
- **CelesTrak** : au plus un téléchargement par groupe toutes les 2 h sous peine de blocage de l'adresse ; seul le serveur télécharge (au plus toutes les 3 h) et garde les réponses dans `data/satellites/`.
- **NASA FIRMS** : libre, citer la NASA ; **EMSC** : citer l'EMSC.
- **Atmo France / AASQA** : données ouvertes via Atmo Data (compte requis), à citer « Atmo France / AASQA ».
- **Mapterhorn** : relief, attribution ([mapterhorn.com/attribution](https://mapterhorn.com/attribution)).

Les positions d'avions et de navires proviennent de récepteurs communautaires publics.
