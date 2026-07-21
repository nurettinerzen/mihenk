FROM node:20-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Embedding modelini image'a önceden indir (runtime ilk sorgu beklemesin).
RUN node -e 'import("./embed.mjs").then(m=>m.embedder()).then(()=>console.log("model cached")).catch(e=>{console.error(e);process.exit(1)})'

ENV PORT=8788
EXPOSE 8788
# Env değişkenleri (ANTHROPIC_API_KEY, APP_KEY, MODEL) Render tarafından verilir; .env yok.
CMD ["node", "hadis-api.mjs"]
