FROM node:20-bookworm-slim AS frontend-build

WORKDIR /app/frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

FROM node:20-bookworm-slim AS server-deps

WORKDIR /app/server
COPY server/package.json ./
RUN npm install --omit=dev

FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server/package.json ./server/package.json
COPY server/src ./server/src
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 8000

CMD ["node", "server/src/index.js"]
