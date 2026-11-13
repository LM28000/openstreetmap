# Pastille

La pastille de couche dit qu'une couche est affichée : sa teinte, son nom, un compteur et une croix pour la retirer.

- **Quand l'utiliser :** une par couche visible, en haut à gauche sous la recherche, dans l'ordre d'activation. Le bouton « Couches » ferme la rangée.
- **Ce que vous fournissez :** le nom de la couche (texte `small`, 13 px), sa marque de couleur (petit trait de 14 × 4 px aux couleurs de sa légende), un compteur facultatif en `data` couleur `ui-muted` (« 762 »), l'action de retrait.
- **Anatomie :** hauteur 34 px, fond `ui-glass`, bordure `ui-line`, `radius-pill`, ombre `ui-shadow`, marge interne `space-5`, écart `space-3`.
- **À faire :** un clic sur la pastille ouvre les réglages de la couche ; la croix a un libellé accessible « Retirer <couche> ».
- **À éviter :** colorer le fond de la pastille ; plus d'une ligne de texte ; une pastille pour une couche d'ambiance cachée.
- **Variante « Couches » :** bouton principal (`ui-primary` / `ui-primary-ink`, icône calques).
