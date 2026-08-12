FROM node:22-bookworm-slim

WORKDIR /tests
COPY tests/smoke/api.mjs ./api.mjs

USER node:node
CMD ["node", "/tests/api.mjs"]
