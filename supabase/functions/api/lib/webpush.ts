// Web Push sem dependências (Deno e Node 20+, só WebCrypto):
// criptografia do conteúdo (RFC 8291, aes128gcm) e identificação do servidor (VAPID, RFC 8292).

export interface AssinaturaPush {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}
export interface ChavesVapid {
  publica: string;        // ponto P-256 sem compressão (65 bytes), base64url — vai para o navegador
  privadaJwk: JsonWebKey; // guardada só no servidor
}

const enc = new TextEncoder();
/** Uint8Array como BufferSource (contorna a tipagem genérica de ArrayBuffer do TypeScript 5.7+). */
const bs = (u: Uint8Array) => u as unknown as BufferSource;

export function b64u(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function deB64u(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function juntar(...partes: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(partes.reduce((s, p) => s + p.length, 0));
  let i = 0;
  for (const p of partes) { out.set(p, i); i += p.length; }
  return out;
}
async function hmac(chave: Uint8Array, dados: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", bs(chave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, bs(dados)));
}

/** Gera o par de chaves VAPID (uma vez, guardado na configuração do app). */
export async function gerarChavesVapid(): Promise<ChavesVapid> {
  const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const publica = b64u(await crypto.subtle.exportKey("raw", par.publicKey));
  const privadaJwk = await crypto.subtle.exportKey("jwk", par.privateKey);
  return { publica, privadaJwk };
}

/** Cabeçalho Authorization VAPID para o serviço de push do navegador. */
export async function cabecalhoVapid(endpoint: string, chaves: ChavesVapid, contato: string): Promise<string> {
  const aud = new URL(endpoint).origin;
  const cab = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const corpo = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contato })));
  const chave = await crypto.subtle.importKey("jwk", { ...chaves.privadaJwk, key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const assinatura = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, chave, enc.encode(`${cab}.${corpo}`));
  return `vapid t=${cab}.${corpo}.${b64u(assinatura)}, k=${chaves.publica}`;
}

/** Criptografa a mensagem para uma assinatura (um único registro aes128gcm). */
export async function criptografar(texto: string, assinatura: AssinaturaPush, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<Uint8Array> {
  const uaPublica = deB64u(assinatura.keys.p256dh);
  const authSecret = deB64u(assinatura.keys.auth);
  const efemero = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPublica = new Uint8Array(await crypto.subtle.exportKey("raw", efemero.publicKey));
  const uaChave = await crypto.subtle.importKey("raw", bs(uaPublica), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const segredo = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaChave }, efemero.privateKey, 256));

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0 || ua_public || as_public, 32)
  const prkChave = await hmac(authSecret, segredo);
  const ikm = await hmac(prkChave, juntar(enc.encode("WebPush: info\0"), uaPublica, asPublica, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, juntar(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, juntar(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);

  const chaveAes = await crypto.subtle.importKey("raw", bs(cek), "AES-GCM", false, ["encrypt"]);
  const claro = juntar(enc.encode(texto), new Uint8Array([2]));   // 0x02 = último registro, sem enchimento
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(nonce) }, chaveAes, bs(claro)));

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return juntar(salt, rs, new Uint8Array([asPublica.length]), asPublica, cifrado);
}

/** Envia uma notificação. Retorna o status HTTP (404/410 = assinatura não existe mais). */
export async function enviarPush(assinatura: AssinaturaPush, conteudo: unknown, chaves: ChavesVapid, contato: string, ttl = 86400): Promise<number> {
  const corpo = await criptografar(JSON.stringify(conteudo), assinatura);
  const r = await fetch(assinatura.endpoint, {
    method: "POST",
    headers: {
      Authorization: await cabecalhoVapid(assinatura.endpoint, chaves, contato),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: "normal",
    },
    body: bs(corpo),
  });
  await r.body?.cancel().catch(() => {});
  return r.status;
}
