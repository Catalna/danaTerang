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
const CAMPAIGN_TERMS_TYPES = {
  CampaignTerms: [
    { name: "campaignId", type: "bytes32" },
    { name: "contentCommitment", type: "bytes32" },
    { name: "organizer", type: "address" },
    { name: "closesAt", type: "uint64" },
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

  async function findCampaignTermsOnChain(message) {
    if (typeof contract?.getCampaignTerms !== "function") return null;
    let record;
    try {
      record = await contract.getCampaignTerms(message.campaignId);
    } catch {
      return null;
    }
    const recordCommitment = String(record.contentCommitment ?? record[0] ?? "").toLowerCase();
    const recordOrganizer = String(record.organizer ?? record[1] ?? "").toLowerCase();
    const recordClosesAt = Number(record.closesAt ?? record[2] ?? 0);
    const recordVersion = Number(record.version ?? record[3] ?? 0);
    if (!recordOrganizer || /^0x0+$/.test(recordOrganizer)) return null;
    if (recordCommitment !== message.contentCommitment.toLowerCase()
        || recordOrganizer !== message.organizer.toLowerCase()
        || recordClosesAt !== Number(message.closesAt)
        || recordVersion !== Number(message.version)) {
      throw fundingError("CAMPAIGN_TERMS_CHAIN_CONFLICT");
    }
    let transactionHash = null;
    try {
      const filter = contract.filters?.CampaignTermsLocked?.(message.campaignId);
      if (filter && typeof contract.queryFilter === "function") {
        const events = await contract.queryFilter(filter);
        const event = [...events].reverse().find((item) =>
          String(item.args?.contentCommitment ?? item.args?.[2] ?? "").toLowerCase() === message.contentCommitment.toLowerCase()
          && Number(item.args?.version ?? item.args?.[4] ?? 0) === Number(message.version));
        if (typeof event?.transactionHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(event.transactionHash)) {
          transactionHash = event.transactionHash.toLowerCase();
        }
      }
    } catch {
      // Event indexing can be temporarily unavailable; never send a duplicate transaction.
    }
    return { transactionHash };
  }

  async function prepareCampaignTerms({ actor, campaignId, now = clock() } = {}) {
    if (actor?.role !== "ORGANIZER") throw fundingError("FORBIDDEN");
    if (!contract || !chainId || !contractAddress) throw fundingError("CAMPAIGN_TERMS_DISABLED");
    const source = await campaignRepository.getCampaignTermsForOrganizer({ actor, campaignId, now });
    if (source.alreadyLocked) return { alreadyLocked: true, termsCommitment: source.termsCommitment, version: source.version };
    const organizerWallet = await walletLookup(actor.id);
    if (!organizerWallet || !WALLET_ADDRESS.test(organizerWallet)) throw fundingError("CAMPAIGN_SIGNER_WALLET_NOT_BOUND");
    const closesAt = Math.floor(new Date(source.closeAt).getTime() / 1000);
    const message = {
      campaignId: campaignIdOnChain(campaignId),
      contentCommitment: source.termsCommitment,
      organizer: organizerWallet,
      closesAt,
      version: Number(source.version),
    };
    const termsDomain = { name: FUNDING_DOMAIN.name, version: FUNDING_DOMAIN.version, chainId, verifyingContract: contractAddress };
    return {
      alreadyLocked: false,
      termsCommitment: source.termsCommitment,
      walletAddress: organizerWallet,
      snapshot: source.snapshot,
      typedData: {
        domain: termsDomain,
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          CampaignTerms: CAMPAIGN_TERMS_TYPES.CampaignTerms,
        },
        primaryType: "CampaignTerms",
        message,
      },
    };
  }

  async function lockCampaignTerms({ actor, campaignId, signature, walletAddress, now = clock() } = {}) {
    if (actor?.role !== "ORGANIZER") throw fundingError("FORBIDDEN");
    if (!EIP712_SIGNATURE.test(signature ?? "") || !WALLET_ADDRESS.test(walletAddress ?? "")) {
      throw fundingError("INVALID_CAMPAIGN_TERMS_SIGNATURE");
    }
    if (!contract || !chainId || !contractAddress) throw fundingError("CAMPAIGN_TERMS_DISABLED");
    const boundWallet = await walletLookup(actor.id);
    if (!boundWallet || !WALLET_ADDRESS.test(boundWallet)) throw fundingError("CAMPAIGN_SIGNER_WALLET_NOT_BOUND");
    if (walletAddress.toLowerCase() !== boundWallet.toLowerCase()) throw fundingError("CAMPAIGN_SIGNER_WALLET_MISMATCH");
    const source = await campaignRepository.getCampaignTermsForOrganizer({ actor, campaignId, now });
    if (source.alreadyLocked) return { campaignId, termsCommitment: source.termsCommitment, alreadyLocked: true };

    const closesAt = Math.floor(new Date(source.closeAt).getTime() / 1000);
    const message = {
      campaignId: campaignIdOnChain(campaignId),
      contentCommitment: source.termsCommitment,
      organizer: boundWallet,
      closesAt,
      version: Number(source.version),
    };
    const domain = { ...FUNDING_DOMAIN, chainId, verifyingContract: contractAddress };
    let signer;
    try {
      signer = verifyTypedData(domain, CAMPAIGN_TERMS_TYPES, message, signature);
    } catch {
      throw fundingError("INVALID_CAMPAIGN_TERMS_SIGNATURE");
    }
    if (signer.toLowerCase() !== boundWallet.toLowerCase()) throw fundingError("INVALID_CAMPAIGN_TERMS_SIGNATURE");

    const existingOnChain = await findCampaignTermsOnChain(message);
    let transactionHash = existingOnChain?.transactionHash ?? null;
    if (!existingOnChain) {
      let transaction;
      try {
        transaction = await contract.lockCampaignTerms(
          message.campaignId,
          message.contentCommitment,
          message.organizer,
          message.closesAt,
          message.version,
          signature,
        );
      } catch (error) {
        throw fundingError(String(error?.message ?? "").includes("EXPECT_CAMPAIGN_TERMS_WINDOW")
          ? "CAMPAIGN_TERMS_WINDOW_CLOSED"
          : "CAMPAIGN_TERMS_ANCHOR_FAILED");
      }
      transactionHash = typeof transaction?.hash === "string" && /^0x[0-9a-fA-F]{64}$/.test(transaction.hash)
        ? transaction.hash.toLowerCase()
        : null;
      if (!transactionHash) throw fundingError("CAMPAIGN_TERMS_ANCHOR_FAILED");
      let receipt;
      try { receipt = await transaction.wait(); } catch { throw fundingError("CAMPAIGN_TERMS_ANCHOR_PENDING"); }
      if (Number(receipt?.status) !== 1) throw fundingError("CAMPAIGN_TERMS_ANCHOR_FAILED");
    }
    if (!transactionHash) throw fundingError("CAMPAIGN_TERMS_RECOVERY_REQUIRED");

    const result = await campaignRepository.recordCampaignTermsLock({
      actor,
      campaignId,
      walletAddress: boundWallet.toLowerCase(),
      signature,
      transactionHash,
      contentCommitment: source.termsCommitment,
      version: source.version,
      now,
    });
    return { campaign: result.campaign, termsCommitment: source.termsCommitment, transactionHash, alreadyLocked: result.alreadyLocked };
  }

  return Object.freeze({ prepareFunding, activateWithSignature, prepareCampaignTerms, lockCampaignTerms });
}
