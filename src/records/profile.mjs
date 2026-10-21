// Profiles and handles on Moniker, the profile chain, read from a state view
// `{ get(key), list(prefix) }` (see state.mjs) and written as
// `{ actions, payments? }` for the wallet (see wallet.mjs).
//
// A handle is what people see: it has the card. An account is a key that
// holds handles, and goes by one of them.
//
// Keys:
//   name/<handle>         <holder> or <holder>@<price>
//   holds/<a>/<handle>    1 while <a> holds <handle>, moved with it (the policy sees to it)
//   user/<a>/card/<handle> <handle>'s card while <a> holds it: JSON { name, description, avatar, header, url, links }
//   user/<a>/name         the handle <a> goes by where only the account is known
//   user/<a>/<field>      anything else: key.x25519, app.<name>.<field>
//
// A card is kept under its holder, so a handle that changes hands starts with
// an empty card, and its old holder's card for it is no longer shown.
//
// Records are written by anyone the policy lets through, so every value is
// parsed as untrusted: what does not parse is left out, never fatal.

/** The CID of the profile policy module built from `policy/`. */
export const MONIKER_POLICY = "bafyreidbabni55wvwzcq27sx6jjiirtlxrqqlzvxz4ujebjidd5tztp2li";

/** Where Moniker lives. */
export const MONIKER_CHAIN = ["Nexus", "moniker"];

/** The card's text fields every app shows. A card may carry others; they are kept. */
export const CARD_FIELDS = ["name", "description", "avatar", "header", "url"];

/** Whether `url` is a web address a client may link to: http or https only. */
export function isWebURL(url) {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * The card's `links`, in the owner's order, as `[{ label, url }]`: entries
 * that are not a label and a web address are left out.
 */
const readLinks = (links) =>
  Array.isArray(links)
    ? links
        .filter((link) => typeof link?.label === "string" && link.label !== "" && typeof link.url === "string" && isWebURL(link.url))
        .map(({ label, url }) => ({ label, url }))
    : [];

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

export const cardKey = (address, handle) => `user/${address}/card/${handle}`;
export const defaultKey = (address) => `user/${address}/name`;
export const fieldKey = (address, field) => `user/${address}/${field}`;
export const handleKey = (handle) => `name/${handle}`;
export const holdsKey = (address, handle) => `holds/${address}/${handle}`;

/** Whether `handle` is one the policy accepts: lowercase letters, digits and `_`. */
export const isHandle = (handle) => typeof handle === "string" && /^[a-z0-9_]+$/.test(handle);

/**
 * Whether `text` is an account address in its one canonical spelling, as the
 * policy checks a handle's holder.
 */
export function isAddress(text) {
  const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
  return (
    typeof text === "string" &&
    text.length === 59 &&
    text.startsWith("bafyrei") &&
    [...text.slice(7)].every((c) => BASE32.includes(c)) &&
    BASE32.indexOf(text[7]) < 8 &&
    BASE32.indexOf(text[58]) % 4 === 0
  );
}

const parseObject = (value) => {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/** The holder and price in a handle value, as the policy reads them. */
export function holding(value) {
  if (typeof value !== "string") return undefined;
  const at = value.indexOf("@");
  const holder = at < 0 ? value : value.slice(0, at);
  if (!isAddress(holder)) return undefined;
  if (at < 0) return { holder };
  const digits = value.slice(at + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(digits) || BigInt(digits) >= 2n ** 64n) return undefined;
  return { holder, price: BigInt(digits) };
}

/** A handle value: its holder, and its price when it is for sale. */
export function holdingValue(holder, price) {
  if (!isAddress(holder)) throw new Error(`not an address: ${holder}`);
  if (price === undefined) return holder;
  if (typeof price !== "bigint" || price < 0n || price >= 2n ** 64n) throw new Error(`bad price: ${price}`);
  return `${holder}@${price}`;
}

// Reading.

/**
 * `handle`'s card while it is held: `{ address, handle, name?, description?,
 * avatar?, header?, url?, links? }`, where `address` is its holder; undefined
 * when no one holds it. What does not parse is left out.
 */
export async function getCard(state, handle) {
  const entry = await resolve(state, handle);
  if (!entry) return undefined;
  const card = parseObject(await state.get(cardKey(entry.holder, handle))) ?? {};
  const shown = { address: entry.holder, handle };
  for (const field of CARD_FIELDS) if (typeof card[field] === "string" && card[field] !== "") shown[field] = card[field];
  if (shown.url !== undefined && !isWebURL(shown.url)) delete shown.url;
  const links = readLinks(card.links);
  if (links.length > 0) shown.links = links;
  return shown;
}

/**
 * The handle `address` goes by: its default while it still holds it, else
 * its only handle; undefined when it holds none, or several and no default.
 */
export async function goesBy(state, address) {
  const chosen = await state.get(defaultKey(address));
  if (isHandle(chosen) && (await resolve(state, chosen))?.holder === address) return chosen;
  const held = await heldBy(state, address);
  return held.length === 1 ? held[0].handle : undefined;
}

/**
 * What to show for an account: the card of the handle it goes by, or just
 * `{ address }`. Apps that know only who signed something show this.
 */
export async function getProfile(state, address) {
  const handle = await goesBy(state, address);
  const card = handle && (await getCard(state, handle));
  return card?.address === address ? card : { address };
}

/** Profiles for many addresses at once, in order, for a feed. */
export const getProfiles = (state, addresses) => Promise.all(addresses.map((address) => getProfile(state, address)));

/** `address`'s fields outside its cards and default, as `{ field: value }`. */
export async function getFields(state, address) {
  const prefix = `user/${address}/`;
  const fields = {};
  for await (const [key, value] of state.list(prefix)) {
    const field = key.slice(prefix.length);
    if (field !== "name" && !field.startsWith("card/")) fields[field] = value;
  }
  return fields;
}

export const getField = (state, address, field) => state.get(fieldKey(address, field));

/** The handle as held: `{ handle, value, holder, price? }`, or undefined when free. */
export async function resolve(state, handle) {
  if (!isHandle(handle)) return undefined;
  const value = await state.get(handleKey(handle));
  const held = holding(value);
  return held && { handle, value, ...held };
}

/** Every handle, as `resolve` returns it, in handle order. Reads all of `name/`. */
export async function* handles(state) {
  for await (const [key, value] of state.list("name/")) {
    const held = holding(value);
    if (held) yield { handle: key.slice("name/".length), value, ...held };
  }
}

/** The handles for sale, cheapest first. */
export async function forSale(state) {
  const found = [];
  for await (const entry of handles(state)) if (entry.price !== undefined) found.push(entry);
  return found.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : a.handle < b.handle ? -1 : 1));
}

/** The handles `address` holds, as `resolve` returns them, in handle order: one prefix read of `holds/`. */
export async function heldBy(state, address) {
  const prefix = `holds/${address}/`;
  const found = [];
  for await (const [key] of state.list(prefix)) {
    const entry = await resolve(state, key.slice(prefix.length));
    if (entry?.holder === address) found.push(entry);
  }
  return found;
}

// Writing. Each change names the value the writer read as the old one, so if
// the key changed since, consensus refuses it: nothing is overwritten unseen,
// and nobody pays a price they did not see.

const write = (actions, payments = []) => ({ actions, payments });

/** One write of several, as one transaction. */
export const combine = (...writes) =>
  write(
    writes.flatMap((w) => w.actions),
    writes.flatMap((w) => w.payments ?? []),
  );

/**
 * A change to `handle`'s card, by `address`, its holder: each of `changes`
 * sets a field, or removes it when undefined, null, "" or an empty `links`.
 * Text fields are strings; `links` is `[{ label, url }]` with web addresses.
 * Fields the client does not know are kept. An empty card is deleted.
 * Nothing to write when nothing changes.
 */
export async function editCard(state, address, handle, changes) {
  if ((await resolve(state, handle))?.holder !== address) throw new Error(`@${handle} is not yours`);
  const key = cardKey(address, handle);
  const oldValue = await state.get(key);
  const card = { ...(parseObject(oldValue) ?? {}) };
  for (const [field, value] of Object.entries(changes)) {
    if (value === undefined || value === null || value === "" || (field === "links" && value.length === 0)) delete card[field];
    else if (field === "links") card.links = checkedLinks(value);
    else if (typeof value === "string") card[field] = value;
    else throw new Error(`${field}: card fields are strings`);
  }
  const newValue = Object.keys(card).length > 0 ? JSON.stringify(card) : undefined;
  return set(key, oldValue, newValue);
}

/** One key's change from what was read to `newValue` (undefined deletes it); nothing when equal. */
const set = (key, oldValue, newValue) =>
  write(newValue === oldValue ? [] : [{ key, ...(oldValue !== undefined && { oldValue }), ...(newValue !== undefined && { newValue }) }]);

/** `address` goes by `handle`, one it holds, where only the account is known. */
export async function setDefault(state, address, handle) {
  if ((await resolve(state, handle))?.holder !== address) throw new Error(`@${handle} is not yours`);
  return set(defaultKey(address), await state.get(defaultKey(address)), handle);
}

function checkedLinks(links) {
  if (!Array.isArray(links)) throw new Error("links: a list of { label, url }");
  return links.map(({ label, url }) => {
    if (typeof label !== "string" || label === "") throw new Error("links: every link needs a label");
    if (!isWebURL(url)) throw new Error(`links: ${url} is not an http or https address`);
    return { label, url };
  });
}

/** Sets `address`'s field outside the card, or removes it when undefined. */
export async function setField(state, address, field, value) {
  if (field === "" || field === "name" || field === "card" || field.startsWith("card/")) throw new Error(`${field || "(empty)"}: not a field name`);
  const key = fieldKey(address, field);
  return set(key, await state.get(key), value);
}

/**
 * Edits the card and sends it with `send(write)`. If the send fails because
 * the card changed meanwhile (another app saved first), reads again and
 * retries; any other failure is thrown.
 */
export async function saveCard(readState, address, handle, changes, send, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    const state = await readState();
    const change = await editCard(state, address, handle, changes);
    if (change.actions.length === 0) return undefined;
    try {
      return await send(change);
    } catch (error) {
      const read = change.actions[0].oldValue;
      const now = await (await readState()).get(cardKey(address, handle));
      if (attempt >= attempts || now === read) throw error;
    }
  }
}

/**
 * `handle` moving from `from` to `to` (either may be undefined: a claim, a
 * release): its `holds/` keys, which the policy requires with the move.
 */
const moved = (handle, from, to) =>
  from === to
    ? []
    : [...(from ? [{ key: holdsKey(from, handle), oldValue: "1" }] : []), ...(to ? [{ key: holdsKey(to, handle), newValue: "1" }] : [])];

/** `to`'s default becomes `handle` if it has none it still holds. */
async function defaultIfNone(state, to, handle) {
  const chosen = await state.get(defaultKey(to));
  if (isHandle(chosen) && chosen !== handle && (await resolve(state, chosen))?.holder === to) return [];
  return set(defaultKey(to), chosen, handle).actions;
}

/** `from`'s card for `handle`, and its default if it was `handle`, removed as `handle` leaves. */
async function leaving(state, from, handle) {
  const card = await state.get(cardKey(from, handle));
  const chosen = await state.get(defaultKey(from));
  return [...(card !== undefined ? [{ key: cardKey(from, handle), oldValue: card }] : []), ...(chosen === handle ? [{ key: defaultKey(from), oldValue: chosen }] : [])];
}

/** `address` claims the free `handle`, for sale at `price` or not; it becomes the default if there is none. */
export async function claim(state, address, handle, price) {
  if (!isHandle(handle)) throw new Error(`${handle}: a handle is lowercase letters, digits and _`);
  if ((await state.get(handleKey(handle))) !== undefined) throw new Error(`@${handle} is taken`);
  return write([
    { key: handleKey(handle), newValue: holdingValue(address, price) },
    ...moved(handle, undefined, address),
    ...(await defaultIfNone(state, address, handle)),
  ]);
}

/** The holder's change of `entry` (as `resolve` returns it) to the same holder, for sale at `price` or not. */
const reprice = (entry, price) =>
  write([{ key: handleKey(entry.handle), oldValue: entry.value, newValue: holdingValue(entry.holder, price) }]);

/** The holder puts `entry` up for sale at `price`. Anyone may then take it at that price. */
export const list = (entry, price) => {
  if (price === undefined) throw new Error("a listing needs a price");
  return reprice(entry, price);
};

/** The holder takes `entry` off sale. */
export const unlist = (entry) => reprice(entry);

/**
 * The holder gives `entry` to `to`, not for sale, taking down their card for
 * it. `to` makes it their default themselves: nobody writes another's records.
 */
export async function transfer(state, entry, to) {
  if (!isAddress(to)) throw new Error(`not an address: ${to}`);
  if (to === entry.holder) throw new Error(`@${entry.handle} is already theirs`);
  return write([
    { key: handleKey(entry.handle), oldValue: entry.value, newValue: holdingValue(to) },
    ...moved(entry.handle, entry.holder, to),
    ...(await leaving(state, entry.holder, entry.handle)),
  ]);
}

/** The holder gives `entry` up, taking down their card for it; anyone may claim it next. */
export async function release(state, entry) {
  return write([
    { key: handleKey(entry.handle), oldValue: entry.value },
    ...moved(entry.handle, entry.holder, undefined),
    ...(await leaving(state, entry.holder, entry.handle)),
  ]);
}

/**
 * `buyer` takes `entry` at its price; it becomes their default if they have
 * none. The seller's card for it stays theirs, unshown.
 */
export async function buy(state, entry, buyer) {
  if (entry.price === undefined) throw new Error(`@${entry.handle} is not for sale`);
  if (entry.holder === buyer) throw new Error(`@${entry.handle} is already yours`);
  return write(
    [
      { key: handleKey(entry.handle), oldValue: entry.value, newValue: holdingValue(buyer) },
      ...moved(entry.handle, entry.holder, buyer),
      ...(await defaultIfNone(state, buyer, entry.handle)),
    ],
    [{ to: entry.holder, amount: entry.price }],
  );
}
