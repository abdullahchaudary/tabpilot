// tabpilot wire protocol (daemon side). Mirror of extension/wire.js; see that file for the handshake.
import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;
type Key = webcrypto.CryptoKey;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const PROTOCOL_VERSION = 1;

export function randomNonce(): string {
  return Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString("base64");
}

export async function deriveKeys(pairingCode: string, clientNonceB64: string, serverNonceB64: string) {
  const ikm = await subtle.importKey("raw", enc.encode(pairingCode.trim()), "HKDF", false, ["deriveKey"]);
  const salt = Buffer.concat([Buffer.from(clientNonceB64, "base64"), Buffer.from(serverNonceB64, "base64")]);
  const derive = (info: string) =>
    subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: enc.encode(info) },
      ikm,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  return { c2s: await derive("tabpilot/1 ext->daemon"), s2c: await derive("tabpilot/1 daemon->ext") };
}

function ivFor(counter: number): Uint8Array {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(counter));
  return iv;
}

export class Channel {
  private sendCounter = 0;
  private recvCounter = 0;
  private sendChain: Promise<void> = Promise.resolve();
  private recvChain: Promise<void> = Promise.resolve();

  constructor(
    private sendKey: Key,
    private recvKey: Key,
    private transmit: (frame: string) => void,
    private onMessage: (msg: any) => void,
    private onError: (err: unknown) => void,
  ) {}

  send(obj: unknown): Promise<void> {
    const counter = this.sendCounter++;
    this.sendChain = this.sendChain
      .then(async () => {
        const ct = await subtle.encrypt({ name: "AES-GCM", iv: ivFor(counter) }, this.sendKey, enc.encode(JSON.stringify(obj)));
        this.transmit(Buffer.from(ct).toString("base64"));
      })
      .catch((e) => this.onError(e));
    return this.sendChain;
  }

  receive(frame: string): Promise<void> {
    const counter = this.recvCounter++;
    this.recvChain = this.recvChain
      .then(async () => {
        const pt = await subtle.decrypt({ name: "AES-GCM", iv: ivFor(counter) }, this.recvKey, Buffer.from(frame, "base64"));
        this.onMessage(JSON.parse(dec.decode(pt)));
      })
      .catch((e) => this.onError(e));
    return this.recvChain;
  }
}
