# moniker-sdk

Moniker profiles and handles for any Lattice dApp. [Moniker](https://github.com/adalinxx/moniker)
is the one profile chain every Lattice app shares: a card per account (name,
bio, photo, links) and sellable `@handles`.

One import, no key handling: reads come from Moniker's nodes and are checked by
CID; writes go to the person's Lattice Wallet, which shows and signs them.

## Install

Import a release, never a branch: code your users run should change only when
you choose to upgrade. A tag through jsDelivr's GitHub mirror is fixed
(`@v0.1.0`; a commit hash pins harder still):

```js
import { createMoniker, defineMonikerName } from "https://cdn.jsdelivr.net/gh/adalinxx/moniker-sdk@v0.1.0/src/browser.mjs";
```

Or with npm, from the tag: `npm install github:adalinxx/moniker-sdk#v0.1.0`,
then `import { createMoniker } from "moniker-sdk/browser"`. Vendoring a copy
of `src/` and `vendor/` works too; review upgrades like any dependency.

## Use

```js
const moniker = createMoniker();                 // testnet trial by default; or { nodes, chain }
const p = await moniker.profile(address);        // { address, name?, description?, avatar?, url?, handle?, links? }
const people = await moniker.profiles(authors);  // a feed's bylines, in order, from one read
const who = await moniker.resolve("@alice");     // the holder's address, or undefined
img.src = await moniker.photo(p.avatar);         // an object URL, or null
moniker.label(p);                                // name, else @handle, else a short address
moniker.pageURL(address);                        // their Moniker page

const wallet = window.lattice;                   // the Lattice Wallet extension
await moniker.save({ name: "Alice", links: [{ label: "Site", url: "https://alice.example" }] }, { wallet });
await moniker.setField("app.myapp.theme", "dark", { wallet });
await moniker.claim("alice", { wallet });        // also sell, unlist, buy, give, release

defineMonikerName(moniker);                      // <moniker-name address="bafyrei…" size="24"></moniker-name>
```

`save` keeps card fields it does not know and retries when another app saved
the card first. Store your app's own data in fields named `app.<your app>.*`.

`<moniker-name>` shows the photo, name and `@handle`, linked to the page
(`plain` drops the link); restyle it with `--moniker-ink`, `--moniker-muted`,
`--moniker-accent` and `--moniker-avatar`. See [`demo.html`](demo.html), live at
https://adalinxx.github.io/moniker-sdk/demo.html.

In Node or with your own copy of the Lattice SDK, import `moniker-sdk` (that
is, `src/index.mjs`) and pass it: `createMoniker({ sdk })`.

## Layout

- `src/index.mjs`: `createMoniker` and the address and handle checks.
- `src/browser.mjs`: the same, bound to the vendored Lattice SDK.
- `src/element.mjs`: `<moniker-name>`.
- `src/records/`: reading and writing Moniker's records: `profile.mjs` (cards,
  fields, handles), `state.mjs` (reads state by descending the trie, checked
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
