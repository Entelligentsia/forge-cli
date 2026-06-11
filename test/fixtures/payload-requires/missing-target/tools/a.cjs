"use strict";
// Static relative require whose target is absent from the bundle.
const gone = require("./nope.cjs");
module.exports = { gone };
