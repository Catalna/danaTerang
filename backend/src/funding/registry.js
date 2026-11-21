import { readFileSync } from "node:fs";
import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers";

const REGISTRY_ARTIFACT_URL = new URL("../../../packages/review-contract/src/campaign-registry-abi.json", import.meta.url);
const REGISTRY_ABI = JSON.parse(readFileSync(REGISTRY_ARTIFACT_URL, "utf8")).abi;

function chainError(code) {
  return Object.assign(new Error(code), { code });
}

export async function createCampaignRegistryChain(config, {
  providerFactory = (url, chainId) => new JsonRpcProvider(url, chainId),
  walletFactory = null,
} = {}) {
  // walletFactory is injected by server.js so the relayer wallet is shared with
  // the peer-review/proof chains (one nonce queue, one gas payer).
  let provider;
  try {
    provider = providerFactory(config.rpcUrl, config.chainId);
    const network = await provider.getNetwork();
    if (BigInt(network.chainId) !== BigInt(config.chainId)) throw chainError("CAMPAIGN_REGISTRY_CHAIN_ID_MISMATCH");
    const bytecode = await provider.getCode(config.contractAddress);
    if (typeof bytecode !== "string" || !/^0x[0-9a-f]+$/i.test(bytecode) || /^0x0+$/i.test(bytecode)) {
      throw chainError("CAMPAIGN_REGISTRY_NOT_DEPLOYED");
    }
    const contractAddress = config.contractAddress;
    const wallet = walletFactory ? walletFactory(config.relayerPrivateKey, provider) : new Wallet(config.relayerPrivateKey, provider);
    const contract = new Contract(config.contractAddress, REGISTRY_ABI, wallet);

    let closed = false;
    return Object.freeze({
      provider,
      wallet,
      contract,
      contractAddress,
      relayerAddress: getAddress(wallet.address),
      async close() {
        if (closed) return;
        closed = true;
        await provider.destroy?.();
      },
    });
  } catch (error) {
    try { await provider?.destroy?.(); } catch { /* Preserve the original connection error. */ }
    if (["CAMPAIGN_REGISTRY_CHAIN_ID_MISMATCH", "CAMPAIGN_REGISTRY_NOT_DEPLOYED"].includes(error?.code)) {
      throw error;
    }
    throw chainError("CAMPAIGN_REGISTRY_CONNECTION_FAILED");
  }
}
