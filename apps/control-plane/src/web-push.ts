/**
 * Web Push without a library: the message encryption of RFC 8291 (ECDH on P-256, HKDF, AES-128-GCM
 * in the `aes128gcm` content coding of RFC 8188) and the VAPID request signing of RFC 8292 (an ES256
 * JWT for the push service's origin). Everything comes from `node:crypto`; `encrypt` takes the
 * ephemeral key and salt as parameters so the RFC's test vector can be replayed against it.
 */
import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from "node:crypto";

export type VapidKeys = { publicKey: string; privateKey: string };

export type PushKeys = { p256dh: string; auth: string };

const CURVE = "prime256v1";
/** One record holds the whole (small) payload; the push service caps bodies at 4 kB anyway. */
const RECORD_SIZE = 4096;

const b64url = (b: Buffer): string => b.toString("base64url");
const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

/** A fresh P-256 pair: the public key as the 65-byte uncompressed point, the private as the 32-byte scalar (both base64url). */
export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: CURVE });
  const jwk = privateKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.y || !jwk.d) throw new Error("EC key export gave no coordinates");
  const point = Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)]);
  return { publicKey: b64url(point), privateKey: jwk.d };
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}

/**
 * RFC 8291 §3: the body of a push request for one subscription, `aes128gcm` coded (header with
 * salt, record size and the server's ephemeral public key, then a single record).
 */
export function encrypt(
  keys: PushKeys,
  plaintext: Buffer,
  ephemeral: { privateKey: Buffer; salt: Buffer } = { privateKey: randomBytes(32), salt: randomBytes(16) },
): Buffer {
  const uaPublic = fromB64url(keys.p256dh);
  const authSecret = fromB64url(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("p256dh is not an uncompressed P-256 point");
  if (authSecret.length !== 16) throw new Error("auth secret is not 16 bytes");

  const ecdh = createECDH(CURVE);
  ecdh.setPrivateKey(ephemeral.privateKey);
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);
  const cek = hkdf(ephemeral.salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(ephemeral.salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  if (plaintext.length + 1 + 16 > RECORD_SIZE) throw new Error(`push payload too large (${plaintext.length} bytes)`);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 marks the last (here: only) record.
  const record = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  ephemeral.salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, record]);
}

/** RFC 8292 §2 and §3: `Authorization: vapid t=<JWT for the endpoint's origin>, k=<public key>`. */
export function vapidAuthorization(vapid: VapidKeys, endpoint: string, subject: string, now = Date.now()): string {
  const pub = fromB64url(vapid.publicKey);
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)), d: vapid.privateKey },
    format: "jwk",
  });
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${vapid.publicKey}`;
}

export type PushDelivery = { ok: true; status: number } | { ok: false; status: number; gone: boolean; error: string };

/**
 * Posts one encrypted message to a subscription's push service (RFC 8030). `gone` means the
 * subscription no longer exists there (404/410) and should be forgotten.
 */
export async function deliver(
  endpoint: string,
  keys: PushKeys,
  payload: string,
  vapid: VapidKeys,
  subject: string,
  ttlSeconds = 24 * 3600,
): Promise<PushDelivery> {
  const body = encrypt(keys, Buffer.from(payload, "utf8"));
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: vapidAuthorization(vapid, endpoint, subject),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(ttlSeconds),
        urgency: "high",
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (res.ok) return { ok: true, status: res.status };
  const text = (await res.text().catch(() => "")).slice(0, 200);
  return { ok: false, status: res.status, gone: res.status === 404 || res.status === 410, error: `${res.status} ${text}`.trim() };
}
