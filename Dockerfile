# Cricket POC — backend (Node.js + Express)
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Prefer ci; fall back if lock is slightly out of sync with older commits
RUN npm ci --omit=dev || npm install --omit=dev --no-audit --no-fund

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=256

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server.js ./
COPY src ./src
COPY db ./db
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && addgroup -S app && adduser -S app -G app \
  && chown -R app:app /app

USER app
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
