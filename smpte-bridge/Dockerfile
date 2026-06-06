# Minimal image for the timecode fan-out bridge.
# Only runtime dep is `ws`. The npm `start` script hardcodes `tailscale ip`,
# which doesn't exist in the container, so we invoke node directly and pass
# HOSTS/PORT via environment instead.
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY public/ ./public/

# Bind all interfaces inside the container; map the port out via compose/run.
ENV HOSTS=0.0.0.0
EXPOSE 8765

CMD ["node", "src/index.js"]
