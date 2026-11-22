# One always-on Node process with a volume. Not serverless: the hub keeps the
# partner sockets, sessions and the token pool in memory, so scaling to two
# replicas would split them. `GLM_STATE_FILE` must point at the mounted volume.
FROM node:22-alpine

WORKDIR /app
COPY . .
ENV NODE_ENV=production
VOLUME /data
EXPOSE 5082
CMD ["node", "server/hub.mjs"]