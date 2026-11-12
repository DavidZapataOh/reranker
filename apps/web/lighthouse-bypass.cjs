// LHCI requires collect.puppeteerScript as a CommonJS module exporting the function.
module.exports = require("./lighthouse.ts").setBypassCookie;
