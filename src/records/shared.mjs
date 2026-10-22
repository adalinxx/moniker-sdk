// What names on Moniker and profiles on app chains share: the checks the
// policies make, token values, and writes as `{ actions, payments }` for the
// wallet (see wallet.mjs).
//
// A token is a key an account holds: `<owner>`, `<owner>@<price>` (for anyone,
// at that price) or `<owner>><account>` (offered to that account for
// nothing). The policies see only a transaction, so a write acting for a
// token rewrites it to the value it has: consensus checks that value, and the
// policy reads the owner from it. Every value read is parsed as untrusted:
// what does not parse is left out, never fatal.

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

/** Whether `text` is an account address in its one canonical spelling, as the policies check it. */
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

/** A chain path as Moniker keys it: segments of letters, digits, `-` and `_`, joined by `/`. */
export function chainPath(chain) {
  const path = Array.isArray(chain) ? chain.join("/") : chain;
  if (typeof path !== "string" || !path.split("/").every((segment) => /^[A-Za-z0-9_-]+$/.test(segment))) {
    throw new Error(`not a chain path: ${chain}`);
  }
  return path;
}

/**
 * Stands for the signer in a lattice://write request (wallet.mjs
 * `writeRequestURI`): the wallet fills in the account the person chooses.
 */
export const ACCOUNT = "{account}";

/**
 * A token value as the policy reads it: `{ holder, price?, offer? }`, with
 * `holder` and any `offer` addresses; undefined when it does not parse.
 */
export function readToken(value) {
  if (typeof value !== "string") return undefined;
  const at = value.search(/[@>]/);
  if (at < 0) return isAddress(value) ? { holder: value } : undefined;
  const holder = value.slice(0, at);
  const rest = value.slice(at + 1);
  if (!isAddress(holder)) return undefined;
  if (value[at] === ">") return isAddress(rest) && rest !== holder ? { holder, offer: rest } : undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(rest) || BigInt(rest) >= 2n ** 63n) return undefined;
  return { holder, price: BigInt(rest) };
}

/** Token `key` as held: `{ value, owner, price?, offer? }`, or undefined. */
export async function heldToken(state, key) {
  const value = await state.get(key);
  const token = readToken(value);
  return token && { value, owner: token.holder, ...(token.price !== undefined && { price: token.price }), ...(token.offer && { offer: token.offer }) };
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

/** A token's terms checked: an offer goes to an address. */
export function checkedTerms(terms = {}) {
  if (terms.offer !== undefined && !isAddress(terms.offer)) throw new Error(`not an address: ${terms.offer}`);
  return terms;
}

/** What a taker pays for a token: its price, if not 0. */
export const paymentFor = (token) => (token.price > 0n ? [{ to: token.owner, amount: token.price }] : []);

/** Whether `account` may take `token`: it is for sale, or offered to `account`. */
export function takeable(token, account, what) {
  if (token.owner === account) throw new Error(`${what} is already yours`);
  if (token.price === undefined && token.offer !== account) throw new Error(`${what} is not for sale`);
}

// Writing. Each change names the value the writer read as the old one, so if
// the key changed since, consensus refuses it: nothing is overwritten unseen,
// and nobody pays a price they did not see.

export const write = (actions, payments = []) => ({ actions, payments });

/** One key's change from what was read to `newValue` (undefined deletes it). */
export const change = (key, oldValue, newValue) => ({ key, ...(oldValue !== undefined && { oldValue }), ...(newValue !== undefined && { newValue }) });

/** A key rewritten to the value it has: shows the policy who holds it. */
export const unchanged = (key, value) => ({ key, oldValue: value, newValue: value });

/**
 * One write of several, as one transaction. Each key is written once, where
 * it first comes (the policies read the actions in order): a key rewritten
 * unchanged, to show its value, gives way to a real change of the same key.
 * Two real changes of one key are an error, and so are purchases from one
 * seller split by another's: the policy pays each seller's run of purchases
 * from one credit, and the wallet credits each seller once.
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
  const payments = writes.flatMap((w) => w.payments ?? []);
  const sellers = payments.map((p) => p.to).filter((to, i, all) => to !== all[i - 1]);
  if (new Set(sellers).size !== sellers.length) throw new Error("purchases from one seller must come together");
  return write(kept, payments);
}
