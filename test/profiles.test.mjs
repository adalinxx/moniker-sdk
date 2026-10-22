// An app's profiles on its own chain, every write checked by the built app
// policy (Rave's), and handles checked against Moniker (see harness.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import * as profiles from "../src/records/profiles.mjs";
import { combine, isProfileId } from "../src/records/shared.mjs";
import { address, APP_PATH, world } from "./harness.mjs";

const [ALICE, BOB, CAROL] = [address(1), address(2), address(3)];
const RAVE = APP_PATH.join("/");

/** A record of the app's own, keyed by profile `p`. */
const place = (p, id, value) => ({ actions: [{ key: `user/${p}/place/${id}`, newValue: value }] });

test("a profile is made with a card, and read back", async () => {
  const w = world({ [ALICE]: 100 });
  const { id } = await w.profiles.createProfile({ card: { name: "Alice", description: "Eats out", avatar: "bafyreiavatar" } }, { wallet: w.wallet(ALICE) });
  assert.ok(isProfileId(id));
  assert.deepEqual(await w.profiles.profile(id), { id, owner: ALICE, name: "Alice", description: "Eats out", avatar: "bafyreiavatar" });
  assert.deepEqual((await w.profiles.profilesOf(ALICE)).map((p) => p.id), [id]);
  assert.equal(await w.profiles.profile("aaaaaaaaaaaaaaaa"), undefined);
  assert.deepEqual(await w.profiles.profiles(["aaaaaaaaaaaaaaaa", id]).then((ps) => ps.map((p) => p.owner)), [undefined, ALICE]);
  assert.equal(w.profiles.label({ id, handle: "alice" }), "@alice");
  assert.equal(w.profiles.label({ id }), `Profile …${id.slice(-6)}`);
});

test("a card is saved field by field, keeps fields it doesn't know, and retries a stale save", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100 });
  const wallet = w.wallet(ALICE);
  const { id } = await w.profiles.createProfile({ card: { name: "Alice" } }, { wallet });
  w.apps.map.set(profiles.cardKey(id), JSON.stringify({ name: "Alice", pronouns: "she/her" }));
  await w.profiles.save(id, { url: "https://alice.example", links: [{ label: "Site", url: "https://alice.example" }] }, { wallet });
  assert.deepEqual(JSON.parse(w.apps.map.get(profiles.cardKey(id))), { name: "Alice", pronouns: "she/her", url: "https://alice.example", links: [{ label: "Site", url: "https://alice.example" }] });
  assert.equal(await w.profiles.save(id, { name: "Alice" }, { wallet }), undefined, "nothing changed");
  await assert.rejects(w.profiles.save(id, { links: [{ label: "x", url: "javascript:alert(1)" }] }, { wallet }), /not an http/);
  await assert.rejects(w.profiles.save(id, { name: "Not Alice" }, { wallet: w.wallet(BOB) }), /don't act for/);
  // Another app saves first: the save reads again and lands on the new card.
  let first = true;
  const racing = {
    ...wallet,
    writeRecords: async (request) => {
      if (first) {
        first = false;
        assert.ok(w.apps.submit(ALICE, await profiles.editCard(w.apps.state, ALICE, id, { description: "from app two" })));
      }
      return wallet.writeRecords(request);
    },
  };
  await w.profiles.save(id, { header: "bafyreiheader" }, { wallet: racing });
  const card = JSON.parse(w.apps.map.get(profiles.cardKey(id)));
  assert.deepEqual([card.description, card.header], ["from app two", "bafyreiheader"]);
});

test("useHandle points the handle on Moniker and names it on the profile; both are checked before it shows", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100 });
  const wallet = w.wallet(ALICE);
  const { id } = await w.profiles.createProfile({ card: { name: "Alice" } }, { wallet });
  await w.profiles.useHandle(id, "@alice", { wallet }); // claims it: it was free
  assert.equal(await w.moniker.pointer("alice", APP_PATH), id);
  assert.equal(w.apps.map.get(profiles.shownKey(id)), "alice");
  assert.equal((await w.profiles.profile(id)).handle, "alice");
  assert.deepEqual(await w.profiles.profileOf("@alice"), { id, owner: ALICE, name: "Alice", shown: "alice", handle: "alice", namesBack: true });
  // A second profile takes the handle over: the first still names it, but no longer shows it.
  const { id: second } = await w.profiles.createProfile({}, { wallet });
  await w.profiles.useHandle(second, "alice", { wallet });
  const firstNow = await w.profiles.profile(id);
  assert.deepEqual([firstNow.shown, firstNow.handle], ["alice", undefined]);
  assert.equal((await w.profiles.profile(second)).handle, "alice");
  // A profile that names a handle pointing elsewhere does not show it.
  const { id: bobs } = await w.profiles.createProfile({ card: { name: "Bob" } }, { wallet: w.wallet(BOB) });
  assert.ok(w.apps.submit(BOB, await profiles.setShown(w.apps.state, BOB, bobs, "alice")));
  assert.deepEqual([(await w.profiles.profile(bobs)).shown, (await w.profiles.profile(bobs)).handle], ["alice", undefined]);
  // A handle that points at a profile which doesn't name it back.
  await w.moniker.claim("tess", { point: { chain: RAVE, profile: bobs } }, { wallet });
  assert.equal((await w.profiles.profileOf("tess")).namesBack, false);
  assert.equal(await w.profiles.profileOf("nobody"), undefined);
  // Someone else's handle can't be used.
  await assert.rejects(w.profiles.useHandle(bobs, "alice", { wallet: w.wallet(BOB) }), /isn't yours/);
  await w.profiles.stopHandle(second, { wallet });
  assert.equal((await w.profiles.profile(second)).handle, undefined);
});

test("an admin writes as the profile; the policy refuses anyone who doesn't act for it", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100, [CAROL]: 100 });
  const { id } = await w.profiles.createProfile({ card: { name: "Band" } }, { wallet: w.wallet(ALICE) });
  await w.profiles.setAdmin(id, BOB, true, { wallet: w.wallet(ALICE) });
  assert.equal(w.apps.map.get(profiles.adminKey(id, BOB)), ALICE, "an admin key holds the owner who named it");
  assert.deepEqual(await w.profiles.admins(id), [BOB]);
  assert.ok(await w.profiles.actsFor(BOB, id));
  assert.deepEqual(await w.profiles.proof(w.apps.state, id, BOB), [
    { key: profiles.profileKey(id), oldValue: ALICE, newValue: ALICE },
    { key: profiles.adminKey(id, BOB), oldValue: ALICE, newValue: ALICE },
  ]);
  await w.profiles.writeAs(id, place(id, "1", "{}"), { wallet: w.wallet(BOB) });
  await w.profiles.save(id, { description: "Plays loud" }, { wallet: w.wallet(BOB) });
  assert.equal(w.apps.map.get(`user/${id}/place/1`), "{}");
  // An admin doesn't name admins.
  await assert.rejects(w.profiles.setAdmin(id, CAROL, true, { wallet: w.wallet(BOB) }), /isn't yours/);
  // Carol doesn't act for it: refused here, and by the policy with any proof she could write.
  await assert.rejects(w.profiles.writeAs(id, place(id, "2", "{}"), { wallet: w.wallet(CAROL) }), /don't act for/);
  assert.ok(!w.apps.submit(CAROL, place(id, "2", "{}")));
  assert.ok(!w.apps.submit(CAROL, combine({ actions: [{ key: profiles.profileKey(id), oldValue: ALICE, newValue: ALICE }] }, place(id, "2", "{}"))));
  // Bob's proof without his admin key isn't enough.
  assert.ok(!w.apps.submit(BOB, combine({ actions: [{ key: profiles.profileKey(id), oldValue: ALICE, newValue: ALICE }] }, place(id, "2", "{}"))));
  await w.profiles.setAdmin(id, BOB, false, { wallet: w.wallet(ALICE) });
  assert.ok(!(await w.profiles.actsFor(BOB, id)));
});

test("a sold profile moves its owns keys, and its admins stop acting at once", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100, [CAROL]: 1000 });
  const { id } = await w.profiles.createProfile({ card: { name: "Tess Bakes" } }, { wallet: w.wallet(ALICE) });
  await w.profiles.setAdmin(id, BOB, true, { wallet: w.wallet(ALICE) });
  await w.profiles.sell(id, 700n, { wallet: w.wallet(ALICE) });
  await w.profiles.buy(id, { wallet: w.wallet(CAROL) });
  assert.equal(w.apps.coins.get(ALICE), 100n - 3n + 700n);
  assert.deepEqual([w.apps.map.get(profiles.ownsKey(ALICE, id)), w.apps.map.get(profiles.ownsKey(CAROL, id))], [undefined, "1"]);
  assert.deepEqual(await w.profiles.profilesOf(ALICE), []);
  assert.deepEqual((await w.profiles.profilesOf(CAROL)).map((p) => [p.id, p.name]), [[id, "Tess Bakes"]]);
  // Bob was Alice's admin: the key stays, and acts no more.
  assert.deepEqual(await w.profiles.admins(id), []);
  assert.ok(!(await w.profiles.actsFor(BOB, id)));
  await assert.rejects(w.profiles.writeAs(id, place(id, "1", "{}"), { wallet: w.wallet(BOB) }), /don't act for/);
  const stale = [
    { key: profiles.profileKey(id), oldValue: CAROL, newValue: CAROL },
    { key: profiles.adminKey(id, BOB), oldValue: ALICE, newValue: ALICE },
  ];
  assert.ok(!w.apps.submit(BOB, combine({ actions: stale }, place(id, "1", "{}"))));
  // The new owner writes as it; the old one can't.
  await w.profiles.writeAs(id, place(id, "1", "{}"), { wallet: w.wallet(CAROL) });
  await assert.rejects(w.profiles.save(id, { name: "Mine" }, { wallet: w.wallet(ALICE) }), /don't act for/);
});

test("a profile offered to an account is taken by it for nothing; a price of 0 owes nothing", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 100, [CAROL]: 100 });
  const { id } = await w.profiles.createProfile({}, { wallet: w.wallet(ALICE) });
  await w.profiles.offer(id, BOB, { wallet: w.wallet(ALICE) });
  await assert.rejects(w.profiles.buy(id, { wallet: w.wallet(CAROL) }), /not for sale/);
  await w.profiles.buy(id, { wallet: w.wallet(BOB) });
  assert.equal((await w.profiles.profile(id)).owner, BOB);
  await w.profiles.sell(id, 0n, { wallet: w.wallet(BOB) });
  assert.deepEqual((await profiles.takeProfile(w.apps.state, CAROL, id)).payments, []);
  await w.profiles.buy(id, { wallet: w.wallet(CAROL) });
  await w.profiles.unlist(id, { wallet: w.wallet(CAROL) });
  assert.equal(w.apps.map.get(profiles.profileKey(id)), CAROL);
  await assert.rejects(w.profiles.offer(id, CAROL, { wallet: w.wallet(CAROL) }), /someone else/);
});

test("a handle bought on Moniker moves alone: the old profile stops showing it when the buyer re-points it", async () => {
  const w = world({ [ALICE]: 100, [BOB]: 1000 });
  const { id: mira } = await w.profiles.createProfile({ card: { name: "Mira" } }, { wallet: w.wallet(ALICE) });
  await w.profiles.useHandle(mira, "mira", { wallet: w.wallet(ALICE) });
  await w.moniker.sell("mira", 50n, { wallet: w.wallet(ALICE) });
  const { id: bobs } = await w.profiles.createProfile({ card: { name: "Bob" } }, { wallet: w.wallet(BOB) });
  await w.moniker.buy("mira", {}, { wallet: w.wallet(BOB) });
  assert.equal((await w.profiles.profile(mira)).handle, "mira", "the pointer stays until the new owner changes it");
  await w.profiles.useHandle(bobs, "mira", { wallet: w.wallet(BOB) });
  assert.equal((await w.profiles.profile(mira)).handle, undefined);
  assert.equal((await w.profiles.profile(bobs)).handle, "mira");
});

test("combine puts a profile's proof first and its real change in its place", async () => {
  const w = world({ [ALICE]: 100 });
  const { id } = await w.profiles.createProfile({}, { wallet: w.wallet(ALICE) });
  const both = combine(await profiles.setShown(w.apps.state, ALICE, id, "one"), await profiles.setProfileTerms(w.apps.state, ALICE, id, { price: 9n }));
  assert.deepEqual(both.actions.map((a) => a.key), [profiles.profileKey(id), profiles.shownKey(id)]);
  assert.equal(both.actions[0].newValue, `${ALICE}@9`);
  assert.ok(w.apps.submit(ALICE, both));
  const twice = [await profiles.setProfileTerms(w.apps.state, ALICE, id, { price: 1n }), await profiles.setProfileTerms(w.apps.state, ALICE, id, { price: 2n })];
  assert.throws(() => combine(...twice), /changed twice/);
});
