FROM node:20-slim

# curl is required for Coolify's container-internal healthcheck (GET /health).
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY src ./src
COPY tsconfig.json ./

RUN npm run build

EXPOSE 3000

CMD ["node", "dist/index.js"]
