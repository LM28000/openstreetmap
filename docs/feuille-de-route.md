# Feuille de route

État des phases du projet (reprise de l'ancien README). Le détail daté est dans le [CHANGELOG](../CHANGELOG.md).

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
