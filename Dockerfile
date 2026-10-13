# syntax=docker/dockerfile:1
FROM node:24-alpine

LABEL org.opencontainers.image.title="Atelier Board" \
      org.opencontainers.image.description="Tableau visuel collaboratif web" \
      org.opencontainers.image.version="2.2.0" \
      org.opencontainers.image.source="https://github.com/Nqga/atelier-board-public" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./

# Le secret optionnel permet les builds derrière un proxy avec CA dédiée.
# Aucun certificat ni identifiant de la session n'est conservé dans l'image.
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca npm ci --omit=dev --strict-ssl=true; \
    else \
      npm ci --omit=dev --strict-ssl=true; \
    fi

COPY --chown=node:node server.mjs ./
COPY --chown=node:node LICENSE ./
COPY --chown=node:node server/ ./server/
COPY --chown=node:node dist/ ./dist/
RUN mkdir -p /data && chown node:node /data

USER node
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 DATA_DIR=/data
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health', {signal: AbortSignal.timeout(4000)}).then(async r => {if (!r.ok || (await r.json()).status !== 'ok') process.exit(1);}).catch(() => process.exit(1))"
CMD ["node", "server.mjs"]
