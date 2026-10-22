// The clients createMoniker and createProfiles return, over a link to one
// chain: `{ chain, nodes, fee, state({ fresh }), photo(cid) }`, as `connect`
// makes it. Reads take the chain's state at a node's tip; writes go to the
// person's wallet, which shows them, signs and sends; nothing here holds a key.
import * as names from "./records/names.mjs";
import * as profiles from "./records/profiles.mjs";
import { chainPath } from "./records/shared.mjs";
import { anyHost, tip, view, volumeLoader } from "./records/state.mjs";
import { writeRequest, writeRequestURI } from "./records/wallet.mjs";

// Raster images only: an SVG is a document that can run script.
const PHOTO_TYPES = /^image\/(png|jpeg|gif|webp|avif)$/;

/** A link to `chain` through `nodes`, with the Lattice SDK module `sdk`. */
export function connect({ sdk, chain, nodes, fee, freshFor }) {
  const volumes = new sdk.VolumeClient(anyHost(nodes.map((node) => new sdk.HTTPVolumeTransport(`${node}/volumes`, { chainPath: chain }))));
  const load = volumeLoader(volumes, sdk.decodeDagCbor);

  let current = null; // { at, state: Promise }
  /** The chain's state at the tip of the first node that answers, reused for `freshFor` ms. */
  function state({ fresh = false } = {}) {
    if (!fresh && current && Date.now() - current.at < freshFor) return current.state;
    const read = (async () => {
      let failure;
      for (const node of nodes) {
        try {
          const { generalStateCID } = await tip(sdk, node, chain, volumes);
          return view(load, generalStateCID);
        } catch (error) {
          failure = error;
        }
      }
      throw new Error(`No node is serving ${chain.join("/")}`, { cause: failure });
    })();
    current = { at: Date.now(), state: read };
    read.catch(() => current?.state === read && (current = null));
    return read;
  }

  const photos = new Map();
  /** An object URL for the photo at `cid`, or null when no node serves it or it is not an image. */
  function photo(cid) {
    if (typeof cid !== "string" || cid === "") return Promise.resolve(null);
    if (!photos.has(cid)) {
      photos.set(
        cid,
        (async () => {
          const volume = await volumes.get(cid);
          const file = sdk.decodeDagCbor(volume.bytes(cid));
          if (typeof file?.type !== "string" || !PHOTO_TYPES.test(file.type) || !(file.bytes instanceof Uint8Array)) return null;
          return URL.createObjectURL(new Blob([file.bytes], { type: file.type }));
        })().catch(() => {
          photos.delete(cid);
          return null;
        }),
      );
    }
    return photos.get(cid);
  }

  return { chain, nodes, fee, state, photo };
}

const needWallet = (wallet) => {
  if (!wallet?.writeRecords) throw new Error("This needs the Lattice Wallet extension (window.lattice).");
  return wallet;
};
/** The connected account. */
const me = async (wallet) => (await needWallet(wallet).address?.()) ?? (await wallet.connect());
/** Asks the wallet to send `write` on the link's chain; undefined when there is nothing to write. */
const send = (link, wallet, w) => (w.actions.length === 0 ? undefined : needWallet(wallet).writeRecords(writeRequest(link.chain, w, link.fee)));
/** Builds a write with `build(state, account)` on a fresh state, as the connected account, and sends it. */
async function buildAndSend(link, wallet, build) {
  const account = await me(wallet);
  return send(link, wallet, await build(await link.state({ fresh: true }), account));
}
const bare = (handle) => String(handle).replace(/^@/, "");

/** The names client over a link to Moniker; `app` is the Moniker app's URL. */
export function monikerClient(link, { app }) {
  const { state } = link;
  const fresh = () => state({ fresh: true });
  const act = (wallet, build) => buildAndSend(link, wallet, build);
  return {
    chain: link.chain,
    nodes: link.nodes,
    state,

    // ---- reading

    /** A name as held: `{ handle, owner, price?, offer?, points: { [chain]: profile id } }`, or undefined when free. */
    name: async (handle) => names.resolve(await state(), bare(handle)),
    /** The names an account owns, as `name` returns them. */
    names: async (address) => names.namesOf(await state(), address),
    /** The profile id `@handle` points at on app chain `chain` (a path), or undefined. */
    pointer: async (handle, chain) => names.pointer(await state(), bare(handle), chain),
    /** Names for sale, cheapest first. */
    forSale: async () => names.forSale(await state()),
    /** A field an account keeps, such as `key.x25519` or `app.<name>.<field>`. */
    field: async (address, name) => names.getField(await state(), address, name),
    /** A link to a name's Moniker page. */
    pageURL: (who) => `${app}#/${encodeURIComponent(who)}`,

    // ---- writing, through the person's wallet, as the connected account

    /** Claims a free `@handle`, for sale at `price` if given, pointed at `point` (`{ chain, profile }`) if given. */
    claim: (handle, { price, point } = {}, { wallet }) => act(wallet, (s, a) => names.claim(s, a, bare(handle), { price: price === undefined ? undefined : BigInt(price), point })),
    /** Points a name of yours at profile `p` on app chain `chain`, or nowhere there (null). */
    point: (handle, chain, p, { wallet }) => act(wallet, (s, a) => names.pointName(s, a, bare(handle), chain, p)),
    /** Puts a name up for sale: anyone may then buy it at `price` at once. */
    sell: (handle, price, { wallet }) => act(wallet, (s, a) => names.list(s, a, bare(handle), BigInt(price))),
    /** Takes a name off sale, or back from an offer. */
    unlist: (handle, { wallet }) => act(wallet, (s, a) => names.unlist(s, a, bare(handle))),
    /** Offers a name to another account, which may take it for nothing. */
    offer: (handle, address, { wallet }) => act(wallet, (s, a) => names.offerName(s, a, bare(handle), address)),
    /**
     * Buys a name at the price the chain holds, or takes it as offered. Its
     * pointers are deleted, but the one `point` (`{ chain, profile }`) sets.
     */
    buy: (handle, { point } = {}, { wallet }) => act(wallet, (s, a) => names.buy(s, a, bare(handle), { point })),
    /** Gives a name up, with its pointers; anyone may claim it next. */
    release: (handle, { wallet }) => act(wallet, (s, a) => names.release(s, a, bare(handle))),
    /** Sets a field for the connected account, or removes it with undefined. */
    setField: (name, value, { wallet }) => act(wallet, (s, a) => names.setField(s, a, name, value)),
    /**
     * A lattice://write request that claims `@handle`, or buys it at the
     * price the chain holds now, for whichever account signs it: no wallet
     * or address needed here. Hand it to `window.lattice.openRequest` from a
     * click, or show it as a QR code or text. The name's pointers are
     * deleted; the new owner points it later. Refused here when the name is
     * held and not for sale, and by the chain when the signer already owns it.
     */
    buyRequest: async (handle) => {
      const name = bare(handle);
      const entry = await names.resolve(await fresh(), name);
      // Wallets show at most 64 characters of a label: a longer one goes unlabeled.
      const label = `Buy @${name}`.length <= 64 ? `Buy @${name}` : undefined;
      return writeRequestURI(link.chain, names.acquire(name, entry), { fee: link.fee, label });
    },
  };
}

/** The profiles client over a link to an app chain, checking handles with `moniker`. */
export function profilesClient(link, moniker) {
  const { state } = link;
  const path = chainPath(link.chain);
  const fresh = () => state({ fresh: true });
  const act = (wallet, build) => buildAndSend(link, wallet, build);

  /** Profiles `ids` from one state of each chain, with each shown handle checked against Moniker. */
  async function read(ids) {
    const [found, onMoniker] = await Promise.all([state().then((s) => profiles.getProfiles(s, ids)), moniker.state()]);
    return Promise.all(found.map(async (p) => (p.shown ? profiles.withHandle(p, await names.pointer(onMoniker, p.shown, path)) : p)));
  }

  return {
    chain: link.chain,
    nodes: link.nodes,
    state,
    moniker,

    // ---- reading

    /**
     * Profile `p`: `{ id, owner, price?, offer?, name?, description?, avatar?,
     * header?, url?, links?, shown?, handle? }`, where `shown` is the handle it
     * names and `handle` that handle once Moniker points it back here; or
     * undefined.
     */
    profile: async (p) => {
      const [found] = await read([p]);
      return found.owner ? found : undefined;
    },
    /** Profiles for many ids, in order, from one state; an unknown id gives `{ id }`. */
    profiles: read,
    /** The profiles an account owns. */
    profilesOf: async (address) => {
      const owned = await profiles.profilesOf(await state(), address);
      return read(owned.map((p) => p.id));
    },
    /** Whether an account may act as profile `p` now: its owner. */
    actsFor: async (address, p) => profiles.actsFor(await state(), address, p),
    /**
     * The profile `@handle` points at on this chain, as `profile` returns it,
     * with `namesBack`: whether it names the handle back (and so shows it);
     * undefined when the handle points nowhere here, or at no profile.
     */
    profileOf: async (handle) => {
      const h = bare(handle);
      const p = await names.pointer(await moniker.state(), h, path);
      if (!p) return undefined;
      const [found] = await read([p]);
      return found.owner ? { ...found, namesBack: found.handle === h } : undefined;
    },
    /** What to show for a profile: its card name with its verified @handle beside it, else the handle, else the end of its id. */
    label: profiles.label,
    photo: link.photo,

    // ---- writing, through the person's wallet, as the connected account

    /** Makes a profile with a `card`; resolves to `{ id, sent }`. */
    createProfile: async ({ card } = {}, { wallet }) => {
      const account = await me(wallet);
      const { id, write } = await profiles.createProfile(await fresh(), account, { card });
      return { id, sent: await send(link, wallet, write) };
    },
    /**
     * Changes a profile's card, as its owner: each key of
     * `changes` sets a field (`name`, `description`, `avatar`, `header`,
     * `url`, `links`, or one of your own) or removes it when undefined, null
     * or "". Fields this library does not know are kept. Retried if another
     * app saved the card meanwhile. Resolves to the wallet's answer, or
     * undefined when nothing changed.
     */
    save: async (p, changes, { wallet }) => profiles.saveCard(fresh, await me(wallet), p, changes, (w) => send(link, wallet, w)),
    /**
     * Shows `@handle` on profile `p`: two wallet requests, first Moniker's,
     * pointing the handle at `p` for this chain (claiming it if free), then
     * this chain's, naming the handle on the profile. Resolves to `{ moniker, app }`.
     */
    useHandle: async (p, handle, { wallet }) => {
      const h = bare(handle);
      const account = await me(wallet);
      const shown = await profiles.setShown(await fresh(), account, p, h);
      const entry = await names.resolve(await moniker.state({ fresh: true }), h);
      const pointed = entry ? await moniker.point(h, path, p, { wallet }) : await moniker.claim(h, { point: { chain: path, profile: p } }, { wallet });
      return { moniker: pointed, app: await send(link, wallet, shown) };
    },
    /** Profile `p` shows no handle. */
    stopHandle: (p, { wallet }) => act(wallet, (s, a) => profiles.setShown(s, a, p, undefined)),
    /** Puts profile `p` up for sale at `price`. */
    sell: (p, price, { wallet }) => act(wallet, (s, a) => profiles.setProfileTerms(s, a, p, { price: BigInt(price) })),
    /** Takes profile `p` off sale, or back from an offer. */
    unlist: (p, { wallet }) => act(wallet, (s, a) => profiles.setProfileTerms(s, a, p)),
    /** Offers profile `p` to another account, which may take it for nothing. */
    offer: (p, address, { wallet }) => act(wallet, (s, a) => profiles.setProfileTerms(s, a, p, { offer: address })),
    /** Takes profile `p`, with its card and records: bought at its price, or as offered to you. */
    buy: (p, { wallet }) => act(wallet, (s, a) => profiles.takeProfile(s, a, p)),
    /**
     * The actions that must come before records `account` writes as profile
     * `p` in `state`: the profile rewritten unchanged. Throws unless
     * `account` owns `p`.
     */
    proof: (s, p, account) => profiles.proof(s, p, account),
    /** Sends `write` (`{ actions, payments? }`, records keyed by `p`) as profile `p`, with the proof first. */
    writeAs: (p, w, { wallet }) => act(wallet, (s, a) => profiles.writeAs(s, a, p, w)),
  };
}
