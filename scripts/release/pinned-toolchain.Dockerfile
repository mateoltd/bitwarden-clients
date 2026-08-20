# syntax=docker/dockerfile:1.7

FROM docker.io/library/node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532 AS node
FROM docker.io/library/rust:1.96.0-slim-bookworm@sha256:4732ca96fd086cb9be682050c3f0176288eebaac2b80aa2bcefccfaf198e1950 AS rust
FROM docker.io/library/python:3.14.2-slim-bookworm@sha256:e87711ef5c86aaeaa7031718a69db79d334d94c545c709583f651b8185870941

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup

ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    RUST_VERSION=1.96.0 \
    PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && apt-get update \
    && apt-get install --yes --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      git \
      libssl-dev \
      pkg-config \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global npm@11.18.0 --no-audit --no-fund \
    && test "$(node --version)" = "v24.17.0" \
    && test "$(npm --version)" = "11.18.0" \
    && test "$(python3 --version)" = "Python 3.14.2" \
    && test "$(rustc --version | awk '{print $2}')" = "1.96.0"

WORKDIR /workspace
