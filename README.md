# moniker-sdk

Names and profiles for any Lattice dApp.

- An **account** is a key. It is never shown, only checked.
- A **name** (`@alice`) lives on [Moniker](https://github.com/adalinxx/moniker),
  the names chain every app shares. An account owns it like a domain: sells
  it, gives it, and points it at one profile on each app chain.
- A **profile** lives on the app's own chain: the identity that app shows (a
  card: name, bio, photo, links), owned by an account, sold or given whole.
  Everything the app writes is written as a profile and keyed by it.

One import, no key handling: reads come from the chains' nodes and are
checked by CID; writes go to the person's Lattice Wallet, which shows and
signs them.

## Install

Import a release, never a branch: code your users run should change only when
you choose to upgrade. A tag through jsDelivr's GitHub mirror is fixed
(`@v0.2.0`; a commit hash pins harder still):

```js
import { createMoniker, createProfiles, defineMonikerName } from "https://cdn.jsdelivr.net/gh/adalinxx/moniker-sdk@v0.2.0/src/browser.mjs";
```

Or with npm, from the tag: `npm install github:adalinxx/moniker-sdk#v0.2.0`,
then `import { createMoniker, createProfiles } from "moniker-sdk/browser"`.
Vendoring a copy of `src/` and `vendor/` works too; review upgrades like any
dependency.

In Node or with your own copy of the Lattice SDK, import `moniker-sdk` (that
is, `src/index.mjs`) and pass it: `createMoniker({ sdk })`, `createProfiles({ sdk, … })`.

## Names, on Moniker

```js
const moniker = createMoniker();                          // testnet trial by default; or { nodes, chain, fee }
const wallet = window.lattice;                            // the Lattice Wallet extension
const RAVE = "Nexus/testnet/rave-186079";                 // an app chain's full path

await moniker.name("@alice");      // { handle, owner, price?, offer?, points: { [chain]: profile id } }, or undefined
await moniker.pointer("@alice", RAVE);                   // the profile id it points at there
await moniker.names(address);                            // an account's names
await moniker.forSale();                                 // cheapest first

await moniker.claim("@alice", { point: { chain: RAVE, profile: id } }, { wallet });
await moniker.point("@alice", RAVE, otherId, { wallet }); // or null: nowhere on that chain
await moniker.sell("@alice", 500n, { wallet });           // unlist, offer(handle, account)
await moniker.buy("@alice", { point: { chain: RAVE, profile: id } }, { wallet });
await moniker.release("@alice", { wallet });              // with every pointer it has
```

A sale moves only the name: its pointers stay until the new owner changes
them (`buy` with `point`, or `point: null` to clear them all). `field` and
`setField` keep an account's own values, such as `key.x25519` or
`app.<your app>.<field>`.

A name can be bought with no address, by any wallet, as a `lattice://write`
request: the wallet fills in the account the person chooses.

```js
const uri = await moniker.buyRequest("rae");     // lattice://write?v=1&intent=…, valid 15 minutes
await window.lattice.openRequest(uri);           // from a click; or show `uri` as a QR code or text
```

## Profiles, on your app's chain

Your chain's policy defines profiles with the shared rules (`profiles` in
the Moniker repo's rules crate; Rave's policy is one that uses it).

```js
const people = createProfiles({ chain: ["Nexus", "testnet", "rave-186079"], moniker });

const { id } = await people.createProfile({ card: { name: "Alice" } }, { wallet });
await people.save(id, { links: [{ label: "Site", url: "https://alice.example" }] }, { wallet });
const p = await people.profile(id);              // { id, owner, price?, offer?, name?, description?, avatar?, header?, url?, links?, shown?, handle? }
const feed = await people.profiles(ids);         // bylines for a feed, in order, from one read
await people.profilesOf(address);                // an account's profiles here
img.src = await people.photo(p.avatar);          // an object URL, or null
people.label(p);                                 // name, else @handle, else the end of the id

await people.setAdmin(id, otherAccount, true, { wallet }); // may write as the profile
await people.sell(id, 700n, { wallet });         // unlist, offer(id, account), buy(id)
```

A sale moves the profile with its card and records; the admins its last
owner named stop acting for it at once.

### Showing a handle

A profile `p` on chain `C` shows `@h` only while `about/<p>/name` on `C` is
`h` **and** `points/h/C` on Moniker is `p`. Either side alone shows nothing:
anyone may name any handle on their profile, and a name's owner may point it
at any profile. Otherwise show the card's name.

```js
await people.useHandle(id, "@alice", { wallet }); // two requests: Moniker points @alice here (claiming it if free), then the profile names it
p.handle;                                         // "alice" once both agree; p.shown is what the profile names
await people.profileOf("@alice");                 // the profile @alice points at here, with namesBack: true when it shows it
await people.stopHandle(id, { wallet });
```

### Writing as a profile

Records your app writes as a profile are keyed by it (`user/<p>/...`,
`index/<topic>/<p>`), and must follow a proof that the signer acts for it:
`profile/<p>` rewritten unchanged, and for an admin their
`about/<p>/admin/<account>` too. `writeAs` puts it first and sends to your
chain:

```js
await people.writeAs(id, { actions: [{ key: `user/${id}/review/42`, newValue: JSON.stringify(review) }] }, { wallet });

// Or build it yourself, from a state view:
const actions = [...(await people.proof(await people.state({ fresh: true }), id, account)), ...mine];
```

`combine(...writes)` joins writes into one transaction the way the policies
read it: each key changes once, where it first comes, an unchanged proof
giving way to a real change of the same key; purchases from one seller come
together.

## The byline element

```js
defineMonikerName(people);                       // <moniker-name profile="…" size="24"></moniker-name>
```

`<moniker-name>` shows a profile's photo, name and `@handle`, the handle
linked to its Moniker page (`plain` drops the link); restyle it with
`--moniker-ink`, `--moniker-muted`, `--moniker-accent` and `--moniker-avatar`.
See [`demo.html`](demo.html).

Writes are free on the testnet trial: its nodes admit transactions with no
fee. Pass `fee` to either client for nodes that want one.

## Layout

- `src/index.mjs`: `createMoniker`, `createProfiles` and the checks.
- `src/browser.mjs`: the same, bound to the vendored Lattice SDK.
- `src/client.mjs`: the two clients, each over a link to one chain.
- `src/element.mjs`: `<moniker-name>`.
- `src/records/`: the records, as pure builders over a state view:
  `names.mjs` (Moniker's keys), `profiles.mjs` (an app chain's profile
  keys), `shared.mjs` (tokens, `combine`, checks), `state.mjs` (reads state
  by descending the trie, checked by CID), `wallet.mjs` (the request the
  Lattice Wallet signs).
- `vendor/lattice-sdk.js`: the Lattice SDK, bundled for browsers.

## Test

```
npm test
```

The tests run every write against the real built policies: Moniker's
(`$MONIKER_WASM`, default `~/src/moniker-follows/policy/target/…/moniker_policy.wasm`)
and an app's (`$APP_WASM`, default Rave's). Build each with
`cargo build --release --target wasm32-unknown-unknown` in its `policy/`, and
point `LATTICE_SDK` at the Lattice SDK's `packages/sdk/dist/index.js` if it is
not in `~/src/lattice-sdk`.
