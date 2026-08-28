FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY server.js db.js ./
COPY public ./public
# постоянное хранилище: на Railway подключи Volume с mount path /opal-data
# (Settings → Volumes), локально в Docker смонтируй: -v opal-data:/opal-data
ENV OPAL_DATA_DIR=/opal-data
EXPOSE 3000
CMD ["node", "server.js"]
