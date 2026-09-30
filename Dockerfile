# SPX Graphics Controller (open source / SPX Solo) running on Node in Docker
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# SPX tries to open a browser (via xdg-open) on first start. There is no
# browser in the container, so provide a no-op to avoid a spawn error.
RUN printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/xdg-open \
 && chmod +x /usr/local/bin/xdg-open

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
 && chmod +x /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /app/config /app/DATAROOT /app/ASSETS /app/LOG

EXPOSE 5656

ENTRYPOINT ["docker-entrypoint.sh"]
# Config path is relative to /app. It is created with defaults if missing.
CMD ["node", "server.js", "config/config.json"]
