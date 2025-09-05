// Polyfills for running tests on newer Node.js versions where util.isRegExp, etc. were removed
const util = require('util');

if (typeof util.isRegExp !== 'function') {
  util.isRegExp = function isRegExp(obj) { return obj instanceof RegExp; };
}
if (typeof util.isDate !== 'function') {
  util.isDate = function isDate(obj) { return obj instanceof Date; };
}
if (typeof util.isError !== 'function') {
  util.isError = function isError(obj) { return obj instanceof Error; };
}
