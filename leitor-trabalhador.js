// Trabalhador de leitura do celular (roda separado da tela, então a câmera não trava).
// Recebe o pedaço da imagem que está dentro da moldura e:
//   1. acha onde está o código de barras e quanto ele está inclinado;
//   2. tira a média das linhas das barras (limpa o ruído), reforça a nitidez e decodifica (ZXing C++);
//   3. se não decodificou, tenta a imagem inteira (pega também o QR da NFC-e);
//   4. se mesmo assim não leu, devolve a faixa dos números logo acima do código, já endireitada,
//      para a leitura dos números impressos.

importScripts('zxing-cpp.js');
ZXingWASM.prepareZXingModule({
  overrides: { locateFile: (arquivo, prefixo) => (arquivo.endsWith('.wasm') ? new URL('zxing_reader.wasm', self.location.href).href : prefixo + arquivo) },
});

// Só o código de barras da nota (CODE 128) e o QR da NFC-e
const NOMES = { Code128: 'code_128', QRCode: 'qr_code' };
const tela = new OffscreenCanvas(1, 1);
const ctx = tela.getContext('2d', { willReadFrequently: true });
const telaFaixa = new OffscreenCanvas(1, 1);
const ctxFaixa = telaFaixa.getContext('2d');

// Acha o código de barras: linhas onde a imagem muda muito na horizontal e pouco na vertical
// (barra vertical faz isso; texto e papel não). Devolve { y0, y1, x0, x1, inclinacao } ou null.
function acharCodigo(g, w, h) {
  const PISO = 14; // ruído do papel e do sensor
  const R = new Float32Array(h);
  for (let y = 1; y < h - 1; y++) {
    const o = y * w;
    let s = 0;
    for (let x = 1; x < w - 1; x++) {
      const d = Math.abs(g[o + x + 1] - g[o + x - 1]) - Math.abs(g[o + x + w] - g[o + x - w]) - PISO;
      if (d > 0) s += d;
    }
    R[y] = s / w;
  }
  const Rs = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, y - 2); k <= Math.min(h - 1, y + 2); k++) { s += R[k]; n++; }
    Rs[y] = s / n;
  }
  let maxR = 0;
  for (let y = 0; y < h; y++) if (Rs[y] > maxR) maxR = Rs[y];
  if (maxR < 2) return null;
  // O maior bloco de linhas acima de 45% do pico é o código de barras
  const corte = maxR * 0.45;
  let melhor = null, ini = -1;
  for (let y = 0; y <= h; y++) {
    const ok = y < h && Rs[y] >= corte;
    if (ok && ini < 0) ini = y;
    if (!ok && ini >= 0) {
      if (!melhor || y - ini > melhor.y1 - melhor.y0) melhor = { y0: ini, y1: y };
      ini = -1;
    }
  }
  if (!melhor || melhor.y1 - melhor.y0 < 6) return null;
  // Extensão horizontal: colunas com energia de barra dentro do bloco
  const C = new Float32Array(w);
  for (let y = Math.max(1, melhor.y0); y < Math.min(h - 1, melhor.y1); y++) {
    const o = y * w;
    for (let x = 1; x < w - 1; x++) {
      const d = Math.abs(g[o + x + 1] - g[o + x - 1]) - Math.abs(g[o + x + w] - g[o + x - w]) - PISO;
      if (d > 0) C[x] += d;
    }
  }
  const meiaJanela = Math.max(4, Math.round((melhor.y1 - melhor.y0) * 0.6));
  const Cs = new Float32Array(w);
  let soma = 0;
  for (let x = 0; x < Math.min(w, meiaJanela); x++) soma += C[x];
  for (let x = 0; x < w; x++) {
    if (x + meiaJanela < w) soma += C[x + meiaJanela];
    if (x - meiaJanela - 1 >= 0) soma -= C[x - meiaJanela - 1];
    Cs[x] = soma;
  }
  let maxC = 0;
  for (let x = 0; x < w; x++) if (Cs[x] > maxC) maxC = Cs[x];
  let x0 = -1, x1 = -1;
  for (let x = 0; x < w; x++) if (Cs[x] >= maxC * 0.2) { if (x0 < 0) x0 = x; x1 = x; }
  if (x1 - x0 < 30) return null;
  // Inclinação: deslocamento que melhor encaixa uma linha de cima numa de baixo
  const alto = melhor.y1 - melhor.y0;
  const ya = melhor.y0 + Math.round(alto * 0.2), yb = melhor.y0 + Math.round(alto * 0.8);
  const media = (y) => { let s = 0; for (let x = x0; x <= x1; x++) s += g[y * w + x]; return s / (x1 - x0 + 1); };
  const ma = media(ya), mb = media(yb);
  let melhorDesl = 0, melhorPont = -Infinity;
  const maxDesl = Math.ceil((yb - ya) * 0.15) + 2;
  for (let s = -maxDesl; s <= maxDesl; s++) {
    let p = 0;
    for (let x = Math.max(x0, x0 - s); x <= Math.min(x1, x1 - s); x++) p += (g[ya * w + x] - ma) * (g[yb * w + x + s] - mb);
    if (p > melhorPont) { melhorPont = p; melhorDesl = s; }
  }
  return { y0: melhor.y0, y1: melhor.y1, x0, x1, inclinacao: melhorDesl / (yb - ya) };
}

// Média das linhas do código seguindo a inclinação (uma linha limpa, repetida em 24 linhas),
// com reforço de nitidez opcional
function codigoLimpo(g, w, h, c, nitidez) {
  const alto = c.y1 - c.y0;
  const ya = c.y0 + Math.round(alto * 0.15), yb = c.y1 - Math.round(alto * 0.15);
  const yc = (ya + yb) / 2;
  const perfil = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let y = ya; y <= yb; y++) {
      const sx = x + (y - yc) * c.inclinacao;
      const xi = Math.floor(sx), f = sx - xi;
      if (xi < 0 || xi + 1 >= w) continue;
      s += g[y * w + xi] * (1 - f) + g[y * w + xi + 1] * f;
      n++;
    }
    perfil[x] = n ? s / n : 255;
  }
  let p = perfil;
  if (nitidez > 0) {
    p = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const borrado = (perfil[Math.max(0, x - 2)] + 2 * perfil[Math.max(0, x - 1)] + 3 * perfil[x] + 2 * perfil[Math.min(w - 1, x + 1)] + perfil[Math.min(w - 1, x + 2)]) / 9;
      p[x] = perfil[x] + nitidez * (perfil[x] - borrado);
    }
  }
  const H = 24;
  const img = new ImageData(w, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, p[x]));
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  return img;
}

// Faixa dos números (acima do código), endireitada e ampliada para os dígitos ficarem com ~46 px
function faixaDosNumeros(g, w, h, c) {
  const alto = c.y1 - c.y0, largura = c.x1 - c.x0;
  const cx = (c.x0 + c.x1) / 2, cy = c.y0 - alto * 0.62;
  const fw = largura * 1.42, fh = alto * 1.15;
  const escala = Math.min(2, Math.max(1, 46 / (fh * 0.42)));
  const W = Math.round(fw * escala), H = Math.round(fh * escala);
  const a = Math.atan(c.inclinacao), cos = Math.cos(a), sin = Math.sin(a);
  const img = new ImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x - W / 2) / escala, v = (y - H / 2) / escala;
      const sx = cx + u * cos + v * sin, sy = cy - u * sin + v * cos;
      const xi = Math.floor(sx), yi = Math.floor(sy);
      let val = 255;
      if (xi >= 0 && yi >= 0 && xi < w - 1 && yi < h - 1) {
        const fx = sx - xi, fy = sy - yi, i = yi * w + xi;
        val = (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
      }
      const k = (y * W + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = val;
      img.data[k + 3] = 255;
    }
  }
  return img;
}

async function ler(imagem, formatos) {
  const lidos = await ZXingWASM.readBarcodes(imagem, { formats: formatos, tryHarder: true, tryRotate: false, tryInvert: false, maxNumberOfSymbols: 1 });
  const r = lidos[0];
  return r ? { texto: r.text, formato: NOMES[r.format] || 'outro' } : null;
}

onmessage = async (e) => {
  const { quadro, vez, querFaixa } = e.data;
  try {
    tela.width = quadro.width;
    tela.height = quadro.height;
    ctx.drawImage(quadro, 0, 0);
    quadro.close();
    const img = ctx.getImageData(0, 0, tela.width, tela.height);
    const w = img.width, h = img.height, px = img.data;
    const g = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;

    const c = acharCodigo(g, w, h);
    let achou = null;
    if (c) {
      for (const nitidez of [1, 2, 0]) {
        achou = await ler(codigoLimpo(g, w, h, c, nitidez), ['Code128']);
        if (achou) break;
      }
    }
    // A imagem inteira (pega QR Code e o que o localizador não achou), a cada 3 quadros
    if (!achou && (!c || vez % 3 === 0)) achou = await ler(img, Object.keys(NOMES));

    let faixa = null;
    if (!achou && c && querFaixa) {
      const f = faixaDosNumeros(g, w, h, c);
      telaFaixa.width = f.width;
      telaFaixa.height = f.height;
      ctxFaixa.putImageData(f, 0, 0);
      faixa = await telaFaixa.convertToBlob({ type: 'image/png' });
    }
    postMessage({ achou, faixa, achouCodigo: !!c });
  } catch (erro) {
    postMessage({ achou: null, faixa: null, erro: String(erro) });
  }
};
