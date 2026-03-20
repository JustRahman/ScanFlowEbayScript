FROM node:18-slim

WORKDIR /app

COPY . .

# If files are nested in a subdirectory (Railway tarball), move them up
RUN if [ ! -f package.json ] && ls -d */ | head -1; then \
      mv $(ls -d */)*/* . 2>/dev/null || true; \
      mv $(ls -d */)*/.* . 2>/dev/null || true; \
    fi

RUN npm install

CMD ["npx", "tsx", "src/index.ts"]
