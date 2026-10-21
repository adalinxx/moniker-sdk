# moniker-sdk

Moniker profiles and names for any Lattice dApp. [Moniker](https://github.com/adalinxx/moniker)
is the one profile chain every Lattice app shares:

- An **account** is a key. It is never shown, only checked.
- A **profile** is the public identity: a card (name, bio, photo, links). An
  account owns profiles; a profile can be sold or given whole, card and names
  with it, and moved to a new key if one is lost.
- A **name** (`@alice`) is held by a profile, which shows one of its names.
  Names are sold or given on their own.

A record your app writes says which profile it is from, and your app shows
that profile. One import, no key handling: reads come from Moniker's nodes and
are checked by CID; writes go to the person's Lattice Wallet, which shows and
signs them.

## Install

Import a release, never a branch: code your users run should change only when
you choose to upgrade. A tag through jsDelivr's GitHub mirror is fixed
(`@v0.2.0`; a commit hash pins harder still):

```js
import { createMoniker, defineMonikerName } from "https://cdn.jsdelivr.net/gh/adalinxx/moniker-sdk@v0.2.0/src/browser.mjs";
```

Or with npm, from the tag: `npm install github:adalinxx/moniker-sdk#v0.2.0`,
then `import { createMoniker } from "moniker-sdk/browser"`. Vendoring a copy
of `src/` and `vendor/` works too; review upgrades like any dependency.

## Use

```js
const moniker = createMoniker();                    // testnet trial by default; or { nodes, chain }
const p = await moniker.profile(id);                // { id, owner, handle?, name?, description?, avatar?, url?, links? }
const people = await moniker.profiles(ids);         // a feed's bylines, in order, from one read
const q = await moniker.profileOf("@alice");        // the profile holding a name, or undefined
const mine = await moniker.profilesOf(address);     // an account's profiles
img.src = await moniker.photo(p.avatar);            // an object URL, or null
moniker.label(p);                                   // name, else @handle, else the end of the profile id
moniker.pageURL(`@${p.handle}`);                    // its Moniker page (or by id, which survives renames)

const wallet = window.lattice;                      // the Lattice Wallet extension
const { id } = await moniker.createProfile({ card: { name: "Alice" }, handle: "alice" }, { wallet });
await moniker.save(id, { links: [{ label: "Site", url: "https://alice.example" }] }, { wallet });
await moniker.claim("@alice_art", id, { wallet });  // another name for the same profile
await moniker.setAdmin(id, otherAccount, true, { wallet }); // may post as the profile in apps
// names: sell, unlist, offer, move, buy, release · profiles: sellProfile, takeProfile

defineMonikerName(moniker);                         // <moniker-name profile="…" size="24"></moniker-name>
```

Writes are free on the testnet trial: its nodes admit transactions with no
fee, so a new account needs no coins to make a profile or claim a name. Pass
`createMoniker({ fee })` for nodes that want one.

`save` keeps card fields it does not know and retries when another app saved
the card first. Keep your app's own per-account data in fields named
`app.<your app>.*` (`setField`).

A gift is an offer: `offer("@alice", profileId)` lets that profile's owner
take the name for nothing, and `sellProfile(id, { offer: address })` does the
same for a whole profile. Nothing is put on someone's profile or account
without their signature.

`<moniker-name>` shows a profile's photo, name and `@handle`, linked to its page
(`plain` drops the link); restyle it with `--moniker-ink`, `--moniker-muted`,
`--moniker-accent` and `--moniker-avatar`. See [`demo.html`](demo.html), live at
https://adalinxx.github.io/moniker-sdk/demo.html.

In Node or with your own copy of the Lattice SDK, import `moniker-sdk` (that
is, `src/index.mjs`) and pass it: `createMoniker({ sdk })`.

## Layout

- `src/index.mjs`: `createMoniker` and the address and handle checks.
- `src/browser.mjs`: the same, bound to the vendored Lattice SDK.
- `src/element.mjs`: `<moniker-name>`.
- `src/records/`: reading and writing Moniker's records: `profile.mjs`
  (profiles, cards, names, admins, account fields), `state.mjs` (reads state by descending the trie, checked
  by CID), `wallet.mjs` (the request the Lattice Wallet signs). The one copy:
  the Moniker app and its tests use these through a submodule.
- `vendor/lattice-sdk.js`: the Lattice SDK, bundled for browsers.

## Test

```
npm test
```

The Moniker repo holds this one as the submodule `sdk/`: its policy tests check
`src/records/` against the chain's policy, and its e2e runs the whole library
against a real node. To try a change here there, check it out in `sdk/`.
