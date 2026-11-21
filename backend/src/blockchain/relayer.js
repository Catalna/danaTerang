import { AbstractSigner, FetchRequest, JsonRpcProvider } from "ethers";

export function createRpcProvider(url, chainId) {
  const request = new FetchRequest(url);
  request.timeout = 10_000;
  // Pending nonce reads must not reuse ethers' short-lived RPC cache.
  return new JsonRpcProvider(request, chainId, { cacheTimeout: -1 });
}

/** One instance is shared by review and proof contracts in the API process. */
export function createRelayerSigner(wallet) {
  let tail = Promise.resolve();
  let nextNonce = null;
  class RelayerSigner extends AbstractSigner {
    constructor() { super(wallet.provider); }
    get address() { return wallet.address; }
    getAddress() { return wallet.getAddress(); }
    signTransaction(transaction) { return wallet.signTransaction(transaction); }
    signMessage(message) { return wallet.signMessage(message); }
    signTypedData(domain, types, value) { return wallet.signTypedData(domain, types, value); }
    connect(provider) { return createRelayerSigner(wallet.connect(provider)); }
    sendTransaction(transaction) {
      const submitted = tail.then(async () => {
        const pendingNonce = await wallet.provider.getTransactionCount(wallet.address, "pending");
        const nonce = transaction.nonce ?? Math.max(pendingNonce, nextNonce ?? pendingNonce);
        const result = await wallet.sendTransaction({ ...transaction, nonce });
        nextNonce = Math.max(nextNonce ?? 0, nonce + 1);
        return result;
      });
      tail = submitted.catch(() => {});
      return submitted;
    }
  }
  return new RelayerSigner();
}
