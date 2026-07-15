FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# Install LibreOffice for DOCX -> PDF conversion, plus a build toolchain so
# native modules (sqlite3) can compile from source instead of relying on
# prebuilt binaries that may target a newer glibc than this base image has.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libreoffice build-essential python3 libvips-dev libglib2.0-dev pkg-config \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

# Install Playwright browsers with deps
# This is probably redundant because the Playwright base image already includes browsers,
# but keeping it is fine if your current Railway build works.
RUN npx playwright install chromium --with-deps

COPY . .

# perfectgame-scraper/ has its own package.json (sqlite3, playwright, sharp,
# dotenv) that is NOT covered by the root `npm install` above — without this,
# require('sqlite3') fails on Railway even though it's correctly declared,
# because it never gets installed into any node_modules the container has.
#
# npm_config_build_from_source=true forces sqlite3's native binding to
# compile against THIS container's actual glibc (Ubuntu 22.04 / GLIBC 2.35)
# rather than downloading a prebuilt .node binary — sqlite3's default
# prebuilt binaries are built against a newer glibc (2.38+) and fail to
# load here with ERR_DLOPEN_FAILED / "GLIBC_2.38 not found".
RUN cd perfectgame-scraper && npm_config_build_from_source=true npm install --omit=dev

ENV LIBREOFFICE_PATH=/usr/bin/soffice

EXPOSE 3333

CMD ["node", "server.js"]