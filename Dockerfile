FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app

COPY package.json package.json
RUN npm install --omit=dev

COPY src ./src

ENV PORT=3000
EXPOSE 3000

CMD ["npm","start"]
