# Design system de Vigie

La source de vérité de l'apparence de Vigie : règles de marque, jetons, composants et logo. L'appli s'y conforme (`web/src/styles.css` pour l'interface, `web/src/design/tokens.ts` pour les palettes des couches).

| Fichier | Contenu |
|---|---|
| [`tokens.json`](tokens.json) | Tous les jetons : 89 couleurs (thèmes `jour` et `nuit` de la carte), typographie, espacements, rayons, ombre |
| [`tokens.css`](tokens.css) | Les mêmes, en propriétés CSS (`--ui-ink`, `--space-4`…) et classes de styles de texte. Les fichiers de police viennent des paquets `@fontsource` du site. |
| [`composants/`](composants) | Guides des composants (Pastille, Bouton, Fiche, Réglage, Légende) et un aperçu HTML de chacun, à ouvrir avec `tokens.css` |
| [`logos/`](logos) | Le logo, sur tuile et sans fond |

Un changement de couleur ou d'échelle se fait d'abord ici, puis dans le code.

Vigie montre la France en direct : trains, avions, bateaux, météo, territoire, et le passé qu'on rejoue. La carte est le sujet ; l'interface se tient en retrait, sombre et neutre, pour que **la couleur appartienne aux données**.

## Principes

- **La carte d'abord.** Les panneaux sont opaques, sombres et compacts, posés aux quatre coins : recherche et pastilles en haut à gauche, fiche à droite, frise en bas, commandes de la carte en bas à droite. Sous 720 px, une feuille tirée du bas remplace fiche, catalogue et frise.
- **La couleur dit une donnée, jamais une décoration.** Le chrome n'utilise que des neutres bleutés (`ui-*`). Chaque couche a sa teinte ou sa rampe, et deux couches d'une même scène ne partagent jamais une teinte.
- **Le rouge veut dire « en direct ».** `ui-live` sert à la pastille En direct, au point du logo et à une urgence aérienne. Rien d'autre n'est rouge vif : ni les erreurs (`ui-warn`), ni les données.
- **Tout chiffre dit d'où il vient.** Une fiche nomme sa source (« INSEE, Filosofi 2019 », « ARCEP, cartes théoriques ») et dit quand une valeur est estimée, imputée ou théorique.
- **Jour et nuit.** Le fond de carte suit le vrai soleil. Les rampes de données ont une version `jour` et une version `nuit` : la nuit, le plus fort devient le plus clair. Le chrome, lui, ne change pas.

## Rédaction

- **Français, vouvoiement, phrases courtes.** « Cliquez sur une gare pour voir jusqu'où on va. » Le tutoiement n'apparaît nulle part.
- **Majuscule en début de libellé seulement :** « Prix de l'immobilier », « Revenir au direct », jamais « Prix De L'Immobilier ».
- **Nombres à la française,** séparés par une espace fine : `1 177 habitants`, `2 631 €/m²`, `67,7 %`, `09:42`. Durées en `1 h 18`, retards en `+6 min`.
- **Dire ce qu'on voit, sans emphase :** « 242 gares et 1 756 arrêts en moins de 3 h ». Pas de point d'exclamation, pas d'emoji.
- **Une absence se dit :** « Pas d'enregistrement avant le 10 nov. à 21 h », « Étape passée : pas de données pour le moment ». On ne montre jamais une carte vide avec une légende qui prétend autre chose.
- **Les surtitres** (`eyebrow`) disent le type d'objet et la couche : « BUREAU DE VOTE · LÉGISL. 2024 · 2ND TOUR ».

## Couleur

### Interface

- Fond de tout panneau : `ui-glass` ; zones plus denses (feuille, menus) : `ui-glass-strong`. Pas de flou d'arrière-plan, pas de transparence au-delà des contrôles.
- Texte : `ui-ink` (principal), `ui-muted` (secondaire), `ui-faint` (métadonnées). Tous passent 4,5:1 sur les deux fonds ; ne descendez jamais plus clair que `ui-faint` pour du texte.
- Contrôles : `ui-control` au repos, `ui-control-hover` au survol, `ui-selected` pour le choix actif. Bordure des panneaux : `ui-line`, 1 px.
- Une seule action principale par panneau : fond `ui-primary`, texte `ui-primary-ink`.
- Focus clavier : anneau de 2 px en `ui-ink`, décalé de 2 px.
- Une seule ombre : `ui-shadow`, sur les panneaux flottants seulement.

### Données

- **Teintes catégorielles** (une couleur par catégorie) : trains `train-ter`, `train-gv`, `train-ic` ; transports `transit-bus`, `transit-tram`, `transit-metro` ; bateaux `ship-*` ; familles politiques `elec-*`. Toujours accompagnées d'une légende, et du nom dans la fiche.
- **Rampes séquentielles** (une seule teinte, du clair au foncé le jour) : `avion-alt-*`, `pop-*`, `iso-*`, `couv-*`, `pluie-*`, `accident-*`, `participation-*`.
- **Rampe divergente :** `immo-*`, deux teintes et un gris central (`immo-4`) pour la médiane de référence.
- **Statuts réservés aux états** (`status-vert`, `status-jaune`, `status-orange`, `status-rouge`) : crues, vigilance, trafic. Jamais pour une catégorie ou une grandeur, toujours avec un mot ou un motif (jaune et orange sont proches).
- **Toute nouvelle palette** passe le validateur de palettes en jour et en nuit, et ne reprend pas une teinte déjà prise dans la même scène. Teintes déjà prises : bleu (TER, participation, pluie, marine), orange (grande vitesse), vert (Intercités), violet (avions), framboise (isochrones), Sienne (population), ocre (accidents), olive (couverture), bleu-gris-rose (immobilier).

## Typographie

Trois familles, hébergées avec le site, sans autre police :

- `display` (Bricolage Grotesque 700) pour les titres seulement : `display` (accueil, visite, catalogue), `title` (fiche).
- `body` (Instrument Sans) pour l'interface : `body`, `body-strong`, `small`, `caption`.
- `data` (JetBrains Mono) pour tout ce qui se mesure : `figure` (chiffre clé), `data` (heures, numéros, valeurs), `eyebrow` (surtitre en capitales, interlettrage 0,12 em).

Règles : chiffres tabulaires (`font-variant-numeric: tabular-nums`) partout où des nombres s'alignent ; titres en `text-wrap: balance` ; pas de taille hors de l'échelle (pas de 12,5 px, 11,5 px, 10,5 px).

## Espacement, rayons, formes

- **Espacements :** `space-1` à `space-7` (2, 4, 6, 8, 12, 16, 24 px). Marge au bord de l'écran : `space-7` sur ordinateur, `space-5` sur téléphone. Marge interne d'un panneau : `space-6`. Écarts par `gap`, pas par marges.
- **Rayons :** `radius-sm` (badges, touches), `radius-md` (boutons, champs, réglages), `radius-lg` (panneaux), `radius-pill` (pastilles de couche, En direct, curseurs). Pas d'autre rayon.
- **Hauteurs de contrôle :** 34 px pour les pastilles et boutons, 46 px pour la recherche, 40 px de zone de toucher au minimum sur téléphone.
- **Symboles sur la carte :** chaque symbole a un halo sombre et un liseré clair pour se lire sur tous les fonds ; l'objet choisi porte un anneau de sélection blanc cerné de sombre. Les maquettes 3D sont éclairées par le vrai soleil.

## Iconographie

- Icônes de l'interface : tracés SVG maison en ligne, grille de 24, trait de 1,8 px, bouts arrondis, couleur héritée (`currentColor` dans l'appli), 16 à 20 px affichés.
- Pictogrammes de carte (monuments, bornes, gares) : badges carrés `radius-sm` ou ronds, glyphe clair sur fond sombre ; la forme du badge porte une information (classé carré, inscrit rond).
- Pas d'emoji, pas de bibliothèque d'icônes tierce.

## Mouvement

- Caméra : vols fluides (`flyTo`) de 1 à 3 s ; avec `prefers-reduced-motion`, sauts directs.
- Panneaux : apparition en fondu court (150–200 ms) ; aucun rebond.
- La carte s'anime d'elle-même (véhicules, vent) : l'interface, elle, reste immobile.

## Marque

- Le nom s'écrit **Vigie**, avec une capitale, jamais en capitales dans une phrase. Accroche : « la France en direct ».
- Le logo (`assets/Logos/vigie-mark.svg`) est un anneau `ui-ink` autour d'un point `ui-live` : la vigie qui regarde, et le direct. Version sans fond : `vigie-mark-nu.svg`, à poser seulement sur `ui-glass` ou plus sombre.
- Le nom seul se compose en `display`.

## Non repris du code

- Les valeurs hors échelle du code actuel (rayons 2, 3, 5, 7, 9, 10 px ; tailles 9,5 à 12,5 px) ne sont pas des jetons : elles sont à ramener sur les échelles ci-dessus.
- Couleurs de pastilles de ligne : elles viennent des données des réseaux (GTFS), pas du système.
- Composants : guides et aperçus statiques recomposés en HTML à partir de `web/src/styles.css` ; les composants React de l'appli ne sont pas empaquetés ici.
