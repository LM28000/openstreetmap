# Reglage

Le réglage d'une couche, dans son panneau : un choix segmenté (2 à 4 options) ou un curseur (durée, opacité).

- **Anatomie du choix segmenté :** titre du réglage en `caption` `ui-muted` au-dessus ; segments de 30 px de haut en `small`, fond `ui-control`, segment choisi `ui-selected` et `body-strong` ; `radius-md` ; écart `space-1`.
- **Curseur :** titre et valeur courante sur une ligne (valeur en `data`), piste `ui-control`, partie remplie et poignée `ui-ink`, poignée `radius-pill`. La valeur s'applique au relâchement ou après 250 ms d'arrêt.
- **Ce que vous fournissez :** le titre (« Transports pris en compte »), les options en mots courts (« Trains seulement », « Tous »), la valeur par défaut, une aide facultative en `caption`.
- **À éviter :** plus de 4 segments (utilisez une liste) ; des options en icônes seules ; un réglage sans titre.
