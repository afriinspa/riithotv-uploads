FROM node:20-alpine
# yt-dlp powers the no-API YouTube catalogue import (full uploads + Live,
# Shorts excluded). Installed from pip for the latest extractor.
RUN apk add --no-cache python3 py3-pip \
    && pip3 install --no-cache-dir --break-system-packages -U yt-dlp
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
