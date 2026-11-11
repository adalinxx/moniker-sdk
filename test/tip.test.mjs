// Tips: a payment, with nothing written, to the account a handle shows on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { writeRequest } from "../src/records/wallet.mjs";
import { address, MONIKER_PATH, world } from "./harness.mjs";

const [ALICE, BOB, CAROL] = [address(1), address(2), address(3)];

test("a tip pays the account @handle shows on, from the tipper's coins, and passes Moniker's policy", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100 });
  await w.moniker.claim("alice", { show: true }, { wallet: w.wallet(ALICE) });
  const before = w.names.coins.get(ALICE);
  const keys = w.names.map.size;
  await w.moniker.tip("@alice", 5, { wallet: w.wallet(BOB) });
  assert.equal(w.names.coins.get(ALICE), before + 5n);
  assert.equal(w.names.coins.get(BOB), 100n - 5n - 1n, "the tip and the fee");
  assert.equal(w.names.map.size, keys, "nothing written");
  // To an account directly, shown or not.
  await w.moniker.tip(CAROL, 2n, { wallet: w.wallet(BOB) });
  assert.equal(w.names.coins.get(CAROL), 2n);
});

test("a tip is refused to a handle no account shows, to yourself, and below 1 coin", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100 });
  const wallet = w.wallet(BOB);
  await assert.rejects(w.moniker.tip("@nobody", 5, { wallet }), /No account shows @nobody/);
  // Pointed at Carol, who doesn't show it: a tip would go to someone shown as another name, or none.
  await w.moniker.claim("alice", { point: CAROL }, { wallet: w.wallet(ALICE) });
  await assert.rejects(w.moniker.tip("@alice", 5, { wallet }), /No account shows @alice/);
  await w.moniker.claim("bob", { show: true }, { wallet });
  await assert.rejects(w.moniker.tip("@bob", 5, { wallet }), /tip yourself/);
  await assert.rejects(w.moniker.tip(ALICE, 0, { wallet }), /at least 1 coin/);
  await assert.rejects(w.moniker.tip(ALICE, 5, {}), /wallet/i);
  // More than the tipper holds: the chain refuses it.
  await assert.rejects(w.moniker.tip(ALICE, 1000, { wallet }), /refused/);
});

test("a tip in another chain's coins asks the wallet for only a payment there, from coins only", async () => {
  const w = world({ [ALICE]: 100 });
  await w.moniker.claim("alice", { show: true }, { wallet: w.wallet(ALICE) });
  const asked = [];
  const wallet = { address: async () => BOB, writeRecords: async (request) => (asked.push(request), { transactionCID: "bafytip" }) };
  assert.deepEqual(await w.moniker.tip("@alice", 7n, { chain: "Nexus/stoa", wallet }), { transactionCID: "bafytip" });
  await w.moniker.tip("@alice", 1, { chain: ["Nexus"], wallet });
  assert.deepEqual(asked, [
    { chainPath: ["Nexus", "stoa"], actions: [], payments: [{ to: ALICE, amount: "7" }], coinOnly: true },
    { chainPath: ["Nexus"], actions: [], payments: [{ to: ALICE, amount: "1" }], coinOnly: true },
  ]);
  assert.throws(() => writeRequest(MONIKER_PATH, { actions: [], payments: [] }), /Nothing to write/);
});

test("Selfhold's client is handed the request at once, as a promise, so its window opens in the click", async () => {
  const w = world({ [ALICE]: 100 });
  await w.moniker.claim("alice", { show: true }, { wallet: w.wallet(ALICE) });
  let handed;
  const wallet = { isSelfholdWeb: true, address: async () => null, writeRecords: (request) => ((handed = request), request.then(() => ({ transactionCID: "bafytip" }))) };
  await w.moniker.tip("@alice", 3, { wallet });
  assert.ok(handed instanceof Promise);
  assert.deepEqual(await handed, { chainPath: ["Nexus", "testnet", "moniker"], actions: [], payments: [{ to: ALICE, amount: "3" }], coinOnly: true });
  const self = { ...wallet, address: async () => ALICE, writeRecords: (request) => request };
  await assert.rejects(w.moniker.tip("@alice", 3, { wallet: self }), /tip yourself/);
});
