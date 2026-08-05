// sp-tokenizer.mjs — XLM-R sentencepiece unigram tokenizer, kompakt (~10 MB RSS).
//
// @huggingface/transformers tokenizer'ının birebir yerine geçer (aynı id çıktısı;
// fark diff testiyle doğrulanır) ama vocab'ı JS objesi yerine typed-array + açık
// adresli hash tablosunda tutar. 512 MB instance hedefi için yazıldı.
//
// Boru hattı (tokenizer.json ile birebir):
//   normalizer: NFKC (precompiled charsmap'in pratik karşılığı; diff testiyle doğrulandı)
//   pre_tokenizer: WhitespaceSplit → Metaspace('▁', add_prefix_space)
//   model: Unigram (Viterbi, unk_id=3, unk cezası = minSkor-10, ardışık unk kaynaşır)
//   post: <s> … </s>  →  [0, …, 2]

import { readFileSync } from 'node:fs';

const BOS = 0, EOS = 2, UNK = 3;
const MAX_TOKEN = 512;                    // model_max_length (tokenizer_config.json)

export class SpTokenizer {
  constructor(binYolu) {
    const b = readFileSync(binYolu);
    if (b.toString('ascii', 0, 4) !== 'SPV1') throw new Error('sp-vocab.bin bozuk');
    this.N = b.readUInt32LE(4);
    const piecesLen = b.readUInt32LE(8);
    this.maxPiece = b.readUInt32LE(12);
    this.unkSkor = b.readFloatLE(16);
    let of = 20;
    // Buffer'ın altındaki ArrayBuffer'dan hizalı kopyalar (küçük, tek seferlik)
    this.skor = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) this.skor[i] = b.readFloatLE(of + i * 4);
    of += this.N * 4;
    this.ofs = new Uint32Array(this.N + 1);
    for (let i = 0; i <= this.N; i++) this.ofs[i] = b.readUInt32LE(of + i * 4);
    of += (this.N + 1) * 4;
    this.parcalar = b.subarray(of, of + piecesLen);   // UTF-8 ardışık

    // Açık adresli hash tablosu: slot → parça dizini + 1 (0 = boş). 2^19 = 524288
    // slot, doluluk ~%48 — probe zinciri kısa kalır, tablo 2 MB.
    this.mask = (1 << 19) - 1;
    this.tablo = new Int32Array(1 << 19);
    for (let i = 0; i < this.N; i++) {
      const p0 = this.ofs[i], p1 = this.ofs[i + 1];
      let h = 2166136261;
      for (let k = p0; k < p1; k++) { h ^= this.parcalar[k]; h = Math.imul(h, 16777619); }
      let s = (h >>> 0) & this.mask;
      while (this.tablo[s] !== 0) s = (s + 1) & this.mask;
      this.tablo[s] = i + 1;
    }
  }

  // bytes[i..j) parçalara karşılık gelen id, yoksa -1. h = o aralığın FNV-1a'sı.
  #bul(h, bytes, i, j) {
    let s = (h >>> 0) & this.mask;
    const len = j - i;
    for (;;) {
      const v = this.tablo[s];
      if (v === 0) return -1;
      const idx = v - 1;
      const p0 = this.ofs[idx];
      if (this.ofs[idx + 1] - p0 === len) {
        let ok = true;
        for (let k = 0; k < len; k++) if (this.parcalar[p0 + k] !== bytes[i + k]) { ok = false; break; }
        if (ok) return idx;
      }
      s = (s + 1) & this.mask;
    }
  }

  // Tek kelime ('▁' önekli) → token id listesi (Viterbi, en yüksek toplam logprob).
  #kelime(bytes, out) {
    const n = bytes.length;
    const dp = new Float64Array(n + 1).fill(-Infinity); dp[0] = 0;
    const geriPos = new Int32Array(n + 1).fill(-1);
    const geriId = new Int32Array(n + 1).fill(-1);
    const basMi = (p) => p === n || (bytes[p] & 0xC0) !== 0x80;
    for (let i = 0; i < n; i++) {
      if (dp[i] === -Infinity || !basMi(i)) continue;
      // unk adımı: tek karakter ilerle (örgü hiç çıkmaza girmesin)
      let j1 = i + 1; while (j1 < n && !basMi(j1)) j1++;
      const unkS = dp[i] + this.unkSkor;
      if (unkS > dp[j1]) { dp[j1] = unkS; geriPos[j1] = i; geriId[j1] = -2; }
      // parça adımları: artımlı FNV ile karakter sınırlarında ara
      let h = 2166136261;
      const son = Math.min(n, i + this.maxPiece);
      for (let j = i + 1; j <= son; j++) {
        h ^= bytes[j - 1]; h = Math.imul(h, 16777619);
        if (!basMi(j)) continue;
        const idx = this.#bul(h, bytes, i, j);
        if (idx >= 0) {
          const s = dp[i] + this.skor[idx];
          if (s > dp[j]) { dp[j] = s; geriPos[j] = i; geriId[j] = idx; }
        }
      }
    }
    // geri sar
    const ters = [];
    for (let p = n; p > 0; p = geriPos[p]) ters.push(geriId[p] === -2 ? UNK : geriId[p]);
    for (let k = ters.length - 1; k >= 0; k--) {
      const id = ters[k];
      // ardışık unk kaynaşır (HF Unigram fuse_unk davranışı)
      if (id === UNK && out.length && out[out.length - 1] === UNK) continue;
      out.push(id);
    }
  }

  // Metin → { ids } (BOS/EOS dahil, MAX_TOKEN'a kırpılmış).
  encode(metin) {
    const out = [BOS];
    // Zero-width/yön işaretleri (ZWSP/ZWNJ/ZWJ/LRM/RLM): HF'nin precompiled
    // charsmap'i bunları boşluğa çevirir (ampirik olarak doğrulandı) — NFKC dokunmaz.
    const norm = String(metin ?? '').normalize('NFKC').replace(/[​-‏�]/g, ' ');
    for (const kelime of norm.split(/\s+/u)) {
      if (!kelime) continue;
      this.#kelime(Buffer.from('▁' + kelime, 'utf8'), out);
      if (out.length >= MAX_TOKEN - 1) break;         // kırpma: sorgular zaten kısa
    }
    if (out.length > MAX_TOKEN - 1) out.length = MAX_TOKEN - 1;
    out.push(EOS);
    return { ids: out };
  }
}
