// Names on Moniker, the names chain, read from a state view
// `{ get(key), list(prefix) }` (see state.mjs) and written as
// `{ actions, payments? }` for the wallet (see wallet.mjs).
//
// An account owns names (@handles): assets it may sell or give, and point at
// a profile on each app chain that uses them. The profiles live on those
// chains (see profiles.mjs); a profile shows a handle only while it names
// that handle and the handle points back at it.
//
// Keys:
//   name/<h>               <owner>, <owner>@<price> or <owner>><account> (offered to it)
//   names/<a>/<h>          1 while <a> owns <h>
//   points/<h>/<chain>     the profile id <h> points at on app chain <chain> (a path such as Nexus/testnet/rave)
//   user/<a>/<field>       the account's own: key.x25519, app.<name>.<field>
//
// The policy reads a transaction in order: a name, then the index keys it
// moves (the one it leaves first), then its pointers, which only the name's
// owner writes. A released name may be followed only by deleting its
// pointers.
import { ACCOUNT, change, chainPath, checkedTerms, heldToken, isHandle, isProfileId, paymentFor, takeable, tokenValue, unchanged, write } from "./shared.mjs";

/** The CID of the Moniker policy module this release reads and writes for; set at each release. */
export const MONIKER_POLICY = "bafyreieg5pneszyq5e6ygfwg2otdf5cecekbbw25sg5kkr7letnfb4jjve";

/**
 * Whether a chain spec (see state.mjs `chainSpec`) runs the Moniker policy.
 * Every policy in a spec must accept a transaction, so further policies may
 * refuse more but never let through what this one refuses.
 */
export const runsMoniker = (spec) =>
  Array.isArray(spec?.wasmPolicies) &&
  spec.wasmPolicies.some(
    (policy) =>
      policy?.moduleCID === MONIKER_POLICY &&
      policy.scope === "transaction" &&
      policy.entrypoint === "lattice_validate_transaction",
  );

export const nameKey = (handle) => `name/${handle}`;
export const namesKey = (account, handle) => `names/${account}/${handle}`;
export const pointsKey = (handle, chain) => `points/${handle}/${chainPath(chain)}`;
export const fieldKey = (account, field) => `user/${account}/${field}`;

const checkedHandle = (handle) => {
  if (!isHandle(handle)) throw new Error(`${handle}: a handle is lowercase letters, digits and _`);
  return handle;
};

// Reading.

/** The pointers of `handle` as `{ [chain]: profile id }`; raw values are kept as `[key, value]` in `keys`. */
async function pointersOf(state, handle) {
  const prefix = `points/${handle}/`;
  const points = {};
  const keys = [];
  for await (const [key, value] of state.list(prefix)) {
    keys.push([key, value]);
    if (isProfileId(value)) points[key.slice(prefix.length)] = value;
  }
  return { points, keys };
}

/**
 * The name as held: `{ handle, value, owner, price?, offer?, points }`, where
 * `points` is `{ [chain]: profile id }`; undefined when the name is free.
 */
export async function resolve(state, handle) {
  if (!isHandle(handle)) return undefined;
  const token = await heldToken(state, nameKey(handle));
  return token && { handle, ...token, points: (await pointersOf(state, handle)).points };
}

/** The profile id `handle` points at on `chain`, or undefined. */
export async function pointer(state, handle, chain) {
  if (!isHandle(handle)) return undefined;
  const value = await state.get(pointsKey(handle, chain));
  return isProfileId(value) ? value : undefined;
}

/** The names `account` owns, as `resolve` returns them, in handle order: one prefix read of `names/`. */
export async function namesOf(state, account) {
  const prefix = `names/${account}/`;
  const found = [];
  for await (const [key] of state.list(prefix)) {
    const entry = await resolve(state, key.slice(prefix.length));
    if (entry?.owner === account) found.push(entry);
  }
  return found;
}

/** Every name, as `resolve` returns it, in handle order. Reads all of `name/`. */
export async function* handles(state) {
  for await (const [key] of state.list("name/")) {
    const entry = await resolve(state, key.slice("name/".length));
    if (entry) yield entry;
  }
}

/** The names for sale, cheapest first. */
export async function forSale(state) {
  const found = [];
  for await (const entry of handles(state)) if (entry.price !== undefined) found.push(entry);
  return found.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : a.handle < b.handle ? -1 : 1));
}

/** `account`'s own fields, as `{ field: value }`. */
export async function getFields(state, account) {
  const prefix = `user/${account}/`;
  const fields = {};
  for await (const [key, value] of state.list(prefix)) fields[key.slice(prefix.length)] = value;
  return fields;
}

export const getField = (state, account, field) => state.get(fieldKey(account, field));

// Writing.

/** The name `handle`, which `account` owns. */
async function ownName(state, account, handle) {
  const entry = await resolve(state, checkedHandle(handle));
  if (!entry) throw new Error(`No one owns @${handle}`);
  if (entry.owner !== account) throw new Error(`@${handle} isn't yours`);
  return entry;
}

/**
 * The pointer changes `point` asks for, to follow a name its new owner
 * signs for: `{ chain, profile }` sets that chain's pointer; null deletes
 * every pointer; undefined leaves them as they are.
 */
async function pointing(state, handle, point) {
  if (point === undefined) return [];
  if (point === null) return (await pointersOf(state, handle)).keys.map(([key, value]) => change(key, value, undefined));
  if (!isProfileId(point.profile)) throw new Error(`not a profile: ${point.profile}`);
  const key = pointsKey(handle, point.chain);
  const old = await state.get(key);
  return old === point.profile ? [] : [change(key, old, point.profile)];
}

/**
 * `account` claims the free `handle`, for sale at `price` or not, pointed at
 * `point` (`{ chain, profile }`) if given.
 */
export async function claim(state, account, handle, { price, point } = {}) {
  checkedHandle(handle);
  if ((await state.get(nameKey(handle))) !== undefined) throw new Error(`@${handle} is taken`);
  return write([
    change(nameKey(handle), undefined, tokenValue(account, { price })),
    change(namesKey(account, handle), undefined, "1"),
    ...(await pointing(state, handle, point)),
  ]);
}

/** Points `handle`, which `account` owns, at profile `p` on `chain`, or nowhere there when `p` is null. */
export async function pointName(state, account, handle, chain, p) {
  if (p != null && !isProfileId(p)) throw new Error(`not a profile: ${p}`);
  const entry = await ownName(state, account, handle);
  const key = pointsKey(handle, chain);
  const old = await state.get(key);
  const next = p ?? undefined;
  if (old === next) return write([]);
  return write([unchanged(nameKey(handle), entry.value), change(key, old, next)]);
}

/** Puts `handle` up for sale at `price`. Anyone may then buy it at that price. */
export async function list(state, account, handle, price) {
  if (price === undefined) throw new Error("a listing needs a price");
  const entry = await ownName(state, account, handle);
  return write([change(nameKey(handle), entry.value, tokenValue(account, { price }))]);
}

/** Takes `handle` off sale, or back from an offer. */
export async function unlist(state, account, handle) {
  const entry = await ownName(state, account, handle);
  return write([change(nameKey(handle), entry.value, account)]);
}

/** Offers `handle` to account `to`, which may then take it for nothing. */
export async function offerName(state, account, handle, to) {
  checkedTerms({ offer: to });
  const entry = await ownName(state, account, handle);
  return write([change(nameKey(handle), entry.value, tokenValue(account, { offer: to }))]);
}

/**
 * `account` takes `handle`: bought at the price the chain holds, its owner
 * paid in the same transaction, or taken as offered to it. Only the name
 * moves: its pointers stay until its new owner changes them, here with
 * `point` (`{ chain, profile }`, or null for nowhere).
 */
export async function buy(state, account, handle, { point } = {}) {
  const entry = await resolve(state, checkedHandle(handle));
  if (!entry) throw new Error(`No one owns @${handle}`);
  takeable(entry, account, `@${handle}`);
  return write(
    [
      change(nameKey(handle), entry.value, account),
      change(namesKey(entry.owner, handle), "1", undefined),
      change(namesKey(account, handle), undefined, "1"),
      ...(await pointing(state, handle, point)),
    ],
    paymentFor(entry),
  );
}

/**
 * `handle` taken by whichever account signs, with no address needed: claimed
 * when `entry` (as `resolve` returns it) is undefined, else bought at its
 * price. Its pointers stay until its new owner changes them. For
 * `writeRequestURI`, not `send`.
 */
export function acquire(handle, entry) {
  checkedHandle(handle);
  if (entry && entry.price === undefined) throw new Error(`@${handle} is not for sale`);
  if (!entry) return write([change(nameKey(handle), undefined, ACCOUNT), change(namesKey(ACCOUNT, handle), undefined, "1")]);
  return write(
    [change(nameKey(handle), entry.value, ACCOUNT), change(namesKey(entry.owner, handle), "1", undefined), change(namesKey(ACCOUNT, handle), undefined, "1")],
    paymentFor(entry),
  );
}

/** Gives `handle` up, with every pointer it has; anyone may claim it next. */
export async function release(state, account, handle) {
  const entry = await ownName(state, account, handle);
  return write([
    change(nameKey(handle), entry.value, undefined),
    change(namesKey(account, handle), "1", undefined),
    ...(await pointing(state, handle, null)),
  ]);
}

/** Sets `account`'s field, or removes it when undefined. */
export async function setField(state, account, field, value) {
  if (field === "") throw new Error("(empty): not a field name");
  const key = fieldKey(account, field);
  const oldValue = await state.get(key);
  if (value === oldValue) return write([]);
  return write([change(key, oldValue, value)]);
}
