"use strict";
// A dynamic require(variable) site NOT in the DYNAMIC_SITES allowlist.
// Iron Law 5: this must be a hard failure (no silent skip).
const modName = "./whatever.cjs";
const m = require(modName);
module.exports = { m };
