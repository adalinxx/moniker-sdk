// Profiles an app defines on its own chain, as the rules crate's `profiles`
// module checks them, read from a state view `{ get(key), list(prefix) }`
// (see state.mjs) and written as `{ actions, payments? }` for the wallet (see
// wallet.mjs). Nothing here depends on which app chain.
//
// An account owns profiles, the public identities an app shows, and sells or
// gives them whole. A record the app writes is keyed by the profile it is
// from, and written by its owner.
//
// Keys:
//   profile/<p>                <owner>, <owner>@<price> or <owner>><account> (offered to it); never deleted
//   owns/<a>/<p>               1 while <a> owns <p>
//   about/<p>/card             JSON { name, description, avatar, header, url, links }
//   about/<p>/name             the handle the profile shows, while the name on Moniker points back here
//   about/<p>/<field>          the app's other fields
//
// A transaction acting for a profile writes `profile/<p>`, unchanged if
// nothing moves, which proves its owner, who signs. Then come the profile's
// records, while it
// is the last profile written: `about/<p>/...`, and the app's records keyed
// by it (`user/<p>/...`, `index/.../<p>`). `proof` gives those first actions.
import { change, checkedTerms, combine, heldToken, isHandle, isProfileId, newProfileId, paymentFor, takeable, tokenValue, unchanged, write } from "./shared.mjs";

/** The card's text fields every app shows. A card may carry others; they are kept. */
export const CARD_FIELDS = ["name", "description", "avatar", "header", "url"];

export const profileKey = (p) => `profile/${p}`;
export const ownsKey = (account, p) => `owns/${account}/${p}`;
export const cardKey = (p) => `about/${p}/card`;
export const shownKey = (p) => `about/${p}/name`;

/** Whether `url` is a web address a client may link to: http or https only. */
export function isWebURL(url) {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** The card's `links`, in the owner's order, as `[{ label, url }]`: entries that are not a label and a web address are left out. */
const readLinks = (links) =>
  Array.isArray(links)
    ? links
        .filter((link) => typeof link?.label === "string" && link.label !== "" && typeof link.url === "string" && isWebURL(link.url))
        .map(({ label, url }) => ({ label, url }))
    : [];

const parseObject = (value) => {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

// Reading.

/** Profile `p` as held: `{ id, value, owner, price?, offer? }`, or undefined when there is none. */
export async function profileToken(state, p) {
  if (!isProfileId(p)) return undefined;
  const token = await heldToken(state, profileKey(p));
  return token && { id: p, ...token };
}

/**
 * Profile `p`: `{ id, owner, price?, offer?, name?, description?, avatar?,
 * header?, url?, links?, shown? }`, where `shown` is the handle it names
 * (`about/<p>/name`), not yet checked against Moniker; undefined when there
 * is no profile `p`.
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
  if (typeof shown === "string" && shown !== "") profile.shown = shown;
  return profile;
}

/** Profiles for many ids at once, in order, for a feed; an unknown id gives `{ id }`. */
export const getProfiles = (state, ids) => Promise.all(ids.map(async (p) => (await getProfile(state, p)) ?? { id: p }));

/**
 * `profile` with `handle` set to its shown handle when `pointer`, the profile
 * id that handle points at on this chain (names.mjs `pointer`), is this
 * profile: a profile shows `@h` only while it names h and h points back.
 */
export const withHandle = (profile, pointer) => (profile.shown !== undefined && pointer === profile.id ? { ...profile, handle: profile.shown } : profile);

/** A card name for display, without leading `@`s, which only a verified handle shows; undefined when empty. */
export const displayName = (p) => p.name?.replace(/^@+/, "") || undefined;

/**
 * What to show for a profile: its card name with its verified handle beside
 * it ("Dana Okafor @dana"), else the handle, else the end of its id.
 */
export function label(p) {
  const name = displayName(p);
  const handle = p.handle ? `@${p.handle}` : undefined;
  return name && handle ? `${name} ${handle}` : (name ?? handle ?? `Profile …${p.id.slice(-6)}`);
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

/** Whether `account` may act as profile `p` now: its owner. */
export async function actsFor(state, account, p) {
  return (await profileToken(state, p))?.owner === account;
}

// Writing.

/**
 * The actions that must come before records `account` writes as profile `p`:
 * the profile rewritten unchanged. Throws unless `account` owns `p`.
 */
export async function proof(state, p, account) {
  const token = await owned(state, account, p);
  return [unchanged(profileKey(p), token.value)];
}

/** `write`, as profile `p`, by `account`: the proof first, then the write. */
export async function writeAs(state, account, p, w) {
  return combine(write(await proof(state, p, account)), w);
}

/** Profile `p`, which `account` must own. */
async function owned(state, account, p) {
  const token = await profileToken(state, p);
  if (token?.owner !== account) throw new Error("That profile isn't yours");
  return token;
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

function checkedLinks(links) {
  if (!Array.isArray(links)) throw new Error("links: a list of { label, url }");
  return links.map(({ label, url }) => {
    if (typeof label !== "string" || label === "") throw new Error("links: every link needs a label");
    if (!isWebURL(url)) throw new Error(`links: ${url} is not an http or https address`);
    return { label, url };
  });
}

/**
 * A new profile owned by `account`, with `card` if given: `{ id, write }`.
 * The id is random; if it was taken meanwhile, consensus refuses the write
 * and the client asks again.
 */
export async function createProfile(state, account, { card } = {}) {
  let id = newProfileId();
  while (await state.get(profileKey(id))) id = newProfileId();
  return {
    id,
    write: write([
      change(profileKey(id), undefined, account),
      change(ownsKey(account, id), undefined, "1"),
      ...(card ? [change(cardKey(id), undefined, JSON.stringify(checkedCard({}, card)))] : []),
    ]),
  };
}

/**
 * A change to profile `p`'s card by `account`, its owner: each of
 * `changes` sets a field, or removes it when undefined, null, "" or an empty
 * `links`. Text fields are strings; `links` is `[{ label, url }]` with web
 * addresses. Fields the client does not know are kept. An empty card is
 * deleted. Nothing to write when nothing changes.
 */
export async function editCard(state, account, p, changes) {
  const before = await proof(state, p, account);
  const oldValue = await state.get(cardKey(p));
  const card = checkedCard({ ...(parseObject(oldValue) ?? {}) }, changes);
  const newValue = Object.keys(card).length > 0 ? JSON.stringify(card) : undefined;
  if (newValue === oldValue) return write([]);
  return write([...before, change(cardKey(p), oldValue, newValue)]);
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

/**
 * Profile `p` names `handle` as the one it shows, or none when undefined. It
 * is shown only while the handle on Moniker points back at `p`.
 */
export async function setShown(state, account, p, handle) {
  if (handle !== undefined && !isHandle(handle)) throw new Error(`${handle}: a handle is lowercase letters, digits and _`);
  const before = await proof(state, p, account);
  const old = await state.get(shownKey(p));
  if (old === handle) return write([]);
  return write([...before, change(shownKey(p), old, handle)]);
}

/** Profile `p`, which `account` owns, set for sale at `price`, offered to account `offer`, or kept (neither). */
export async function setProfileTerms(state, account, p, terms = {}) {
  checkedTerms(terms);
  const token = await owned(state, account, p);
  return write([change(profileKey(p), token.value, tokenValue(account, terms))]);
}

/**
 * `account` takes profile `p`, with its card and records: bought at its
 * price, paid to its owner, or taken as offered to `account`. The handle it
 * showed was the last owner's, so it is cleared.
 */
export async function takeProfile(state, account, p) {
  const token = await profileToken(state, p);
  if (!token) throw new Error("No such profile");
  takeable(token, account, "That profile");
  const shown = await state.get(shownKey(p));
  return write(
    [
      change(profileKey(p), token.value, account),
      change(ownsKey(token.owner, p), "1", undefined),
      change(ownsKey(account, p), undefined, "1"),
      ...(shown !== undefined ? [change(shownKey(p), shown, undefined)] : []),
    ],
    paymentFor(token),
  );
}
