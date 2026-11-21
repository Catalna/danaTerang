import { readFile } from "node:fs/promises";
import { Common, Hardfork, Mainnet } from "@ethereumjs/common";
import { createLegacyTx } from "@ethereumjs/tx";
import { createAccount, createAddressFromPrivateKey, createAddressFromString, hexToBytes } from "@ethereumjs/util";
import { createVM, runTx } from "@ethereumjs/vm";
import { Interface, Wallet, hexlify } from "ethers";

/** Actual contract execution in a local EVM, with ethers-shaped adapters. */
export async function createLocalChain() {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Prague });
  const vm = await createVM({ common });
  const relayer = Wallet.createRandom();
  const key = hexToBytes(relayer.privateKey);
  const from = createAddressFromPrivateKey(key);
  await vm.stateManager.putAccount(from, createAccount({ balance: 10n ** 22n }));
  const receipts = new Map();
  let blockNumber = 0;

  async function send(to, data) {
    const account = await vm.stateManager.getAccount(from);
    const tx = createLegacyTx({
      nonce: account.nonce, gasLimit: 15_000_000n, gasPrice: 1_000_000_000n,
      ...(to ? { to: createAddressFromString(to) } : {}), data: hexToBytes(data),
    }, { common }).sign(key);
    const result = await runTx(vm, { tx });
    if (result.receipt.status !== 1) throw new Error(`Local EVM reverted: ${result.execResult.exceptionError?.error ?? hexlify(result.execResult.returnValue)}`);
    const hash = hexlify(tx.hash());
    const receipt = {
      hash, status: 1, blockNumber: ++blockNumber,
      logs: result.receipt.logs.map(([address, topics, bytes]) => ({ address: hexlify(address), topics: topics.map(hexlify), data: hexlify(bytes) })),
    };
    receipts.set(hash, receipt);
    return { hash, address: result.createdAddress?.toString(), async wait() { return receipt; } };
  }

  async function deploy(artifactName, argumentsForConstructor) {
    const artifact = JSON.parse(await readFile(new URL(`../../packages/review-contract/src/${artifactName}`, import.meta.url), "utf8"));
    const iface = new Interface(artifact.abi);
    const deployment = await send(null, artifact.bytecode + iface.encodeDeploy(argumentsForConstructor).slice(2));
    const address = deployment.address;
    const contract = {
      target: address, interface: iface,
      runner: { provider: { async getTransactionReceipt(hash) { return receipts.get(hash) ?? null; } } },
      filters: {
        ProofAnchored: (proofId) => iface.encodeFilterTopics("ProofAnchored", [proofId]),
        VoteSubmitted: (...args) => iface.encodeFilterTopics("VoteSubmitted", args),
      },
      async queryFilter(topics) {
        return [...receipts.values()].flatMap((receipt) => receipt.logs
          .filter((log) => log.address === address && topics.every((topic, index) => topic === null || log.topics[index] === topic))
          .map((log) => ({ ...iface.parseLog(log), transactionHash: receipt.hash, blockNumber: receipt.blockNumber })));
      },
    };
    iface.forEachFunction((fragment) => {
      contract[fragment.name] = async (...args) => {
        const data = iface.encodeFunctionData(fragment, args);
        if (!["view", "pure"].includes(fragment.stateMutability)) return send(address, data);
        const result = await vm.evm.runCall({
          to: createAddressFromString(address), caller: from, origin: from,
          data: hexToBytes(data), gasLimit: 15_000_000n,
        });
        if (result.execResult.exceptionError) throw result.execResult.exceptionError;
        const decoded = iface.decodeFunctionResult(fragment, hexlify(result.execResult.returnValue));
        return fragment.outputs.length === 1 ? decoded[0] : decoded;
      };
    });
    return contract;
  }
  return { relayer, chainId: Number(common.chainId()), deploy };
}
