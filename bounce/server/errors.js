/**
 * Errors that are safe to show a client.
 *
 * Lives in its own module because both `providers.js` and `ollama.js` need it,
 * and `providers.js` also needs to construct an ollama provider — a static
 * import in each direction would be a cycle, and a dynamic import would make
 * `createProviderFromEnv` async, which then has to be awaited at every call site
 * in the proxy, the tests and three scripts. One small module is cheaper than
 * either.
 */
export class ProviderError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderError';
  }
}
