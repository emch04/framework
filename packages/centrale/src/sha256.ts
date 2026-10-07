/**
 * SHA-256 écrit à la main, synchrone et sans dépendance : `crypto.subtle` n'existe pas
 * partout (Hermes, React Native) et il est asynchrone. Sert uniquement à hacher
 * l'identifiant d'utilisateur avec le sel du projet, jamais pour de la sécurité forte.
 */

/** Encode une chaîne en UTF-8 (les demi-paires isolées sont encodées telles quelles). */
export function utf8(texte: string): Uint8Array {
  const octets: number[] = [];
  for (let i = 0; i < texte.length; i++) {
    let c = texte.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < texte.length) {
      const d = texte.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) octets.push(c);
    else if (c < 0x800) octets.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) octets.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else octets.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(octets);
}

/** Taille en octets UTF-8 d'une chaîne, sans la recopier. */
export function tailleOctets(texte: string): number {
  let n = 0;
  for (let i = 0; i < texte.length; i++) {
    const c = texte.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < texte.length) {
      const d = texte.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) { n += 4; i++; } else n += 3;
    } else n += 3;
  }
  return n;
}

/** Les 64 premiers nombres premiers, d'où viennent les constantes de l'algorithme. */
function premiers(n: number): number[] {
  const liste: number[] = [];
  for (let candidat = 2; liste.length < n; candidat++) {
    if (liste.every((p) => candidat % p !== 0)) liste.push(candidat);
  }
  return liste;
}

const PREMIERS = premiers(64);
const fraction32 = (x: number): number => ((x - Math.floor(x)) * 0x100000000) >>> 0;
const K = Uint32Array.from(PREMIERS.map((p) => fraction32(Math.cbrt(p))));
const H0 = Uint32Array.from(PREMIERS.slice(0, 8).map((p) => fraction32(Math.sqrt(p))));

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** Empreinte SHA-256 d'une chaîne, en hexadécimal minuscule (64 caractères). */
export function sha256Hex(texte: string): string {
  const octets = utf8(texte);
  const longueur = octets.length;
  const blocs = (longueur + 9 + 63) >> 6;
  const m = new Uint8Array(blocs * 64);
  m.set(octets);
  m[longueur] = 0x80;
  const vue = new DataView(m.buffer);
  const bits = longueur * 8;
  vue.setUint32(m.length - 8, Math.floor(bits / 0x100000000));
  vue.setUint32(m.length - 4, bits >>> 0);

  const h = Uint32Array.from(H0);
  const w = new Uint32Array(64);
  for (let bloc = 0; bloc < blocs; bloc++) {
    const debut = bloc * 64;
    for (let t = 0; t < 16; t++) w[t] = vue.getUint32(debut + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[t] + w[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  let hex = '';
  for (const mot of h) hex += mot.toString(16).padStart(8, '0');
  return hex;
}
