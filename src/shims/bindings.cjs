// Vercel bundle shim for the `bindings` package. bigint-buffer (inside the Squads SDK) tries to load a
// native addon through it and crashes in the serverless runtime instead of falling back. Throwing here
// makes bigint-buffer take its pure-JS path, exactly as it does locally when the addon is missing.
module.exports = function bindings() {
  throw new Error('native bindings disabled in the serverless bundle');
};
