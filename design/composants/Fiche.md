# Fiche

La fiche décrit l'objet choisi sur la carte : un train, une gare, un carreau, un bureau de vote. Un seul gabarit pour toutes les couches.

- **Où :** panneau de 372 px à droite sur ordinateur, feuille tirée du bas sur téléphone.
- **Anatomie, de haut en bas :** surtitre `eyebrow` en `ui-muted` (type d'objet · couche), titre `title`, sous-titre `small` en `ui-muted`, statut (badge : « Résultats définitifs », « En direct », « Estimé »), rangée de 2 à 3 chiffres clés (`figure` + unité et libellé en `caption`), lignes libellé/valeur (`small` / `data`), note en `caption` `ui-faint` (source, limite), actions (boutons).
- **Ce que vous fournissez :** titre, surtitre, chiffres clés avec unités, lignes, source, actions. Les nombres en format français.
- **Anatomie visuelle :** fond `ui-glass`, bordure `ui-line`, `radius-lg`, `ui-shadow`, marge interne `space-6`, écart entre blocs `space-5` ; chiffres clés sur fond `ui-control` en `radius-md`.
- **À faire :** dire la source et la nature de la valeur (estimée, imputée, théorique) ; tableau défilant à l'intérieur de la fiche s'il est long.
- **À éviter :** plus de 3 chiffres clés ; couleur de données sur le texte (la couleur va sur une pastille à côté du nom).
