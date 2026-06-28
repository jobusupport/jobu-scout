FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install

# Install Playwright browsers with deps (works in this base image)
RUN npx playwright install chromium --with-deps

COPY . .

EXPOSE 3333

CMD ["node", "server.js"]