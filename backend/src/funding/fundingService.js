import { randomUUID } from "node:crypto";

import { hashCanonicalJson } from "@dana-terang/proof";
import { keccak256, toUtf8Bytes, verifyTypedData } from "ethers";

const FUNDING_TYPES = {
  CampaignFunding: [
    { name: "campaignId", type: "bytes32" },
    { name: "contentCommitment", type: "bytes32" },
    { name: "funder", type: "address" },
    { name: "version", type: "uint256" },
  ],
};

const WALLET_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EIP712_SIGNATURE = /^0x[0-9a-fA-F]{130}$/; // 65-byte signature = 130 hex chars + 0x
const FUNDING_DOMAIN = { name: "DanaTerang Campaign Funding", version: "1" };

function fundingError(code) {
  return Object.assign(new Error(code), { code });
}

function canonicalJson(value) {
  const encoded = canonicalize(value);
  if (typeof encoded !== "string") throw fundingError("FUNDING_COMMITMENT_FAILED");
  return encoded;
}

function dateString(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null;
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

/** Deterministic campaignId on chain: the opaque UUID is hashed, never shipped raw. */
function campaignIdOnChain(campaignUuid) {
  return keccak256(toUtf8Bytes(String(campaignUuid).toLowerCase()));
}

/** Canonical content commitment: the funding agreement outline the Funder signs. */
export function buildContentCommitment(source) {
  if (!source || typeof source.campaignId !== "string") throw fundingError("FUNDING_SOURCE_INVALID");
  const record = {
    campaignId: String(source.campaignId).toLowerCase(),
    title: String(source.title).normalize("NFC"),
    description: String(source.description ?? "").normalize("NFC"),
    totalBudget: String(source.totalBudget),
    currency: String(source.currency).toUpperCase(),
    fundingMode: String(source.fundingMode ?? "EXTERNAL_TRACKING"),
    startDate: dateString(source.startDate),
    endDate: dateString(source.endDate),
    organizerOrganizationId: String(source.organizerOrganizationId).toLowerCase(),
    funderUserId: String(source.funderUserId).toLowerCase(),
    fundingVersion: 1,
  };
  return { record, contentCommitment: `0x${hashCanonicalJson(record)}` };
}

export function createFundingService({ repository, campaignRepository, walletLookup, contract = null, chainId = null, contractAddress = null, now: clock = () => new Date() } = {}) {
  if (!repository || !campaignRepository) throw new TypeError("Funding service requires repositories");
  if (typeof walletLookup !== "function") throw new TypeError("Funding service requires a wallet lookup");

  function typedDataFor(message) {
    if (!chainId || !contractAddress) throw fundingError("FUNDING_DISABLED");
    return {
      domain: { ...FUNDING_DOMAIN, chainId, verifyingContract: contractAddress },
      // EIP712Domain is included for wallet shims that expect it (MetaMask
      // itself ignores it and rebuilds the domain from the domain field).
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        CampaignFunding: FUNDING_TYPES.CampaignFunding,
      },
      primaryType: "CampaignFunding",
      message,
    };
  }

  async function loadSourceForFunder(actor, campaignId) {
    const source = await repository.getFundingSource(campaignId);
    if (actor.role !== "FUNDER" || actor.id !== source.funderUserId) {
      throw fundingError("FORBIDDEN");
    }
    if (source.status !== "DRAFT") throw fundingError("CAMPAIGN_ALREADY_FUNDED");
    return source;
  }

  async function requireBoundWallet(actor) {
    const bound = await walletLookup(actor.id);
    if (!bound || !WALLET_ADDRESS.test(bound)) throw fundingError("FUNDING_WALLET_NOT_BOUND");
    return bound;
  }

  async function prepareFunding({ actor, campaignId } = {}) {
    const source = await loadSourceForFunder(actor, campaignId);
    const walletAddress = await requireBoundWallet(actor);
    const { record, contentCommitment } = buildContentCommitment(source);
    const message = {
      campaignId: campaignIdOnChain(campaignId),
      contentCommitment,
      funder: walletAddress,
      version: 1,
    };
    return {
      contentCommitment,
      walletAddress,
      typedData: typedDataFor(message),
      record,
    };
  }

  async function activateWithSignature({ actor, campaignId, signature, walletAddress, now = clock() } = {}) {
    if (!EIP712_SIGNATURE.test(signature ?? "")) throw fundingError("INVALID_FUNDING_SIGNATURE");
    if (!contract) throw fundingError("FUNDING_DISABLED");
    const boundWallet = await requireBoundWallet(actor);
    if (walletAddress && walletAddress.toLowerCase() !== boundWallet.toLowerCase()) {
      throw fundingError("FUNDING_WALLET_MISMATCH");
    }
    const source = await loadSourceForFunder(actor, campaignId);
    const { contentCommitment } = buildContentCommitment(source);
    const message = {
      campaignId: campaignIdOnChain(campaignId),
      contentCommitment,
      funder: boundWallet,
      version: 1,
    };
    const typedData = typedDataFor(message);
    let signer;
    try {
      // Wallets receive the full types (incl. EIP712Domain for shims); ethers
      // verification itself must not be handed the EIP712Domain entry.
      const { EIP712Domain, ...verifyTypes } = typedData.types;
      signer = verifyTypedData(typedData.domain, verifyTypes, message, signature);
    } catch {
      throw fundingError("INVALID_FUNDING_SIGNATURE");
    }
    if (signer.toLowerCase() !== walletAddress.toLowerCase()) throw fundingError("INVALID_FUNDING_SIGNATURE");

    const existing = await repository.getFundingByCampaign(campaignId);
    if (!existing) {
      let transaction;
      try {
        transaction = await contract.fundCampaign(message.campaignId, contentCommitment, boundWallet, signature);
      } catch (error) {
        if (String(error?.message ?? "").includes("EXPECT_CAMPAIGN_ALREADY_FUNDED")) {
          throw fundingError("FUNDING_ALREADY_RECORDED");
        }
        throw fundingError("FUNDING_ANCHOR_FAILED");
      }
      const transactionHash = typeof transaction?.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(transaction.hash)
        ? transaction.hash.toLowerCase()
        : null;
      if (!transactionHash) throw fundingError("FUNDING_ANCHOR_FAILED");
      let receipt;
      try {
        receipt = await transaction.wait();
      } catch {
        throw fundingError("FUNDING_ANCHOR_PENDING");
      }
      if (Number(receipt?.status) !== 1 || !Number.isSafeInteger(Number(receipt.blockNumber))) {
        throw fundingError("FUNDING_ANCHOR_FAILED");
      }
      await repository.recordFunding({
        id: randomUUID(),
        campaignId,
        contentCommitment,
        funderUserId: actor.id,
        funderWallet: boundWallet.toLowerCase(),
        registryAddress: contractAddress,
        eip712Signature: signature,
        transactionHash,
        blockNumber: Number(receipt.blockNumber),
        now,
      });
    }

    const campaign = await campaignRepository.activateCampaign({ actor, campaignId });
    const record = await repository.getFundingByCampaign(campaignId);
    return { campaign, funding: record };
  }

  return Object.freeze({ prepareFunding, activateWithSignature });
}
