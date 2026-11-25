// tabpilot wire protocol (extension side).
// Mirror of src/wire.ts. If you change one, change the other; test/wire.test.mjs checks they agree.
//
// Handshake:
//   ext    -> daemon  {"t":"hello","v":1,"nonce":<b64 16 bytes>}      (plaintext)
//   daemon -> ext     {"t":"challenge","nonce":<b64 16 bytes>}        (plaintext)
//   both derive two AES-256-GCM keys with HKDF-SHA256(pairing code, clientNonce||serverNonce)
//   every later frame is base64(AES-GCM ciphertext), IV = 4 zero bytes + 8-byte big-endian counter.
// The pairing code never crosses the wire. Counters must match exactly, so replayed,
// dropped or reordered frames fail to decrypt and kill the connection.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const PROTOCOL_VERSION = 1;

export function randomNonce() {
  return toB64(crypto.getRandomValues(new Uint8Array(16)));
}

export function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromB64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function deriveKeys(pairingCode, clientNonceB64, serverNonceB64) {
  const ikm = await crypto.subtle.importKey("raw", enc.encode(pairingCode.trim()), "HKDF", false, ["deriveKey"]);
  const a = fromB64(clientNonceB64);
  const b = fromB64(serverNonceB64);
  const salt = new Uint8Array(a.length + b.length);
  salt.set(a, 0);
  salt.set(b, a.length);
  const derive = (info) =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: enc.encode(info) },
      ikm,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  return { c2s: await derive("tabpilot/1 ext->daemon"), s2c: await derive("tabpilot/1 daemon->ext") };
}

function ivFor(counter) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(counter));
  return iv;
}

// An ordered, encrypted pipe. `transmit(str)` puts a frame on the socket, `onMessage(obj)` gets decrypted messages.
export class Channel {
  constructor(sendKey, recvKey, transmit, onMessage, onError) {
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.transmit = transmit;
    this.onMessage = onMessage;
    this.onError = onError;
    this.sendCounter = 0;
    this.recvCounter = 0;
    this.sendChain = Promise.resolve();
    this.recvChain = Promise.resolve();
  }

  send(obj) {
    const counter = this.sendCounter++;
    this.sendChain = this.sendChain
      .then(async () => {
        const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: ivFor(counter) }, this.sendKey, enc.encode(JSON.stringify(obj)));
        this.transmit(toB64(new Uint8Array(ct)));
      })
      .catch((e) => this.onError(e));
    return this.sendChain;
  }

  receive(frame) {
    const counter = this.recvCounter++;
    this.recvChain = this.recvChain
      .then(async () => {
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivFor(counter) }, this.recvKey, fromB64(frame));
        this.onMessage(JSON.parse(dec.decode(pt)));
      })
      .catch((e) => this.onError(e));
    return this.recvChain;
  }
}
