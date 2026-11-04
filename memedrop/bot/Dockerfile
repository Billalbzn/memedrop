FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# `exec` : node remplace le shell et reçoit lui-même le SIGINT/SIGTERM de Fly
# à chaque déploiement. Sans ça, le shell (PID 1) ne transmettait pas le signal :
# l'arrêt propre (sauvegarde de store.json, coupure des sockets pour que les
# applis se reconnectent) ne s'exécutait jamais, Fly finissait par tuer le process.
CMD ["sh", "-c", "node deploy-commands.js; exec node index.js"]
