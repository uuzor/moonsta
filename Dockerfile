# Moonsta app image (bot / scheduler / worker share it; compose picks the command).
# Runtime is tsx over the TS sources — no build step, same as local dev.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
COPY db ./db

# devDependencies included on purpose: tsx + typescript run the services.
RUN npm ci --no-audit --no-fund

# Mini App client, baked into the image so app-web serves it immediately.
RUN npm run web:build

CMD ["npm", "run", "bot"]
