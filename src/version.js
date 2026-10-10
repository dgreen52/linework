// The app version: the ONE place a release bump changes. It is a plain script so both the
// service worker (importScripts, classic) and the ES modules (config.js imports it) can read it;
// the service worker names its offline cache after it, so bumping it also refreshes the cache.
globalThis.LINEWORK_VERSION = '0.3.1';
