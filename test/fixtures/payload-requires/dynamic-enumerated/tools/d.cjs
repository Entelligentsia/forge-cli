"use strict";
// A dynamic require(variable) site that IS enumerated via an injected
// DYNAMIC_SITES allowlist in the test; its declared target exists below.
const modName = "./target.cjs";
const m = require(modName);
module.exports = { m };
