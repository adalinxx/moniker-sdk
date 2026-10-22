// Moniker and app profiles for Lattice dApps.
//
// Moniker is the names chain: an account owns @names, sells or gives them,
// and points each at a profile on every app chain that uses it. Each app
// defines its own profiles on its own chain: a profile is an identity an
// account owns (a card: name, photo, words, links), and the app's records are
// written as one. A profile shows `@h` only while it names h and h on Moniker
// points back at it.
//
//   const moniker = createMoniker({ sdk });                          // sdk: the Lattice SDK module
//   const n = await moniker.name("@alice");                          // { handle, owner, price?, offer?, points }
//   const people = createProfiles({ sdk, chain: ["Nexus", "testnet", "rave"], moniker });
//   const p = await people.profile(id);                              // { id, owner, name?, avatar?, shown?, handle?, … }
//   await people.useHandle(id, "@alice", { wallet: window.lattice }); // Moniker points @alice here; the profile names it
//   await people.writeAs(id, { actions: [{ key: `user/${id}/post/1`, newValue: "…" }] }, { wallet: window.lattice });
//
// Reads go to the first of `nodes` that answers and are checked by CID, so
// they do not depend on trusting that node. Writes go to the wallet, which
// shows them to the person and signs; this library never holds a key.
import { connect, monikerClient, profilesClient } from "./client.mjs";

/** Where Moniker lives now: the testnet trial chain and its shared hosts. */
export const DEFAULTS = {
  chain: ["Nexus", "testnet", "moniker-01c01f"],
  nodes: ["https://lattice-testnet-apps-iad.fly.dev", "https://lattice-testnet-apps-ams.fly.dev"],
  app: "https://adalinxx.github.io/moniker/app/",
  // The trial chain's hosts admit 0-fee transactions: writes are free.
  fee: 0n,
  // How long a read state is reused before asking for the tip again.
  freshFor: 10_000,
};

/** The names client for Moniker. */
export function createMoniker(options) {
  const { sdk, chain, nodes, app, fee, freshFor } = { ...DEFAULTS, ...options };
  if (!sdk) throw new Error("createMoniker needs { sdk }: the Lattice SDK module");
  return monikerClient(connect({ sdk, chain, nodes, fee, freshFor }), { app });
}

/**
 * The profiles client for the app chain `chain` (its path, as an array),
 * checking handles against `moniker` (by default `createMoniker({ sdk })`).
 * `nodes`, `fee` and `freshFor` default as for Moniker.
 */
export function createProfiles(options) {
  const { sdk, chain, nodes, fee, freshFor, moniker } = { ...DEFAULTS, chain: undefined, ...options };
  if (!sdk) throw new Error("createProfiles needs { sdk }: the Lattice SDK module");
  if (!Array.isArray(chain)) throw new Error("createProfiles needs { chain }: the app chain's path");
  return profilesClient(connect({ sdk, chain, nodes, fee, freshFor }), moniker ?? createMoniker({ sdk }));
}

export { MONIKER_POLICY } from "./records/names.mjs";
export { isWebURL } from "./records/profiles.mjs";
export { ACCOUNT, combine, isAddress, isHandle, isProfileId } from "./records/shared.mjs";
