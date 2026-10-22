// Chains in memory that admit a transaction the way consensus would, under
// the real built policies: Moniker's at $MONIKER_WASM and an app's (Rave's)
// at $APP_WASM. Build them first:
//
//   (cd ~/src/moniker-follows/policy && cargo build --release --target wasm32-unknown-unknown)
//   (cd ~/src/rave/policy && cargo build --release --target wasm32-unknown-unknown)
//   LATTICE_SDK=~/src/lattice-sdk/packages/sdk/dist/index.js npm test
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { monikerClient, profilesClient } from "../src/client.mjs";
import { transaction } from "../src/records/wallet.mjs";

const home = homedir();
export const sdk = await import(process.env.LATTICE_SDK ?? `${home}/src/lattice-sdk/packages/sdk/dist/index.js`);
const moniker = new WebAssembly.Module(readFileSync(process.env.MONIKER_WASM ?? `${home}/src/moniker-follows/policy/target/wasm32-unknown-unknown/release/moniker_policy.wasm`));
const app = new WebAssembly.Module(readFileSync(process.env.APP_WASM ?? `${home}/src/rave/policy/target/wasm32-unknown-unknown/release/rave_policy.wasm`));

export const MONIKER_PATH = ["Nexus", "testnet", "moniker"];
export const APP_PATH = ["Nexus", "testnet", "rave"];

export const address = (seed) => sdk.addressFromPublicKey(sdk.publicKeyFromPrivate(new Uint8Array(32).fill(seed)));

const u32 = (value) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
};
const u64 = (value) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value));
  return bytes;
};
// The spec as policies read it: DAG-CBOR {"targetBlockTime": 2000}.
const SPEC = Uint8Array.of(0xa1, 0x6f, ...new TextEncoder().encode("targetBlockTime"), 0x19, 0x07, 0xd0);

/** Whether `module` accepts `body` on `path` in a block at `timestamp`, as the Lattice host runs it. */
function admits(module, body, path, timestamp) {
  const text = new TextEncoder();
  const { bytes } = sdk.encodeTransactionBody(body);
  const parts = [
    text.encode("LWPCTX"),
    Uint8Array.of(0, 2, 0, 1, 0), // encoding version, ABI version, transaction scope
    u64(100), // height
    u64(timestamp),
    u32(SPEC.length),
    SPEC,
    u32(path.length),
    ...path.flatMap((segment) => [u32(text.encode(segment).length), text.encode(segment)]),
    Uint8Array.of(1),
    u32(bytes.length),
    bytes,
    Uint8Array.of(0, 0), // no action, no action index
  ];
  const context = Uint8Array.from(parts.flatMap((part) => [...part]));
  const { exports } = new WebAssembly.Instance(module);
  const pointer = exports.lattice_alloc(context.length);
  new Uint8Array(exports.memory.buffer).set(context, pointer);
  return exports.lattice_validate_transaction(pointer, context.length) === 1;
}

/**
 * A chain in memory: each key changes once per transaction, every action's
 * old value must be what the key holds, no account action is zero, the
 * policy must accept the body, and no balance may go below zero.
 */
function chain(module, path, balances) {
  const map = new Map();
  const coins = new Map(Object.entries(balances).map(([who, amount]) => [who, BigInt(amount)]));
  const state = {
    get: async (key) => map.get(key),
    async *list(prefix) {
      for (const key of [...map.keys()].sort()) if (key.startsWith(prefix)) yield [key, map.get(key)];
    },
  };
  let nonce = 0n;
  /** `owner` signs `{ actions, payments }`; true when it landed. */
  function submit(owner, { actions, payments = [] }, fee = 1n) {
    const body = transaction({ owner, actions, payments, fee, nonce: nonce++, chainPath: path });
    if (actions.length === 0) return false;
    if (new Set(actions.map((a) => a.key)).size !== actions.length) return false;
    for (const { key, oldValue } of actions) if (map.get(key) !== oldValue) return false;
    if (body.accountActions.some(({ delta }) => delta === 0n)) return false;
    if (!admits(module, body, path, Date.now())) return false;
    const after = new Map(coins);
    for (const { owner: who, delta } of body.accountActions) after.set(who, (after.get(who) ?? 0n) + delta);
    if ([...after.values()].some((amount) => amount < 0n)) return false;
    for (const [who, amount] of after) coins.set(who, amount);
    for (const { key, newValue } of actions) {
      if (newValue === undefined) map.delete(key);
      else map.set(key, newValue);
    }
    return true;
  }
  const link = { chain: path, nodes: [], fee: 1n, state: async () => state, photo: async () => null };
  return { path, state, submit, map, coins, link };
}

/**
 * Moniker and one app chain, with their clients, and `wallet(who)`: a wallet
 * for account `who` that sends each request to the chain it names.
 */
export function world(balances = {}) {
  const names = chain(moniker, MONIKER_PATH, balances);
  const apps = chain(app, APP_PATH, balances);
  const monikerAPI = monikerClient(names.link, { app: "https://moniker.test/" });
  const profilesAPI = profilesClient(apps.link, monikerAPI);
  const wallet = (who) => ({
    address: async () => who,
    writeRecords: async ({ chainPath, actions, payments = [], fee }) => {
      const to = [names, apps].find((c) => c.path.join("/") === chainPath.join("/"));
      const landed = to.submit(who, { actions, payments: payments.map(({ to, amount }) => ({ to, amount: BigInt(amount) })) }, BigInt(fee));
      if (!landed) throw new Error(`refused on ${chainPath.join("/")}`);
      return { transactionCID: "bafytest" };
    },
  });
  return { names, apps, moniker: monikerAPI, profiles: profilesAPI, wallet };
}
