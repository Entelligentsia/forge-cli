"use strict";
// Static relative require to a sibling that exists (extension elided).
const b = require("./b");
// Static relative require with explicit extension.
const lib = require("./lib/util.cjs");
// Bare specifier — external, must be ignored by the walker.
const fs = require("node:fs");
// A `require(` token inside a comment must NOT be treated as a site: require(ghost)
module.exports = { b, lib, fs };
