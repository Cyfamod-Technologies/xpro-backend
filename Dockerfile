FROM node:22-alpine AS base
WORKDIR /app

RUN apk add --no-cache openssl bash

COPY package*.json ./
COPY prisma ./prisma/

ENV PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING=1

RUN npm ci --legacy-peer-deps && npx prisma generate

COPY . .

RUN npm run build
RUN npm prune --omit=dev --legacy-peer-deps

FROM node:22-alpine AS runner
WORKDIR /app

RUN apk add --no-cache openssl

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/dist ./dist
COPY --from=base /app/prisma ./prisma
COPY --from=base /app/package*.json ./

EXPOSE 4000

CMD ["node", "dist/main.js"]
