import { memoryAccountStore } from '@sibei/api';
import { accountStoreConformance } from '../store/conformance.js';

/**
 * The in-memory account store against the same contract as the real adapters (V20). It is what the
 * fast-layer OAuth and authenticator tests run against, so it has to be held to the port, not trusted.
 */
accountStoreConformance('memory', async ({ now }) => {
  const accounts = memoryAccountStore({ now });
  return { accounts, close: () => accounts.close() };
});
