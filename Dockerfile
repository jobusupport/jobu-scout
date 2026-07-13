
FROM mcr.microsoft.com/playwright:v1.60.0-jammy
 
WORKDIR /app
 
# Install LibreOffice for DOCX -> PDF conversion
RUN apt-get update \
  && apt-get install -y --no-install-recommends libreoffice \
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
RUN cd perfectgame-scraper && npm install --omit=dev
 
ENV LIBREOFFICE_PATH=/usr/bin/soffice
 
EXPOSE 3333
 
CMD ["node", "server.js"]