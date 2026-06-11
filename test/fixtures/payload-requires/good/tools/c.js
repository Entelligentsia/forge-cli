"use strict";
// A .js consumer must be walked too (review advisory): static require into a sibling.
const a = require("./a.cjs");
module.exports = { a };
