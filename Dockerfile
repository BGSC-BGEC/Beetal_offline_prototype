# Betaal game server. Rooms live in memory -> run exactly ONE instance.
FROM node:22-slim
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY shared ./shared
COPY server ./server
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/server.ts"]
