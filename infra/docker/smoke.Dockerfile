FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install --yes --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /tests
COPY tests/smoke/api.mjs ./api.mjs
COPY tests/load/audience.mjs ./load.mjs

USER node:node
CMD ["node", "/tests/api.mjs"]
