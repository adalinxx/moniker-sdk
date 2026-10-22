// Moniker for other apps. An account is a key; it owns profiles, the public
// identity apps show (a card: name, photo, words, links), and @names, which
// it may sell and point at any profile. A profile shows a default name while
// that name points at it. A record an app writes says which profile it is from.
//
//   const moniker = createMoniker({ sdk });             // sdk: the Lattice SDK module
//   const p = await moniker.profile(id);                 // { id, owner, handle?, name?, avatar?, … }
//   const ps = await moniker.profiles([a, b, c]);         // for a feed, in order
//   const q = await moniker.profileOf("@alice");          // the profile a name points at, or undefined
//   const mine = await moniker.profilesOf(address);       // an account's profiles
//   img.src = await moniker.photo(p.avatar);              // an object URL, or null
//   await moniker.save(p.id, { name: "Alice" }, { wallet: window.lattice });
//
// Reads go to the first of `nodes` that answers and are checked by CID, so
// they do not depend on trusting that node. Writes go to the wallet, which
// shows them to the person and signs; this library never holds a key.
import * as profileRecords from "./records/profile.mjs";
import { anyHost, tip, view, volumeLoader } from "./records/state.mjs";
import { writeRequest, writeRequestURI } from "./records/wallet.mjs";

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

// Raster images only: an SVG is a document that can run script.
const PHOTO_TYPES = /^image\/(png|jpeg|gif|webp|avif)$/;

export function createMoniker(options) {
  const { sdk, chain, nodes, app, fee, freshFor } = { ...DEFAULTS, ...options };
  if (!sdk) throw new Error("createMoniker needs { sdk }: the Lattice SDK module");
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

  /** The wallet request for a write, sent; resolves when the wallet has sent it. */
  const needWallet = (wallet) => {
    if (!wallet?.writeRecords) throw new Error("This needs the Lattice Wallet extension (window.lattice).");
    return wallet;
  };
  const send = (wallet) => (write) => needWallet(wallet).writeRecords(writeRequest(chain, write, fee));
  const me = async (wallet) => (await needWallet(wallet).address?.()) ?? (await wallet.connect());
  const bare = (handle) => String(handle).replace(/^@/, "");
  const fresh = () => state({ fresh: true });

  return {
    chain,
    nodes,
    state,

    // ---- reading

    /** Profile `id`: `{ id, owner, price?, offer?, handle?, name?, description?, avatar?, header?, url?, links? }`, or undefined. */
    profile: async (id) => profileRecords.getProfile(await state(), id),
    /** Profiles for many ids, in order, from one state; an unknown id gives `{ id }`. */
    profiles: async (ids) => profileRecords.getProfiles(await state(), ids),
    /** The profile `@handle` (with or without the @) points at, or undefined. */
    profileOf: async (handle) => profileRecords.profileOf(await state(), bare(handle)),
    /** The id of the profile `@handle` points at, or undefined. */
    resolve: async (handle) => (await profileRecords.resolve(await state(), bare(handle)))?.profile,
    /** A name as held: `{ handle, owner, price?, offer?, profile? }`, or undefined when free. */
    name: async (handle) => profileRecords.resolve(await state(), bare(handle)),
    /** The profiles an account owns. */
    profilesOf: async (address) => profileRecords.profilesOf(await state(), address),
    /** The names an account owns: `[{ handle, owner, price?, offer?, profile? }]`. */
    names: async (address) => profileRecords.namesOf(await state(), address),
    /** The accounts a profile names as admins. */
    admins: async (id) => profileRecords.adminsOf(await state(), id),
    /** Whether an account may act as a profile now: its owner or an admin. */
    actsFor: async (address, id) => profileRecords.actsFor(await state(), address, id),
    /** A field an account keeps outside its profiles, such as `key.x25519` or `app.<name>.<field>`. */
    field: async (address, name) => profileRecords.getField(await state(), address, name),
    /** Names for sale, cheapest first: `[{ handle, owner, price, profile? }]`. */
    forSale: async () => profileRecords.forSale(await state()),
    photo,
    /** A link to a profile's Moniker page: by `@handle`, or by profile id, which survives renames. */
    pageURL: (who) => `${app}#/${encodeURIComponent(who)}`,
    /** What to show in a byline: the card's name, else its @handle, else the end of its id. */
    label: (p) => p.name ?? (p.handle ? `@${p.handle}` : `Profile …${p.id.slice(-6)}`),

    // ---- writing, through the person's wallet, as the connected account

    /** Makes a profile, with a `card`, and a `handle` (free, or yours) as its default name; resolves to `{ id, sent }`. */
    createProfile: async ({ card, handle } = {}, { wallet }) => {
      const { id, write } = await profileRecords.createProfile(await fresh(), await me(wallet), { card, handle: handle && bare(handle) });
      return { id, sent: await send(wallet)(write) };
    },
    /**
     * Changes a profile's card: each key of `changes` sets a field (`name`,
     * `description`, `avatar`, `header`, `url`, `links`, or one of your own)
     * or removes it when undefined, null or "". Fields this library does not
     * know are kept. Retried if another app saved the card meanwhile.
     * Resolves to the wallet's answer, or undefined when nothing changed.
     */
    save: async (id, changes, { wallet }) => profileRecords.saveCard(fresh, await me(wallet), id, changes, send(wallet)),
    /** The profile shows `@handle` as its default name: one that points at it. */
    showName: async (id, handle, { wallet }) => send(wallet)(await profileRecords.showName(await fresh(), await me(wallet), id, bare(handle))),
    /** Makes an account an admin of the profile, or stops (`on` false). */
    setAdmin: async (id, address, on, { wallet }) => send(wallet)(await profileRecords.setAdmin(await fresh(), await me(wallet), id, address, on)),
    /** Sets a field outside the profiles for the connected account, or removes it with undefined. */
    setField: async (name, value, { wallet }) => send(wallet)(await profileRecords.setField(await fresh(), await me(wallet), name, value)),
    /** Claims a free `@handle`, pointed at profile `point` if given. */
    claim: async (handle, { point } = {}, { wallet }) => send(wallet)(await profileRecords.claim(await fresh(), await me(wallet), bare(handle), { point })),
    /** Points a name of yours at any profile, or nowhere (undefined). */
    point: async (handle, id, { wallet }) => send(wallet)(await profileRecords.pointName(await fresh(), await me(wallet), bare(handle), id)),
    /** Puts a name up for sale: anyone may then buy it at `price` at once. */
    sell: async (handle, price, { wallet }) => send(wallet)(await profileRecords.list(await fresh(), await me(wallet), bare(handle), BigInt(price))),
    /** Takes a name off sale, or back from an offer. */
    unlist: async (handle, { wallet }) => send(wallet)(await profileRecords.unlist(await fresh(), await me(wallet), bare(handle))),
    /** Offers a name to another account, which may take it for nothing. */
    offer: async (handle, address, { wallet }) => send(wallet)(await profileRecords.offerName(await fresh(), await me(wallet), bare(handle), address)),
    /**
     * A lattice://write request that claims `@handle`, or buys it at the
     * price the chain holds now, for whichever account signs it: no wallet
     * or address needed here. Hand it to `window.lattice.openRequest` from a
     * click, or show it as a QR code or text. The new owner points it later.
     */
    buyRequest: async (handle) => {
      const name = bare(handle);
      const entry = await profileRecords.resolve(await fresh(), name);
      // Wallets show at most 64 characters of a label: a longer one goes unlabeled.
      const label = `Buy @${name}`.length <= 64 ? `Buy @${name}` : undefined;
      return writeRequestURI(chain, profileRecords.acquire(name, entry), { fee, label });
    },
    /** Buys a name at the price the chain holds, or takes it as offered; pointed at profile `point` if given. */
    buy: async (handle, { point } = {}, { wallet }) => send(wallet)(await profileRecords.buy(await fresh(), await me(wallet), bare(handle), { point })),
    /** Gives a name up; anyone may claim it next. */
    release: async (handle, { wallet }) => send(wallet)(await profileRecords.release(await fresh(), await me(wallet), bare(handle))),
    /** Sets a profile's terms: for sale at `price`, offered to account `offer`, or kept (neither). */
    sellProfile: async (id, terms, { wallet }) => send(wallet)(await profileRecords.setProfileTerms(await fresh(), await me(wallet), id, terms)),
    /** Takes a profile, with its card and followers (names stay with their owners): bought at its price, or as offered to you. */
    takeProfile: async (id, { wallet }) => send(wallet)(await profileRecords.takeProfile(await fresh(), await me(wallet), id)),
  };
}

export const { isAddress, isHandle, isProfileId, isWebURL } = profileRecords;
