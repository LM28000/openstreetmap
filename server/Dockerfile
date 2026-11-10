# Image de la carte vivante : le serveur et le site, dans un seul conteneur.
#
# Se construit depuis la racine du dépôt (contexte « . », voir compose.yaml) :
#   docker build -f server/Dockerfile .
#
# Étape 1 : le site (TypeScript → fichiers statiques), jetée ensuite.
# Étape 2 : le serveur (image Rust complète), jetée ensuite.
# Étape 3 : image d'exécution minimale (Debian slim + certificats + le binaire + le site).

FROM node:24.22-trixie-slim AS web
RUN npm install --global pnpm@12.8.1
WORKDIR /web
# Les dépendances d'abord : tant que le fichier de verrouillage ne change pas, Docker garde
# cette étape en cache.
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM rust:1.94-slim-trixie AS build
WORKDIR /src
# Même principe : une modification du code ne recompile que notre crate.
COPY server/Cargo.toml server/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release --locked && rm -rf src
COPY server/src ./src
RUN touch src/main.rs && cargo build --release --locked

FROM debian:trixie-slim
# Certificats : le serveur télécharge en HTTPS (SNCF, OpenStreetMap, relief…).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/carte-vivante-serveur /usr/local/bin/carte-vivante-serveur
COPY --from=web /web/dist /web
ENV HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    ARCHIVE_DIR=/archive \
    WEB_DIR=/web \
    RUST_LOG=info,tower_http=warn \
    # glibc garde une réserve de mémoire par fil d'exécution : avec tokio et les gros fichiers
    # lus au démarrage (GTFS, bornes), elle gonflait l'empreinte sans la rendre. Deux suffisent.
    MALLOC_ARENA_MAX=2
EXPOSE 8787
# Jamais en administrateur : l'utilisateur est choisi par compose.yaml (celui qui possède les dossiers).
USER 65534:65534
CMD ["carte-vivante-serveur"]
