// Names on Moniker, every write checked by the built Moniker policy (see harness.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as names from "../src/records/names.mjs";
import { ACCOUNT, combine } from "../src/records/shared.mjs";
import { address, APP_PATH, world } from "./harness.mjs";

const [ALICE, BOB, CAROL] = [address(1), address(2), address(3)];
const RAVE = APP_PATH.join("/");
const OTHER = "Nexus/testnet/stoa-1a2b3c";
const [P1, P2, P3] = ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "cccccccccccccccc"];

test("a name is claimed, pointed on several chains, and read with its pointers", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100 });
  const wallet = w.wallet(ALICE);
  await w.moniker.claim("@alice", { point: { chain: RAVE, profile: P1 } }, { wallet });
  await w.moniker.point("alice", OTHER, P2, { wallet });
  assert.deepEqual(await w.moniker.name("@alice"), { handle: "alice", value: ALICE, owner: ALICE, points: { [OTHER]: P2, [RAVE]: P1 } });
  assert.equal(await w.moniker.pointer("alice", APP_PATH), P1);
  assert.equal(await w.moniker.pointer("alice", OTHER), P2);
  assert.deepEqual((await w.moniker.names(ALICE)).map((n) => n.handle), ["alice"]);
  // Re-pointed, and pointed nowhere on one chain; nothing to write when nothing changes.
  await w.moniker.point("alice", RAVE, P3, { wallet });
  await w.moniker.point("alice", OTHER, null, { wallet });
  assert.deepEqual((await w.moniker.name("alice")).points, { [RAVE]: P3 });
  assert.equal(await w.moniker.point("alice", RAVE, P3, { wallet }), undefined);
  // Only the owner points it: refused here, and by the policy when written by hand.
  await assert.rejects(w.moniker.point("alice", RAVE, P1, { wallet: w.wallet(BOB) }), /isn't yours/);
  const forged = [{ key: "name/alice", oldValue: ALICE, newValue: ALICE }, { key: names.pointsKey("alice", RAVE), oldValue: P3, newValue: P1 }];
  assert.ok(!w.names.submit(BOB, { actions: forged }));
  assert.ok(!w.names.submit(ALICE, { actions: forged.slice(1) }), "a pointer needs its name first");
  await assert.rejects(w.moniker.claim("alice", {}, { wallet: w.wallet(BOB) }), /taken/);
  await assert.rejects(w.moniker.claim("Alice", {}, { wallet }), /lowercase/);
});

test("a sold name moves alone; the buyer re-points it in the same write", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 1000 });
  await w.moniker.claim("mira", { point: { chain: RAVE, profile: P1 } }, { wallet: w.wallet(ALICE) });
  await w.moniker.point("mira", OTHER, P2, { wallet: w.wallet(ALICE) });
  await w.moniker.sell("mira", 500n, { wallet: w.wallet(ALICE) });
  assert.deepEqual((await w.moniker.forSale()).map(({ handle, price }) => [handle, price]), [["mira", 500n]]);
  await w.moniker.buy("@mira", { point: { chain: RAVE, profile: P3 } }, { wallet: w.wallet(BOB) });
  assert.equal(w.names.coins.get(BOB), 1000n - 500n - 1n);
  assert.equal(w.names.coins.get(ALICE), 100n - 3n + 500n);
  const after = await w.moniker.name("mira");
  assert.equal(after.owner, BOB);
  // The pointer Bob set changed; the other stays until he changes it.
  assert.deepEqual(after.points, { [OTHER]: P2, [RAVE]: P3 });
  assert.deepEqual(await w.moniker.names(ALICE), []);
  assert.deepEqual((await w.moniker.names(BOB)).map((n) => n.handle), ["mira"]);
});

test("a name bought pointing nowhere (null) loses every pointer", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 1000 });
  await w.moniker.claim("mira", { price: 5n, point: { chain: RAVE, profile: P1 } }, { wallet: w.wallet(ALICE) });
  await w.moniker.point("mira", OTHER, P2, { wallet: w.wallet(ALICE) });
  await w.moniker.buy("mira", { point: null }, { wallet: w.wallet(BOB) });
  assert.deepEqual((await w.moniker.name("mira")).points, {});
});

test("a stale price or a name not for sale is refused, and the buyer pays nothing", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 1000 });
  await w.moniker.claim("rare", { price: 300n }, { wallet: w.wallet(ALICE) });
  const seen = await names.buy(w.names.state, BOB, "rare");
  await w.moniker.sell("rare", 900n, { wallet: w.wallet(ALICE) });
  const before = w.names.coins.get(BOB);
  assert.ok(!w.names.submit(BOB, seen));
  assert.equal(w.names.coins.get(BOB), before);
  await w.moniker.unlist("rare", { wallet: w.wallet(ALICE) });
  await assert.rejects(w.moniker.buy("rare", {}, { wallet: w.wallet(BOB) }), /not for sale/);
});

test("a name offered to an account is taken by it for nothing, and by no one else", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100, [CAROL]: 100 });
  await w.moniker.claim("gift", {}, { wallet: w.wallet(ALICE) });
  await w.moniker.offer("gift", BOB, { wallet: w.wallet(ALICE) });
  await assert.rejects(w.moniker.buy("gift", {}, { wallet: w.wallet(CAROL) }), /not for sale/);
  await w.moniker.buy("gift", { point: { chain: RAVE, profile: P1 } }, { wallet: w.wallet(BOB) });
  assert.deepEqual([(await w.moniker.name("gift")).owner, await w.moniker.pointer("gift", RAVE)], [BOB, P1]);
  await assert.rejects(w.moniker.offer("gift", BOB, { wallet: w.wallet(BOB) }), /someone else/);
  await assert.rejects(w.moniker.offer("gift", P1, { wallet: w.wallet(BOB) }), /not an address/);
});

test("a released name goes with every pointer it has, and is free again", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100 });
  await w.moniker.claim("gone", { point: { chain: RAVE, profile: P1 } }, { wallet: w.wallet(ALICE) });
  await w.moniker.point("gone", OTHER, P2, { wallet: w.wallet(ALICE) });
  await assert.rejects(w.moniker.release("gone", { wallet: w.wallet(BOB) }), /isn't yours/);
  await w.moniker.release("gone", { wallet: w.wallet(ALICE) });
  assert.equal(await w.moniker.name("gone"), undefined);
  assert.deepEqual([...w.names.map.keys()].filter((key) => key.includes("gone")), []);
  // After a release, only its pointers may follow, and only as deletions.
  await w.moniker.claim("gone", {}, { wallet: w.wallet(BOB) });
  const entry = await names.resolve(w.names.state, "gone");
  const releaseAndPoint = [
    { key: "name/gone", oldValue: entry.value },
    { key: names.namesKey(BOB, "gone"), oldValue: "1" },
    { key: names.pointsKey("gone", RAVE), newValue: P1 },
  ];
  assert.ok(!w.names.submit(BOB, { actions: releaseAndPoint }));
});

test("prices fit a credit; a price of 0 owes nothing", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100 });
  await assert.rejects(w.moniker.claim("big", { price: 2n ** 63n }, { wallet: w.wallet(ALICE) }), /bad price/);
  await w.moniker.claim("big", { price: 2n ** 63n - 1n }, { wallet: w.wallet(ALICE) });
  await w.moniker.sell("big", 0n, { wallet: w.wallet(ALICE) });
  assert.deepEqual((await names.buy(w.names.state, BOB, "big")).payments, []);
  await w.moniker.buy("big", {}, { wallet: w.wallet(BOB) });
  assert.equal((await w.moniker.name("big")).owner, BOB);
});

test("a name bought by request passes the policy once the wallet fills in the account", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 1000 });
  const fill = (write, who) => ({
    actions: JSON.parse(JSON.stringify(write.actions).replaceAll(ACCOUNT, who)),
    payments: write.payments,
  });
  const request = (uri) => JSON.parse(Buffer.from(new URL(uri).searchParams.get("intent"), "base64url").toString("utf8"));
  assert.deepEqual(request(await w.moniker.buyRequest("@fresh")).actions, names.acquire("fresh").actions);
  assert.ok(w.names.submit(BOB, fill(names.acquire("fresh"), BOB)));
  await w.moniker.claim("listed", { price: 7n, point: { chain: RAVE, profile: P1 } }, { wallet: w.wallet(ALICE) });
  const listed = await names.resolve(w.names.state, "listed");
  assert.deepEqual(request(await w.moniker.buyRequest("listed")).payments, [{ to: ALICE, amount: "7" }]);
  assert.ok(w.names.submit(BOB, fill(names.acquire("listed", listed), BOB)));
  assert.deepEqual((await w.moniker.names(BOB)).map((n) => n.handle), ["fresh", "listed"]);
  assert.equal(w.names.coins.get(ALICE), 100n - 1n + 7n);
  assert.equal(await w.moniker.pointer("listed", RAVE), P1, "pointers stay with a sale");
});

test("an account's own fields are set and removed, by it alone", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100 });
  await w.moniker.setField("app.demo.color", "teal", { wallet: w.wallet(ALICE) });
  assert.equal(await w.moniker.field(ALICE, "app.demo.color"), "teal");
  assert.ok(!w.names.submit(BOB, await names.setField(w.names.state, ALICE, "app.demo.color", "red")));
  await w.moniker.setField("app.demo.color", undefined, { wallet: w.wallet(ALICE) });
  assert.equal(await w.moniker.field(ALICE, "app.demo.color"), undefined);
});

test("combine keeps each key where it first comes, and refuses a key changed twice or split purchases", async () => {
  const w = world({ [ALICE]: 100 });
  await w.moniker.claim("one", {}, { wallet: w.wallet(ALICE) });
  const both = combine(await names.pointName(w.names.state, ALICE, "one", RAVE, P1), await names.list(w.names.state, ALICE, "one", 9n));
  assert.deepEqual(both.actions.map((a) => a.key), ["name/one", names.pointsKey("one", RAVE)]);
  assert.equal(both.actions[0].newValue, `${ALICE}@9`);
  assert.ok(w.names.submit(ALICE, both));
  const twice = [await names.list(w.names.state, ALICE, "one", 1n), await names.list(w.names.state, ALICE, "one", 2n)];
  assert.throws(() => combine(...twice), /changed twice/);
  const pays = (to) => ({ actions: [], payments: [{ to, amount: 5n }] });
  assert.doesNotThrow(() => combine(pays(ALICE), pays(ALICE), pays(CAROL)));
  assert.throws(() => combine(pays(ALICE), pays(CAROL), pays(ALICE)), /come together/);
});
