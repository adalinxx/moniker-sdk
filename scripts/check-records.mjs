// src/records/ is a copy of the Moniker repo's client/ code. This fails when
// they differ: `MONIKER=<moniker checkout> npm run check-records`.
import { readFileSync } from "node:fs";

const moniker = process.env.MONIKER ?? new URL("../../moniker/", import.meta.url).pathname;
let differ = 0;
for (const file of ["profile.mjs", "state.mjs", "wallet.mjs"]) {
  const ours = readFileSync(new URL(`../src/records/${file}`, import.meta.url), "utf8");
  const theirs = readFileSync(`${moniker}/client/${file}`, "utf8");
  if (ours !== theirs) {
    console.error(`src/records/${file} differs from ${moniker}/client/${file}`);
    differ++;
  }
}
if (differ) process.exit(1);
console.log("src/records/ matches the Moniker client");
