# Contribuer à Vigie

Merci de l'intérêt porté au projet. C'est un projet personnel né pour apprendre : les contributions, les idées de couches et les corrections sont les bienvenues, avec un rythme de réponse qui reste celui d'un projet personnel.

Le dépôt est documenté en français (documentation, commentaires du code, interface) ; merci de rédiger tickets et pull requests en français si possible.

## Avant de commencer

- Lire [docs/architecture.md](../docs/architecture.md) (modules, couches, flux de données) et [docs/developpement.md](../docs/developpement.md) (installation, vérifications).
- Pour une grosse évolution, ouvrir d'abord un ticket pour en discuter.
- **Aucun secret** dans un commit, un ticket ou une capture d'écran : voir [SECURITY.md](SECURITY.md).

## Mettre en place

```bash
cd server && cargo run --release      # API sur http://127.0.0.1:8787
cd web && pnpm install && pnpm dev    # site sur http://localhost:5173
```

Pour le site seul, contre un serveur installé ailleurs : `CARTE_API=http://<adresse>:8787 pnpm dev`.

## Vérifications à passer

```bash
cd web && pnpm typecheck && pnpm build
cd server && cargo test
```

L'intégration continue rejoue ces commandes. Pas de `cargo fmt` en bloc : le code n'est pas formaté avec `rustfmt` et le reformater brouillerait l'historique. Garder le style du fichier modifié.

## Dépendances

- Les dépendances doivent avoir été publiées depuis plus de 24 heures ; ne pas contourner cette règle de pnpm par une exemption.
- Toute nouvelle dépendance doit se justifier (le projet en a volontairement peu : protobuf, MVT et PMTiles sont écrits à la main).
- Les versions de MapLibre (5.x) et de deck.gl (9.4) sont liées : ne pas monter MapLibre en 6 sans vérifier la compatibilité (voir [docs/rendu-3d.md](../docs/rendu-3d.md#pièges-connus)).

## Ajouter une couche de données

1. Lire [docs/architecture.md](../docs/architecture.md#ajouter-une-couche) (module côté site) et, pour un gros jeu de données, [docs/moteur-de-tuiles.md](../docs/moteur-de-tuiles.md#ajouter-un-jeu-de-données).
2. **Vérifier la licence de la source** avant tout : elle doit permettre la réutilisation, et son attribution doit s'afficher (`attribution` est obligatoire dans un module).
3. Ajouter la couche à `web/src/modules/index.ts`, une ligne au tableau de [docs/couches.md](../docs/couches.md) et à [docs/sources-et-licences.md](../docs/sources-et-licences.md).
4. Mesurer avant d'annoncer un chiffre (mémoire, temps, volume) ; ne pas documenter ce qui n'a pas été vérifié.
5. Une clé d'API, si la source en demande une, se lit dans une variable d'environnement côté serveur, est ajoutée à `.env.example` (valeur vide) et à [docs/deploiement.md](../docs/deploiement.md), et ne sort jamais du serveur.

## Conventions

- **Messages de commit** en français, à l'impératif ou au nom d'action, une idée par commit.
- **Commentaires et documentation** en français, qui expliquent le *pourquoi* (le code dit déjà le *quoi*).
- **Interface** : texte en français, couleur réservée aux données, palettes vérifiées pour le daltonisme et pour les fonds clair et sombre.
- **Sobriété des ressources** : le serveur tourne dans 1 Go de mémoire ; une fabrication lourde se fait en flux, dans un processus enfant.

## Pull requests

Décrire ce qui change et pourquoi, indiquer comment cela a été vérifié (commandes ci-dessus, capture d'écran pour une couche), et cocher la liste du modèle de pull request.
