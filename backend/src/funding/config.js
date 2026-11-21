import { getAddress } from "ethers";

function configurationError() {
  return Object.assign(new Error("Invalid campaign-funding configuration"), { code: "INVALID_CAMPAIGN_FUNDING_CONFIGURATION" });
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Same staged semantics as peer review: no registry address means the funding
// feature is disabled (activation then reports funding_disabled); provided-but-
// broken settings fail loudly at startup.
export function readCampaignRegistryConfig(env = process.env) {
  const contractValue = nonEmpty(env.CAMPAIGN_REGISTRY_ADDRESS);
  if (contractValue === null) return null;

  const rpcUrl = nonEmpty(env.BLOCKCHAIN_RPC_URL);
  const relayerPrivateKey = nonEmpty(env.BLOCKCHAIN_PRIVATE_KEY);
  if (!rpcUrl || !relayerPrivateKey) throw configurationError();

  let contractAddress;
  let parsedUrl;
  try {
    contractAddress = getAddress(contractValue);
    parsedUrl = new URL(rpcUrl);
  } catch {
    throw configurationError();
  }
  if (!new Set(["http:", "https:"]).has(parsedUrl.protocol) || !parsedUrl.hostname
      || !/^0x[0-9a-fA-F]{64}$/.test(relayerPrivateKey)) {
    throw configurationError();
  }

  const chainId = Number(env.BLOCKCHAIN_CHAIN_ID ?? "11155111");
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw configurationError();
  return Object.freeze({ contractAddress, rpcUrl, relayerPrivateKey, chainId });
}
