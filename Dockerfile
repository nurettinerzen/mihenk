FROM node:20-slim

# better-sqlite3 prebuilt bulunamazsa kaynaktan derlenir (node-gyp) → python3 + g++ gerekir.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# İnşa-anı veri hattı (runtime RAM'i 512 MB'a sığdıran düzen):
#   model-indir  → q8 ONNX (~113 MB) + tokenizer.json
#   sp-hazirla   → kompakt sentencepiece vocab (sp-vocab.bin, ~4 MB)
#   vektor-int8  → hadis vektörleri f32→i8 (90→22 MB)
#   db-yap       → corpus+ayat → mihenk.db (SQLite; metinler artık RAM'de değil)
RUN node model-indir.mjs && node sp-hazirla.mjs && node vektor-int8.mjs && node db-yap.mjs \
  && rm -f corpus.json.gz vektor-hadis-tr.f32 vektor-hadis-en.f32 model/tokenizer.json

ENV PORT=8788
EXPOSE 8788
# Env değişkenleri (ANTHROPIC_API_KEY, APP_KEY, MODEL) Render tarafından verilir; .env yok.
CMD ["node", "hadis-api.mjs"]
