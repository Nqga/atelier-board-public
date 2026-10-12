# syntax=docker/dockerfile:1
FROM node:24-alpine

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
CMD ["node", "server.mjs"]
