# Legende

La légende d'une couche explique ses couleurs : une ligne par cran ou par catégorie, dans le panneau de la couche et sur la fiche.

- **Anatomie :** pastille de couleur 12 × 12 px en `radius-sm` (carré pour un aplat, rond pour un point, trait pour une ligne), libellé `small` en `ui-ink`, valeur ou intervalle en `data` `ui-muted`. Écart `space-3` entre pastille et texte, `space-2` entre lignes.
- **Rampes :** du plus faible au plus fort, de haut en bas ; les intervalles disent l'unité (« 1 950 à 2 450 €/m² »). Le cran central d'une rampe divergente nomme sa référence (« médiane de la zone affichée »).
- **Ce que vous fournissez :** les couleurs (jetons de la couche, version `jour` ou `nuit` selon la carte), les libellés, l'unité.
- **À éviter :** une légende de couleur seule sans libellé ; plus de 8 lignes (regroupez en « Autres ») ; des pastilles de statut pour une grandeur.
