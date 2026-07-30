# ---------------------------------------------------------------------------
#  Общая база: зависимости
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

# ---------------------------------------------------------------------------
#  Цель `runner-scripts` — контейнер загрузчика (tsx + скрипты).
#  Держим dev-зависимости: tsx нужен для запуска TypeScript напрямую.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runner-scripts
WORKDIR /app

ENV NODE_ENV=development

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY schema.sql queries.sql ./

CMD ["npm", "run", "load:all"]

# ---------------------------------------------------------------------------
#  Сборка Next.js
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json next.config.mjs ./
COPY public ./public
COPY src ./src

# DATABASE_URL на этапе сборки не нужен: страница рендерится динамически.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------------------------------------------------------------------------
#  Цель `runner-web` — продакшн-образ Next.js (standalone).
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runner-web
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Не запускаем сервер от root.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
