// The link between the extension and the phone app, shared by both.
//
// Pairing makes a random id and a 256-bit key. The phone gets both from the
// QR code, in the part of the address after "#", which browsers never send
// to a server. Messages go through a public ntfy relay on two topics, one
// each way, and are sealed with AES-GCM under the key (compressed first), so
// the relay only ever sees scrambled data.

export const DEFAULT_RELAY = "https://ntfy.sh";
export const MAX_AGE = 120;                 // seconds: older commands are ignored

const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export function newPairing() {
  const abc = "abcdefghijkmnopqrstuvwxyz23456789";
  const id = "sts-" + [...crypto.getRandomValues(new Uint8Array(20))].map((b) => abc[b % abc.length]).join("");
  return { id, key: b64(crypto.getRandomValues(new Uint8Array(32))) };
}

// "id.key", plus the relay when it isn't the default (the tests use a local one)
export function pairingCode(p, relay = DEFAULT_RELAY) {
  return `${p.id}.${p.key}` + (relay !== DEFAULT_RELAY ? `.${b64(new TextEncoder().encode(relay))}` : "");
}

export function parsePairing(code) {
  const m = /^\s*(sts-[a-z0-9]{20})\.([A-Za-z0-9_-]{43})(?:\.([A-Za-z0-9_-]+))?\s*$/.exec(code || "");
  if (!m) return null;
  let relay = DEFAULT_RELAY;
  try { if (m[3]) relay = new TextDecoder().decode(unb64(m[3])); } catch { return null; }
  return { id: m[1], key: m[2], relay };
}

// Connecting with a short code instead of the QR code: the laptop shows a
// code like K7QM-2XPA for 10 minutes and leaves the pairing on the relay,
// sealed under a key stretched from the code (PBKDF2), on a topic named from
// it. Typing the code on the phone finds the topic and opens the pairing.
const CODE_ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no 0/O, 1/I/L
export const CODE_MINUTES = 10;

export function newShortCode() {
  const c = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => CODE_ABC[b % CODE_ABC.length]).join("");
  return c.slice(0, 4) + "-" + c.slice(4);
}

export function normCode(code) {
  const c = (code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 8 && [...c].every((ch) => CODE_ABC.includes(ch)) ? c : null;
}

export async function codeChannel(code) {
  const c = normCode(code);
  if (!c) return null;
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(c), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new TextEncoder().encode("smart-tab-saver pairing code"), iterations: 200000, hash: "SHA-256" }, base, 336));
  const hex = [...bits.slice(32, 42)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { topic: "sts-" + hex, key: b64(bits.slice(0, 32)) };
}

export const toLaptop = (p) => `${p.id}-ph`;    // commands from the phone
export const toPhone = (p) => `${p.id}-pc`;     // tab lists and replies from the laptop

async function aesKey(key) {
  return crypto.subtle.importKey("raw", unb64(key), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

export async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const packed = await pipe(new TextEncoder().encode(JSON.stringify(obj)), new CompressionStream("deflate"));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(key), packed));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64(out);
}

// null if the message wasn't sealed with this key or was changed on the way
export async function unseal(key, text) {
  try {
    const raw = unb64(text.trim());
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await aesKey(key), raw.slice(12));
    return JSON.parse(new TextDecoder().decode(await pipe(new Uint8Array(plain), new DecompressionStream("deflate"))));
  } catch {
    return null;
  }
}

// A command from the phone: the time and a random nonce let the laptop drop
// stale and replayed ones.
export function command(t, extra = {}) {
  return { t, ...extra, at: Date.now(), n: b64(crypto.getRandomValues(new Uint8Array(9))) };
}
