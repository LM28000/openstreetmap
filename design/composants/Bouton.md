# Bouton

Les boutons déclenchent une action dans un panneau : une action principale au plus, les autres secondaires.

- **Principal :** fond `ui-primary`, texte `ui-primary-ink`, `body-strong`. Un seul par panneau (« Partager » n'en est pas un ; « Analyser » ou « Recommencer la visite » oui).
- **Secondaire :** fond `ui-control`, survol `ui-control-hover`, texte `ui-ink`.
- **En direct :** pastille `radius-pill` ; en direct, point `ui-live` et texte `ui-live-ink` ; en relecture, fond `ui-live-soft` et libellé « Revenir au direct ».
- **Anatomie :** hauteur 34 px, marge interne `space-5`, écart icône–texte `space-3`, `radius-md`. Icône de 16 px à gauche, facultative.
- **Ce que vous fournissez :** un verbe qui dit ce qui se passe (« Partager », « Effacer », « + 30 min »), l'icône facultative, l'état désactivé avec la raison en `caption` à côté.
- **Focus :** anneau 2 px `ui-ink` décalé de 2 px.
- **À éviter :** bouton rouge ; libellé « OK » ou « Valider » ; plus de trois boutons dans une rangée.
