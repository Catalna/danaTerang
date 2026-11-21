import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Interface, Wallet } from "ethers";
import { Common, Hardfork, Mainnet } from "@ethereumjs/common";
import { createAddressFromPrivateKey, createAddressFromString, createAccount, hexToBytes } from "@ethereumjs/util";
import { createLegacyTx } from "@ethereumjs/tx";
import { createVM, runTx } from "@ethereumjs/vm";
import solc from "solc";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_PATH = join(PACKAGE_ROOT, "contracts", "CampaignRegistry.sol");
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, "../..");
const GAS_LIMIT = 5_000_000n;
const GAS_PRICE = 1_000_000_000n;

const FUNDING_TYPES = {
  CampaignFunding: [
    { name: "campaignId", type: "bytes32" },
    { name: "contentCommitment", type: "bytes32" },
    { name: "funder", type: "address" },
    { name: "version", type: "uint256" },
  ],
};

const AMENDMENT_TYPES = {
  CampaignFundingAmendment: [
    { name: "campaignId", type: "bytes32" },
    { name: "newContentCommitment", type: "bytes32" },
    { name: "version", type: "uint256" },
  ],
};

const CAMPAIGN_TERMS_TYPES = {
  CampaignTerms: [
    { name: "campaignId", type: "bytes32" },
    { name: "contentCommitment", type: "bytes32" },
    { name: "organizer", type: "address" },
    { name: "closesAt", type: "uint64" },
    { name: "version", type: "uint256" },
  ],
};

function resolveImport(sourceName) {
  const filePath = sourceName.startsWith("@openzeppelin/")
    ? resolve(REPOSITORY_ROOT, "node_modules", sourceName)
    : resolve(dirname(CONTRACT_PATH), sourceName);
  try {
    return { contents: readFileSync(filePath, "utf8") };
  } catch {
    return { error: `Unable to resolve Solidity import ${sourceName}: ${filePath}` };
  }
}

function compileContract() {
  const source = readFileSync(CONTRACT_PATH, "utf8");
  const input = {
    language: "Solidity",
    sources: { "CampaignRegistry.sol": { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: resolveImport }));
  const errors = (output.errors ?? []).filter((entry) => entry.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
  const artifact = output.contracts?.["CampaignRegistry.sol"]?.CampaignRegistry;
  if (!artifact?.evm?.bytecode?.object) throw new Error("CampaignRegistry contract bytecode is missing");
  return { abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}` };
}

function privateKeyFor(index) {
  return `0x${String(index + 1).padStart(64, "0")}`;
}

export async function compileAndDeployRegistry() {
  const artifact = compileContract();
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Prague });
  const vm = await createVM({ common });
  const wallets = Array.from({ length: 4 }, (_, index) => new Wallet(privateKeyFor(index)));
  for (const wallet of wallets) {
    await vm.stateManager.putAccount(
      createAddressFromPrivateKey(hexToBytes(wallet.privateKey)),
      createAccount({ nonce: 0n, balance: 10n ** 22n }),
    );
  }
  const funder = wallets[0];
  const otherFunder = wallets[1];
  const outsider = wallets[2];
  const organizer = wallets[3];
  const iface = new Interface(artifact.abi);

  async function sendTransaction(wallet, to, data) {
    const key = hexToBytes(wallet.privateKey);
    const from = createAddressFromPrivateKey(key);
    const account = await vm.stateManager.getAccount(from);
    const tx = createLegacyTx({
      nonce: account?.nonce ?? 0n,
      gasLimit: GAS_LIMIT,
      gasPrice: GAS_PRICE,
      value: 0n,
      ...(to ? { to: createAddressFromString(to) } : {}),
      data: hexToBytes(data),
    }, { common }).sign(key);
    const result = await runTx(vm, { tx });
    if (Number(result.receipt.status) !== 1) {
      const reason = result.execResult.exceptionError?.error ?? "EVM_TRANSACTION_REVERTED";
      throw Object.assign(new Error(reason), { code: "EVM_TRANSACTION_REVERTED", result });
    }
    return { result, receipt: result.receipt, async wait() { return result.receipt; } };
  }

  async function deploy() {
    const data = artifact.bytecode;
    const result = await sendTransaction(funder, null, data);
    const address = result.result.createdAddress?.toString();
    if (!address) throw new Error("CampaignRegistry deployment did not return an address");
    return { address, contract: makeContract(address) };
  }

  async function readContract(address, functionName, args) {
    const data = hexToBytes(iface.encodeFunctionData(functionName, args));
    const result = await vm.evm.runCall({
      to: createAddressFromString(address),
      caller: createAddressFromString(funder.address),
      origin: createAddressFromString(funder.address),
      data,
      gasLimit: GAS_LIMIT,
    });
    if (result.execResult.exceptionError) throw new Error(result.execResult.exceptionError.error);
    return iface.decodeFunctionResult(functionName, `0x${Buffer.from(result.execResult.returnValue).toString("hex")}`);
  }

  function makeContract(address) {
    const domain = { name: "DanaTerang Campaign Funding", version: "1", chainId: Number(common.chainId()), verifyingContract: address };
    return {
      address,
      interface: iface,
      domain,
      fundingTypes: FUNDING_TYPES,
      amendmentTypes: AMENDMENT_TYPES,
      campaignTermsTypes: CAMPAIGN_TERMS_TYPES,
      async fundCampaign(message, signature, sender = outsider) {
        const calldata = iface.encodeFunctionData("fundCampaign", [message.campaignId, message.contentCommitment, message.funder, signature]);
        if (process.env.DEBUG_CALLDATA) {
          console.error("calldata:", calldata);
          console.error("decoded :", JSON.stringify(iface.decodeFunctionResult("fundCampaign", calldata.slice(10)), (_, v) => typeof v === "bigint" ? v.toString() : v));
        }
        return sendTransaction(sender, address, calldata);
      },
      async amendCampaignFunding(campaignId, newContentCommitment, expectedVersion, signature, sender = outsider) {
        return sendTransaction(sender, address, iface.encodeFunctionData("amendCampaignFunding", [campaignId, newContentCommitment, expectedVersion, signature]));
      },
      async lockCampaignTerms(message, signature, sender = outsider) {
        return sendTransaction(sender, address, iface.encodeFunctionData("lockCampaignTerms", [
          message.campaignId, message.contentCommitment, message.organizer, message.closesAt, message.version, signature,
        ]));
      },
      async getFunding(...args) {
        const result = await readContract(address, "getFunding", args);
        return { contentCommitment: result[0], funder: result[1], version: Number(result[2]), fundedAt: result[3] };
      },
      async getCampaignTerms(...args) {
        const result = await readContract(address, "getCampaignTerms", args);
        return { contentCommitment: result[0], organizer: result[1], closesAt: Number(result[2]), version: Number(result[3]), lockedAt: Number(result[4]) };
      },
    };
  }

  function fundingMessage({ campaignId, contentCommitment, funder, version = 1 }) {
    return { campaignId, contentCommitment, funder, version };
  }

  async function signFunding(wallet, contract, message) {
    return wallet.signTypedData(contract.domain, FUNDING_TYPES, message);
  }

  async function signAmendment(wallet, contract, message) {
    return wallet.signTypedData(contract.domain, AMENDMENT_TYPES, message);
  }

  function campaignTermsMessage({ campaignId, contentCommitment, organizer, closesAt, version = 1 }) {
    return { campaignId, contentCommitment, organizer, closesAt, version };
  }

  async function signCampaignTerms(wallet, contract, message) {
    return wallet.signTypedData(contract.domain, CAMPAIGN_TERMS_TYPES, message);
  }

  const deployment = await deploy();
  return {
    vm,
    common,
    contract: deployment.contract,
    address: deployment.address,
    funder,
    otherFunder,
    outsider,
    organizer,
    fundingMessage,
    signFunding,
    signAmendment,
    campaignTermsMessage,
    signCampaignTerms,
    async close() {},
  };
}
