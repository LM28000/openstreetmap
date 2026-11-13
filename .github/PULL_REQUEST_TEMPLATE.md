## Ce qui change et pourquoi

<!-- Une ou deux phrases. Lien vers le ticket s'il y en a un. -->

## Comment c'est vérifié

- [ ] `pnpm typecheck` et `pnpm build` (dans `web/`)
- [ ] `cargo test` (dans `server/`)
- [ ] Capture d'écran jointe (pour un changement visible sur la carte)

## Liste de contrôle

- [ ] Aucun secret (clé, mot de passe, jeton, `.env`) dans les fichiers, le texte ou les captures
- [ ] Documentation mise à jour (`docs/`, et `.env.example` si une variable est ajoutée)
- [ ] Pour une nouvelle source de données : licence vérifiée, attribution affichée, ligne ajoutée à `docs/sources-et-licences.md`
- [ ] Les chiffres annoncés (mémoire, temps, volume) ont été mesurés
