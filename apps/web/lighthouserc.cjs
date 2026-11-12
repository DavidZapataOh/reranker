// LHCI only loads CommonJS or JSON; the config lives in TypeScript next to the routes it audits.
const { budgets, lighthouseConfig } = require("./lighthouse.ts");

module.exports = { ...lighthouseConfig(process.env), budgets };
