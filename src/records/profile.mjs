// Accounts, profiles and names on Moniker, the profile chain, read from a
// state view `{ get(key), list(prefix) }` (see state.mjs) and written as
// `{ actions, payments? }` for the wallet (see wallet.mjs).
//
// An account is a key. It owns profiles: the public identity apps show, with
// a card, and the thing a record says it is from. A profile holds names
// (@handles), and shows one of them.
//
// Keys:
//   profile/<p>            <owner>, <owner>@<price> or <owner>><account> (offered to it)
//   about/<p>/card         JSON { name, description, avatar, header, url, links }
//   about/<p>/name         the handle the profile shows, one it holds
//   about/<p>/admin/<a>    1 while account <a> may act as the profile elsewhere
//   name/<handle>          <p>, <p>@<price> or <p>><profile> (offered to it)
//   owns/<a>/<p>           1 while <a> owns <p>
//   holds/<p>/<handle>     1 while <p> holds <handle>
//   user/<a>/<field>       the account's own: key.x25519, app.<name>.<field>
//
// The policy sees only a transaction, so a write acting for profile <p>
// rewrites profile/<p> to the value it has: consensus checks that value, and
// the policy reads the owner from it. A profile's records sit apart, under
// about/<p>/, so no write updates a key and adds a key under it. Records are written by anyone the policy
// lets through, so every value is parsed as untrusted: what does not parse is
// left out, never fatal.

/** The CID of the profile policy module built from `policy/`. */
export const MONIKER_POLICY = "bafyreiedacmfpkjdebxm6t7farcj6s5lrb7wn777ix4a5akjtn7lzxf5qm";

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

export const profileKey = (p) => `profile/${p}`;
export const cardKey = (p) => `about/${p}/card`;
export const shownKey = (p) => `about/${p}/name`;
export const adminKey = (p, account) => `about/${p}/admin/${account}`;
export const nameKey = (handle) => `name/${handle}`;
export const ownsKey = (account, p) => `owns/${account}/${p}`;
export const holdsKey = (p, handle) => `holds/${p}/${handle}`;
export const fieldKey = (account, field) => `user/${account}/${field}`;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Whether `handle` is one the policy accepts: lowercase letters, digits and `_`. */
export const isHandle = (handle) => typeof handle === "string" && /^[a-z0-9_]+$/.test(handle);

/** Whether `text` is a profile id: 16 characters of `a`–`z` and `2`–`7`. */
export const isProfileId = (text) => typeof text === "string" && /^[a-z2-7]{16}$/.test(text);

/** A new random profile id; a taken one is refused by consensus, and the client picks again. */
export function newProfileId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => BASE32[byte % 32]).join("");
}

/**
 * Whether `text` is an account address in its one canonical spelling, as the
 * policy checks a profile's owner.
 */
export function isAddress(text) {
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

/**
 * A token value as the policy reads it: `{ holder, price?, offer? }`, with
 * `holder` and any `offer` passing `valid`; undefined when it does not parse.
 */
export function readToken(value, valid) {
  if (typeof value !== "string") return undefined;
  const at = value.search(/[@>]/);
  if (at < 0) return valid(value) ? { holder: value } : undefined;
  const holder = value.slice(0, at);
  const rest = value.slice(at + 1);
  if (!valid(holder)) return undefined;
  if (value[at] === ">") return valid(rest) && rest !== holder ? { holder, offer: rest } : undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(rest) || BigInt(rest) >= 2n ** 63n) return undefined;
  return { holder, price: BigInt(rest) };
}

/** A token value: its holder, with a price for anyone or an offer to one taker, or neither. */
export function tokenValue(holder, { price, offer } = {}) {
  if (price !== undefined) {
    // A credit pays at most 2^63 - 1.
    if (typeof price !== "bigint" || price < 0n || price >= 2n ** 63n) throw new Error(`bad price: ${price}`);
    return `${holder}@${price}`;
  }
  if (offer === holder) throw new Error("an offer goes to someone else");
  return offer === undefined ? holder : `${holder}>${offer}`;
}

// Reading.

/** Profile `p` as held: `{ id, value, owner, price?, offer? }`, or undefined when there is none. */
export async function profileToken(state, p) {
  if (!isProfileId(p)) return undefined;
  const value = await state.get(profileKey(p));
  const token = readToken(value, isAddress);
  return token && { id: p, value, owner: token.holder, ...(token.price !== undefined && { price: token.price }), ...(token.offer && { offer: token.offer }) };
}

/**
 * Profile `p`: `{ id, owner, price?, offer?, handle?, name?, description?,
 * avatar?, header?, url?, links? }`, where `handle` is the name it shows,
 * kept only while it holds it; undefined when there is no profile `p`.
 */
export async function getProfile(state, p) {
  const token = await profileToken(state, p);
  if (!token) return undefined;
  const { value, ...profile } = token;
  const card = parseObject(await state.get(cardKey(p))) ?? {};
  for (const field of CARD_FIELDS) if (typeof card[field] === "string" && card[field] !== "") profile[field] = card[field];
  if (profile.url !== undefined && !isWebURL(profile.url)) delete profile.url;
  const links = readLinks(card.links);
  if (links.length > 0) profile.links = links;
  const shown = await state.get(shownKey(p));
  if ((await resolve(state, shown))?.profile === p) profile.handle = shown;
  return profile;
}

/** Profiles for many ids at once, in order, for a feed; an unknown id gives `{ id }`. */
export const getProfiles = (state, ids) => Promise.all(ids.map(async (p) => (await getProfile(state, p)) ?? { id: p }));

/** The name as held: `{ handle, value, profile, price?, offer? }`, or undefined when free. */
export async function resolve(state, handle) {
  if (!isHandle(handle)) return undefined;
  const value = await state.get(nameKey(handle));
  const token = readToken(value, isProfileId);
  return token && { handle, value, profile: token.holder, ...(token.price !== undefined && { price: token.price }), ...(token.offer && { offer: token.offer }) };
}

/** The profile holding `handle`, as `getProfile` returns it, or undefined when the name is free. */
export async function profileOf(state, handle) {
  const entry = await resolve(state, handle);
  return entry && getProfile(state, entry.profile);
}

/** The profiles `account` owns: one prefix read of `owns/`. */
export async function profilesOf(state, account) {
  const prefix = `owns/${account}/`;
  const found = [];
  for await (const [key] of state.list(prefix)) {
    const profile = await getProfile(state, key.slice(prefix.length));
    if (profile?.owner === account) found.push(profile);
  }
  return found;
}

/** The names profile `p` holds, as `resolve` returns them, in handle order: one prefix read of `holds/`. */
export async function namesOf(state, p) {
  const prefix = `holds/${p}/`;
  const found = [];
  for await (const [key] of state.list(prefix)) {
    const entry = await resolve(state, key.slice(prefix.length));
    if (entry?.profile === p) found.push(entry);
  }
  return found;
}

/** The accounts profile `p` names as its admins. */
export async function adminsOf(state, p) {
  const prefix = `about/${p}/admin/`;
  const found = [];
  for await (const [key, value] of state.list(prefix)) {
    const account = key.slice(prefix.length);
    if (value === "1" && isAddress(account)) found.push(account);
  }
  return found;
}

/** Whether `account` may act as profile `p` now: its owner or one of its admins. */
export async function actsFor(state, account, p) {
  const token = await profileToken(state, p);
  return token !== undefined && (token.owner === account || (await state.get(adminKey(p, account))) === "1");
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

/** `account`'s fields outside its profiles, as `{ field: value }`. */
export async function getFields(state, account) {
  const prefix = `user/${account}/`;
  const fields = {};
  for await (const [key, value] of state.list(prefix)) fields[key.slice(prefix.length)] = value;
  return fields;
}

export const getField = (state, account, field) => state.get(fieldKey(account, field));

// Writing. Each change names the value the writer read as the old one, so if
// the key changed since, consensus refuses it: nothing is overwritten unseen,
// and nobody pays a price they did not see.

const write = (actions, payments = []) => ({ actions, payments });

/** One key's change from what was read to `newValue` (undefined deletes it). */
const change = (key, oldValue, newValue) => ({ key, ...(oldValue !== undefined && { oldValue }), ...(newValue !== undefined && { newValue }) });

/** A key rewritten to the value it has: shows the policy who holds it. */
const unchanged = (key, value) => ({ key, oldValue: value, newValue: value });

/**
 * One write of several, as one transaction. Each key is written once, where
 * it first comes (the policy reads the actions in order): a key rewritten
 * unchanged, to show its value, gives way to a real change of the same key.
 * Two real changes of one key are an error.
 */
export function combine(...writes) {
  const at = new Map();
  const kept = [];
  for (const action of writes.flatMap((w) => w.actions)) {
    const shows = action.oldValue !== undefined && action.oldValue === action.newValue;
    const index = at.get(action.key);
    if (index === undefined) {
      at.set(action.key, kept.push(action) - 1);
    } else if (!shows) {
      const first = kept[index];
      if (first.oldValue === undefined || first.oldValue !== first.newValue) throw new Error(`${action.key} is changed twice`);
      kept[index] = action;
    }
  }
  return write(kept, writes.flatMap((w) => w.payments ?? []));
}

/** Profile `p`, which `account` must own. */
async function owned(state, account, p) {
  const token = await profileToken(state, p);
  if (token?.owner !== account) throw new Error("That profile isn't yours");
  return token;
}

/**
 * A new profile owned by `account`, with `card` and the free name `handle`
 * if given: `{ id, write }`. The id is random; if it was taken meanwhile,
 * consensus refuses the write and the client asks again.
 */
export async function createProfile(state, account, { card, handle } = {}) {
  let id = newProfileId();
  while (await state.get(profileKey(id))) id = newProfileId();
  const parts = [write([change(profileKey(id), undefined, account), change(ownsKey(account, id), undefined, "1")])];
  if (card) parts.push(write([change(cardKey(id), undefined, JSON.stringify(checkedCard({}, card)))]));
  if (handle !== undefined) parts.push(await claimFor(state, id, handle, undefined, true));
  return { id, write: combine(...parts) };
}

function checkedCard(card, changes) {
  for (const [field, value] of Object.entries(changes)) {
    if (value === undefined || value === null || value === "" || (field === "links" && value.length === 0)) delete card[field];
    else if (field === "links") card.links = checkedLinks(value);
    else if (typeof value === "string") card[field] = value;
    else throw new Error(`${field}: card fields are strings`);
  }
  return card;
}

/**
 * A change to profile `p`'s card by `account`, its owner: each of `changes`
 * sets a field, or removes it when undefined, null, "" or an empty `links`.
 * Text fields are strings; `links` is `[{ label, url }]` with web addresses.
 * Fields the client does not know are kept. An empty card is deleted.
 * Nothing to write when nothing changes.
 */
export async function editCard(state, account, p, changes) {
  const token = await owned(state, account, p);
  const oldValue = await state.get(cardKey(p));
  const card = checkedCard({ ...(parseObject(oldValue) ?? {}) }, changes);
  const newValue = Object.keys(card).length > 0 ? JSON.stringify(card) : undefined;
  if (newValue === oldValue) return write([]);
  return write([unchanged(profileKey(p), token.value), change(cardKey(p), oldValue, newValue)]);
}

function checkedLinks(links) {
  if (!Array.isArray(links)) throw new Error("links: a list of { label, url }");
  return links.map(({ label, url }) => {
    if (typeof label !== "string" || label === "") throw new Error("links: every link needs a label");
    if (!isWebURL(url)) throw new Error(`links: ${url} is not an http or https address`);
    return { label, url };
  });
}

/**
 * Edits the card and sends it with `send(write)`. If the send fails because
 * the card changed meanwhile (another app saved first), reads again and
 * retries; any other failure is thrown.
 */
export async function saveCard(readState, account, p, changes, send, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    const state = await readState();
    const edit = await editCard(state, account, p, changes);
    if (edit.actions.length === 0) return undefined;
    try {
      return await send(edit);
    } catch (error) {
      const read = edit.actions.find((a) => a.key === cardKey(p))?.oldValue;
      const now = await (await readState()).get(cardKey(p));
      if (attempt >= attempts || now === read) throw error;
    }
  }
}

/** Profile `p` shows `handle`, a name it holds. */
export async function showName(state, account, p, handle) {
  const token = await owned(state, account, p);
  const entry = await resolve(state, handle);
  if (entry?.profile !== p) throw new Error(`@${handle} isn't on this profile`);
  return write([unchanged(profileKey(p), token.value), unchanged(nameKey(handle), entry.value), change(shownKey(p), await state.get(shownKey(p)), handle)]);
}

/** Sets or clears (`on` false) `admin` as an admin of profile `p`. */
export async function setAdmin(state, account, p, admin, on = true) {
  const token = await owned(state, account, p);
  if (!isAddress(admin)) throw new Error(`not an address: ${admin}`);
  const old = await state.get(adminKey(p, admin));
  const next = on ? "1" : undefined;
  if (old === next) return write([]);
  return write([unchanged(profileKey(p), token.value), change(adminKey(p, admin), old, next)]);
}

/** `handle` put on profile `p`, which it shows if it shows none yet; `fresh` when `p` is being created. */
async function claimFor(state, p, handle, price, fresh = false) {
  if (!isHandle(handle)) throw new Error(`${handle}: a handle is lowercase letters, digits and _`);
  if ((await state.get(nameKey(handle))) !== undefined) throw new Error(`@${handle} is taken`);
  const shows = fresh ? undefined : await state.get(shownKey(p));
  const showing = (await resolve(state, shows))?.profile === p;
  return write([
    change(nameKey(handle), undefined, tokenValue(p, { price })),
    change(holdsKey(p, handle), undefined, "1"),
    ...(showing ? [] : [change(shownKey(p), shows, handle)]),
  ]);
}

/** `account` claims the free `handle` for its profile `p`, for sale at `price` or not. */
export async function claim(state, account, p, handle, price) {
  const token = await owned(state, account, p);
  return combine(write([unchanged(profileKey(p), token.value)]), await claimFor(state, p, handle, price));
}

/** The name `handle`, which a profile of `account` holds: `[entry, its profile]`. */
async function ownName(state, account, handle) {
  const entry = await resolve(state, handle);
  if (!entry) throw new Error(`No one holds @${handle}`);
  return [entry, await owned(state, account, entry.profile)];
}

/** Puts `handle` up for sale at `price`. Anyone may then buy it at that price. */
export async function list(state, account, handle, price) {
  if (price === undefined) throw new Error("a listing needs a price");
  const [entry, token] = await ownName(state, account, handle);
  return write([unchanged(profileKey(token.id), token.value), change(nameKey(handle), entry.value, tokenValue(entry.profile, { price }))]);
}

/** Takes `handle` off sale, or back from an offer. */
export async function unlist(state, account, handle) {
  const [entry, token] = await ownName(state, account, handle);
  return write([unchanged(profileKey(token.id), token.value), change(nameKey(handle), entry.value, entry.profile)]);
}

/** Offers `handle` to profile `to`, whose owner may then take it for nothing. */
export async function offerName(state, account, handle, to) {
  if (!isProfileId(to)) throw new Error(`not a profile: ${to}`);
  const [entry, token] = await ownName(state, account, handle);
  return write([unchanged(profileKey(token.id), token.value), change(nameKey(handle), entry.value, tokenValue(entry.profile, { offer: to }))]);
}

/**
 * `handle` moved onto profile `to`, which `account` owns: from another of its
 * profiles, bought at its price, or taken as offered. Both profiles keep
 * showing a name they hold: `to` shows it if it showed none, and the
 * profile it leaves stops showing it. `created`: `to` is new, made by
 * `createProfile` in the same transaction (see `combine`).
 */
export async function moveName(state, account, handle, to, { created = false } = {}) {
  const entry = await resolve(state, handle);
  if (!entry) throw new Error(`No one holds @${handle}`);
  if (entry.profile === to) throw new Error(`@${handle} is already on that profile`);
  const target = created ? undefined : await owned(state, account, to);
  const from = await profileToken(state, entry.profile);
  const mine = from.owner === account;
  if (!mine && entry.price === undefined && entry.offer !== to) throw new Error(`@${handle} is not for sale`);
  const toShows = created ? undefined : await state.get(shownKey(to));
  const fromShows = await state.get(shownKey(entry.profile));
  return write(
    [
      unchanged(profileKey(entry.profile), from.value),
      ...(target ? [unchanged(profileKey(to), target.value)] : []),
      change(nameKey(handle), entry.value, to),
      change(holdsKey(entry.profile, handle), "1", undefined),
      change(holdsKey(to, handle), undefined, "1"),
      ...((await resolve(state, toShows))?.profile === to ? [] : [change(shownKey(to), toShows, handle)]),
      ...(mine && fromShows === handle ? [change(shownKey(entry.profile), handle, undefined)] : []),
    ],
    !mine && entry.price > 0n ? [{ to: from.owner, amount: entry.price }] : [],
  );
}

/** `buyer` buys `handle` onto its profile `to` at the price the chain holds; the seller is paid in the same transaction. */
export const buy = (state, buyer, handle, to, options) => moveName(state, buyer, handle, to, options);

/** Gives `handle` up; anyone may claim it next. Its profile stops showing it. */
export async function release(state, account, handle) {
  const [entry, token] = await ownName(state, account, handle);
  const shows = await state.get(shownKey(entry.profile));
  return write([
    unchanged(profileKey(token.id), token.value),
    change(nameKey(handle), entry.value, undefined),
    change(holdsKey(entry.profile, handle), "1", undefined),
    ...(shows === handle ? [change(shownKey(entry.profile), handle, undefined)] : []),
  ]);
}

/** Profile `p`, which `account` owns, set for sale at `price`, offered to account `offer`, or kept (neither). */
export async function setProfileTerms(state, account, p, terms = {}) {
  if (terms.offer !== undefined && !isAddress(terms.offer)) throw new Error(`not an address: ${terms.offer}`);
  const token = await owned(state, account, p);
  return write([change(profileKey(p), token.value, tokenValue(account, terms))]);
}

/**
 * `account` takes profile `p`, with its card and names: bought at its price,
 * paid to its owner, or taken as offered to `account`.
 */
export async function takeProfile(state, account, p) {
  const token = await profileToken(state, p);
  if (!token) throw new Error("No such profile");
  if (token.owner === account) throw new Error("That profile is already yours");
  if (token.price === undefined && token.offer !== account) throw new Error("That profile is not for sale");
  // The admins were the last owner's: they go with the sale.
  const admins = await adminsOf(state, p);
  return write(
    [
      change(profileKey(p), token.value, account),
      change(ownsKey(token.owner, p), "1", undefined),
      change(ownsKey(account, p), undefined, "1"),
      ...admins.map((admin) => change(adminKey(p, admin), "1", undefined)),
    ],
    token.price > 0n ? [{ to: token.owner, amount: token.price }] : [],
  );
}

/** Sets `account`'s field outside its profiles, or removes it when undefined. */
export async function setField(state, account, field, value) {
  if (field === "") throw new Error("(empty): not a field name");
  const key = fieldKey(account, field);
  const oldValue = await state.get(key);
  if (value === oldValue) return write([]);
  return write([change(key, oldValue, value)]);
}
