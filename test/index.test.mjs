import assert from "node:assert/strict";
import { test } from "node:test";
import { createMoniker, createProfiles, DEFAULTS, isAddress, isHandle, isProfileId } from "../src/index.mjs";

// Enough of the Lattice SDK for the clients to start; nothing here reads a node.
const sdk = { VolumeClient: class {}, HTTPVolumeTransport: class {}, decodeDagCbor: () => undefined };
const address = "bafyreibc6ggvvnkjlyjghue3qxnagcoprbsh725cutnnnkt3t6dambbt6a";

test("needs the SDK, and an app chain for profiles", () => {
  assert.throws(() => createMoniker({}), /needs \{ sdk \}/);
  assert.throws(() => createProfiles({ sdk }), /needs \{ chain \}/);
});

test("Moniker defaults to the testnet trial chain and its shared hosts", () => {
  const moniker = createMoniker({ sdk });
  assert.deepEqual(moniker.chain, DEFAULTS.chain);
  assert.deepEqual(moniker.nodes, DEFAULTS.nodes);
});

test("profiles live on the app's chain and check handles with the Moniker given", () => {
  const moniker = createMoniker({ sdk });
  const profiles = createProfiles({ sdk, chain: ["Nexus", "testnet", "rave"], moniker });
  assert.deepEqual(profiles.chain, ["Nexus", "testnet", "rave"]);
  assert.equal(profiles.moniker, moniker);
  assert.deepEqual(createProfiles({ sdk, chain: ["Nexus", "x"] }).moniker.chain, DEFAULTS.chain);
});

test("links to the Moniker app", () => {
  const moniker = createMoniker({ sdk, app: "https://example.test/" });
  assert.equal(moniker.pageURL("@ada"), "https://example.test/#/%40ada");
});

test("a photo with no CID is null", async () => {
  assert.equal(await createProfiles({ sdk, chain: ["Nexus", "x"] }).photo(undefined), null);
});

test("writes need a wallet", async () => {
  await assert.rejects(createMoniker({ sdk }).claim("ada", {}, { wallet: undefined }), /Lattice Wallet/);
  await assert.rejects(createProfiles({ sdk, chain: ["Nexus", "x"] }).save("abcdefghijklmnop", { name: "Ada" }, { wallet: undefined }), /Lattice Wallet/);
});

test("checks addresses, handles and profile ids as the policies do", () => {
  assert.ok(isAddress(address));
  assert.ok(!isAddress("bafyrei"));
  for (const bad of [address.toUpperCase(), address.slice(0, 58), `${address.slice(0, 58)}b`]) assert.ok(!isAddress(bad), bad);
  assert.ok(isHandle("ada_1"));
  for (const bad of ["", "Ada", "a-b", "a.b", "é"]) assert.ok(!isHandle(bad), bad);
  assert.ok(isProfileId("abcdefghijklmnop"));
  for (const bad of ["", "abcdefghijklmno", "abcdefghijklmnop1", "ABCDEFGHIJKLMNOP", "abcdefghijklmno1"]) assert.ok(!isProfileId(bad), bad);
});
