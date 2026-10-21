import assert from "node:assert/strict";
import { test } from "node:test";
import { createMoniker, DEFAULTS, isAddress, isHandle } from "../src/index.mjs";

// Enough of the Lattice SDK for createMoniker to start; nothing here reads a node.
const sdk = { VolumeClient: class {}, HTTPVolumeTransport: class {}, decodeDagCbor: () => undefined };
const address = "bafyreibc6ggvvnkjlyjghue3qxnagcoprbsh725cutnnnkt3t6dambbt6a";

test("needs the SDK", () => {
  assert.throws(() => createMoniker({}), /needs \{ sdk \}/);
});

test("defaults to the testnet trial chain and its shared hosts", () => {
  const moniker = createMoniker({ sdk });
  assert.deepEqual(moniker.chain, DEFAULTS.chain);
  assert.deepEqual(moniker.nodes, DEFAULTS.nodes);
});

test("labels a profile by name, then @handle, then the end of its id", () => {
  const { label } = createMoniker({ sdk });
  const id = "abcdefghijklmnop";
  assert.equal(label({ id, name: "Ada", handle: "ada" }), "Ada");
  assert.equal(label({ id, handle: "ada" }), "@ada");
  assert.equal(label({ id }), "Profile …klmnop");
});

test("links to the Moniker app", () => {
  const moniker = createMoniker({ sdk, app: "https://example.test/" });
  assert.equal(moniker.pageURL("@ada"), "https://example.test/#/%40ada");
});

test("a photo with no CID is null", async () => {
  assert.equal(await createMoniker({ sdk }).photo(undefined), null);
});

test("writes need a wallet", async () => {
  await assert.rejects(createMoniker({ sdk }).save("abcdefghijklmnop", { name: "Ada" }, { wallet: undefined }), /Lattice Wallet/);
});

test("checks addresses and handles", () => {
  assert.ok(isAddress(address));
  assert.ok(!isAddress("bafyrei"));
  assert.ok(isHandle("ada_1"));
  assert.ok(!isHandle("Ada"));
});
