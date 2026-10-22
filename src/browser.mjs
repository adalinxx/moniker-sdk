// Moniker and app profiles in a browser page, with the Lattice SDK included:
//
//   import { createMoniker, createProfiles, defineMonikerName } from "https://cdn.jsdelivr.net/gh/adalinxx/moniker-sdk@v0.2.0/src/browser.mjs";
//   const moniker = createMoniker();                                  // or createMoniker({ nodes, chain })
//   const people = createProfiles({ chain: ["Nexus", "testnet", "rave"], moniker });
//   defineMonikerName(people);                                        // then <moniker-name profile="…">
import * as sdk from "../vendor/lattice-sdk.js";
import { createMoniker as monikerOver, createProfiles as profilesOver } from "./index.mjs";

export { ACCOUNT, combine, DEFAULTS, isAddress, isHandle, isProfileId, isWebURL, MONIKER_POLICY } from "./index.mjs";
export { defineMonikerName } from "./element.mjs";
export const createMoniker = (options = {}) => monikerOver({ sdk, ...options });
export const createProfiles = (options = {}) => profilesOver({ sdk, ...options });
