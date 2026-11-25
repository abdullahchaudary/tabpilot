// The daemon (src/wire.ts) and the extension (extension/wire.js) implement the same protocol twice.
// These tests make sure the two halves actually understand each other.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as daemon from "../dist/wire.js";
import * as ext from "../extension/wire.js";

async function pair(codeExt, codeDaemon) {
  const cn = ext.randomNonce();
  const sn = daemon.randomNonce();
  const ek = await ext.deriveKeys(codeExt, cn, sn);
  const dk = await daemon.deriveKeys(codeDaemon, cn, sn);
  return { ek, dk };
}

function pipe(sendKey, recvKey, Sender, Receiver) {
  const got = [];
  const errors = [];
  let rx;
  const tx = new Sender(sendKey, recvKey, (frame) => rx.receive(frame), () => {}, (e) => errors.push(e));
  rx = new Receiver(recvKey, sendKey, () => {}, (m) => got.push(m), (e) => errors.push(e));
  return { tx, rx, got, errors };
}

test("extension -> daemon round trip, in order", async () => {
  const { ek, dk } = await pair("tp-abcde-fghij-klmno-pqrst", "tp-abcde-fghij-klmno-pqrst");
  const got = [];
  const d = new daemon.Channel(dk.s2c, dk.c2s, () => {}, (m) => got.push(m), assert.fail);
  const e = new ext.Channel(ek.c2s, ek.s2c, (f) => d.receive(f), () => {}, assert.fail);
  for (let i = 0; i < 20; i++) e.send({ i, big: "x".repeat(i * 5000) });
  await e.sendChain;
  await d["recvChain"];
  assert.deepEqual(got.map((m) => m.i), [...Array(20).keys()]);
});

test("daemon -> extension round trip", async () => {
  const { ek, dk } = await pair("same-code", "same-code");
  const got = [];
  const e = new ext.Channel(ek.c2s, ek.s2c, () => {}, (m) => got.push(m), assert.fail);
  const d = new daemon.Channel(dk.s2c, dk.c2s, (f) => e.receive(f), () => {}, assert.fail);
  await d.send({ id: 1, method: "tabs.list" });
  await e.recvChain;
  assert.deepEqual(got, [{ id: 1, method: "tabs.list" }]);
});

test("wrong pairing code fails to decrypt", async () => {
  const { ek, dk } = await pair("right-code", "wrong-code");
  let failed = false;
  const d = new daemon.Channel(dk.s2c, dk.c2s, () => {}, () => assert.fail("should not decrypt"), () => (failed = true));
  const e = new ext.Channel(ek.c2s, ek.s2c, (f) => d.receive(f), () => {}, assert.fail);
  await e.send({ t: "auth" });
  await d["recvChain"];
  assert.ok(failed);
});

test("replayed frame is rejected", async () => {
  const { ek, dk } = await pair("code", "code");
  const frames = [];
  const e = new ext.Channel(ek.c2s, ek.s2c, (f) => frames.push(f), () => {}, assert.fail);
  await e.send({ n: 1 });
  let failed = false;
  const got = [];
  const d = new daemon.Channel(dk.s2c, dk.c2s, () => {}, (m) => got.push(m), () => (failed = true));
  d.receive(frames[0]);
  await d.receive(frames[0]); // same frame again
  assert.deepEqual(got, [{ n: 1 }]);
  assert.ok(failed);
});

test("directions use different keys (no reflection)", async () => {
  const { ek } = await pair("code", "code");
  const frames = [];
  const e = new ext.Channel(ek.c2s, ek.s2c, (f) => frames.push(f), () => {}, assert.fail);
  await e.send({ t: "auth" });
  let failed = false;
  const self = new ext.Channel(ek.c2s, ek.s2c, () => {}, () => assert.fail("reflected"), () => (failed = true));
  await self.receive(frames[0]);
  assert.ok(failed);
});
