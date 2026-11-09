# Image du serveur de la carte vivante.
#
# Étape 1 : compilation (image Rust complète, jetée ensuite).
# Étape 2 : image d'exécution minimale (Debian slim + certificats + le binaire).

FROM rust:1.94-slim-trixie AS build
WORKDIR /src
# Les dépendances d'abord : tant que Cargo.toml/Cargo.lock ne changent pas, Docker garde
# cette étape en cache et une modification du code ne recompile que notre crate.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release --locked && rm -rf src
COPY src ./src
RUN touch src/main.rs && cargo build --release --locked

FROM debian:trixie-slim
# Certificats : le serveur télécharge en HTTPS (SNCF, OpenStreetMap, relief).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/carte-vivante-serveur /usr/local/bin/carte-vivante-serveur
ENV HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    ARCHIVE_DIR=/archive \
    RUST_LOG=info,tower_http=warn
EXPOSE 8787
# Jamais en administrateur : l'utilisateur est choisi par compose.yaml (celui qui possède les dossiers).
USER 65534:65534
CMD ["carte-vivante-serveur"]
