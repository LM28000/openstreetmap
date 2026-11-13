# Utiliser Vigie

Le serveur maison sert la carte en permanence, sur le réseau de la maison : **http://192.168.0.75:8787/**. Aucun programme n'a besoin de tourner sur l'ordinateur qui l'affiche.

L'écran a quatre zones fixes. Au repos, elles couvrent moins de 15 % de la carte.
- **En haut à gauche, la recherche** (`⌘K` ou `/`) trouve d'une seule barre :
  - une ville ou une adresse (géocodage de l'IGN) ;
  - une gare et ses départs ;
  - un train par son numéro ;
  - un vol, un navire, une ligne de bus ;
  - une station de vélos, une borne, une couche, une scène ;
  - une date (« demain 8h », « il y a 2 h », « direct »).
- **Sous la recherche, les pastilles des couches affichées.** Un clic ouvre leurs réglages, la croix les masque. Le bouton « Couches » ouvre le catalogue, avec un filtre et des scènes prêtes à l'emploi (Ce qui bouge, Météo, Qualité de l'air, Énergie, Ma ville…) et la visite guidée.
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

### Visite guidée

Une visite de trois minutes, douze étapes, jouée sur la vraie carte : les trains de France, Paris à l'heure de pointe (rejouée d'après l'enregistrement du serveur), un avion suivi à Roissy, le Pas-de-Calais, les isochrones depuis Paris avec la population à portée, les colonnes d'habitants, le prix du m², les zones blanches des Alpes, les élections, les photos aériennes des années 50 (le rideau glisse seul), le vent et la pluie, la nuit.

- **Pour la lancer** : bouton « Visite guidée » de l'accueil (première visite), en tête des scènes du catalogue des couches, commande « visite » de la recherche, ou lien avec `#visite` (le drapeau est retiré de l'adresse dès qu'il est lu).
- **Commandes** : pause, étape précédente et suivante, `Espace` (pause), `←` `→` (étape), `Échap` (quitter). Glisser ou zoomer sur la carte met la visite en pause ; la reprise repart de l'étape. Avec `prefers-reduced-motion`, la caméra saute au lieu de voler.
- **Quitter** rend l'état d'avant : caméra, couches, réglages, instant, objet choisi, relief et projection.
- **Données absentes** : une légende n'apparaît qu'une fois les données de l'étape à l'écran (`ready`) ; sans données après un délai (navires, avions la nuit, isochrones non prêtes), l'étape est passée et un avis le dit. Les étapes rejouées cherchent un enregistrement couvert sur sept jours, sinon elles passent au direct ou sont sautées.
- **Ajouter ou changer une étape** : c'est une entrée de `web/src/core/tourStops.ts` (caméra, couches, réglages, instant, test `ready`, légende) ; la mécanique est dans `core/tour.ts`, le panneau dans `ui/Tour.tsx`. En développement, `window.__tour` donne la main depuis la console.

Le fond de carte (OpenFreeMap Liberty) est retouché au chargement (`map/calmStyle.ts`) :
- les routes sont en gris chaud, l'eau en bleu-gris, avec moins de libellés de loin ;
- il passe à une vraie palette sombre la nuit, selon le soleil au centre de la vue.

La couleur reste ainsi réservée aux données.

Les véhicules sont des **maquettes 3D** de près : avions (dès le zoom 6,5), bateaux (zoom 10), trains voiture par voiture (zoom 13), bus, trams et métros (zoom 15). En deçà, ce sont des silhouettes à plat. Les maquettes sont construites dans le code (`web/src/models/`, aucun fichier à télécharger), à leurs dimensions réelles de près et agrandies jusqu'à une taille minimale à l'écran de loin. Le vrai soleil de l'instant affiché les éclaire quand la couche « Jour et nuit » est allumée. Elles passent derrière le relief et les bâtiments ; un train en tunnel reste visible en fantôme à plat. Chaque couche de véhicules a un réglage « Rendu » pour revenir aux symboles à plat.
