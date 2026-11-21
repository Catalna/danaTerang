import assert from "node:assert/strict";
import test from "node:test";
import { createRelayerSigner } from "../../src/blockchain/relayer.js";

test("concurrent review and proof sends are serialized and receive distinct nonces", async () => {
  const nonces = [];
  let active = 0;
  const signer = createRelayerSigner({
    address: `0x${"a".repeat(40)}`,
    provider: { async getTransactionCount() { return 7; } },
    async sendTransaction(transaction) {
      assert.equal(active++, 0);
      await new Promise((resolve) => setTimeout(resolve, 5));
      nonces.push(transaction.nonce);
      active -= 1;
      return { hash: transaction.data };
    },
  });
  const results = await Promise.all(["review", "vote", "proof"].map((data) => signer.sendTransaction({ data })));
  assert.deepEqual(nonces, [7, 8, 9]);
  assert.deepEqual(results.map((result) => result.hash), ["review", "vote", "proof"]);
});

test("an RPC submission failure releases the queue and refreshes the pending nonce", async () => {
  let pending = 0;
  let failure = true;
  const signer = createRelayerSigner({
    address: `0x${"a".repeat(40)}`,
    provider: { async getTransactionCount() { return pending; } },
    async sendTransaction(transaction) {
      if (failure) { failure = false; pending = 1; throw new Error("RPC disconnected after broadcast"); }
      return { nonce: transaction.nonce };
    },
  });
  await assert.rejects(signer.sendTransaction({}));
  assert.equal((await signer.sendTransaction({})).nonce, 1);
});
