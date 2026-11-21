import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";

import { buildContentCommitment, createFundingService } from "../../src/funding/fundingService.js";

const CAMPAIGN_ID = "1b6f8e20-9c1a-4c1e-8e2b-3f5a6b7c8d90";
const ORG_ID = "3b6f8e20-9c1a-4c1e-8e2b-3f5a6b7c8d90";
const FUNDER_ID = "4b6f8e20-9c1a-4c1e-8e2b-3f5a6b7c8d90";
const FUNDER_WALLET_KEY = `0x${"7".repeat(64)}`;
const funderWallet = new Wallet(FUNDER_WALLET_KEY);
const FUNDER_WALLET_ADDRESS = funderWallet.address;
const TX_HASH = `0x${"ab".repeat(32)}`;
const FIXED_NOW = new Date("2026-11-21T12:00:00.000Z");

function sourceFixture(overrides = {}) {
  return {
    campaignId: CAMPAIGN_ID,
    title: "Bantuan Sosial - Panti Bogor",
    description: "Program bantuan",
    totalBudget: "100000000.00",
    currency: "IDR",
    fundingMode: "EXTERNAL_TRACKING",
    startDate: "2026-11-01",
    endDate: "2026-12-31",
    status: "DRAFT",
    organizerOrganizationId: ORG_ID,
    funderUserId: FUNDER_ID,
    ...overrides,
  };
}

function createFakeRepositories() {
  const state = { funding: null };
  return {
    get funding() { return state.funding; },
    async getFundingSource(campaignId) {
      if (campaignId !== CAMPAIGN_ID) throw Object.assign(new Error("FUNDING_SOURCE_NOT_FOUND"), { code: "FUNDING_SOURCE_NOT_FOUND" });
      return sourceFixture();
    },
    async recordFunding(input) {
      if (state.funding) return { created: false, record: state.funding };
      state.funding = { ...input, status: "ANCHORED" };
      return { created: true, record: state.funding };
    },
    async getFundingByCampaign() {
      return state.funding;
    },
  };
}

function createFakeRegistry() {
  return {
    async fundCampaign() {
      return { hash: TX_HASH, async wait() { return { status: 1, blockNumber: 4321 }; } };
    },
  };
}

function createService({ repository = createFakeRepositories(), contract = createFakeRegistry() } = {}) {
  return createFundingService({
    repository,
    campaignRepository: { async activateCampaign({ campaignId }) { return { id: campaignId, status: "ACTIVE" }; } },
    contract,
    chainId: 11155111,
    contractAddress: `0x${"c".repeat(40)}`,
    now: () => FIXED_NOW,
  });
}

const FUNDER_ACTOR = { id: FUNDER_ID, role: "FUNDER" };

async function signedActivation(service) {
  const prepare = await service.prepareFunding({ actor: FUNDER_ACTOR, campaignId: CAMPAIGN_ID, walletAddress: FUNDER_WALLET_ADDRESS });
  const { EIP712Domain, ...signTypes } = prepare.typedData.types;
  const signature = await funderWallet.signTypedData(prepare.typedData.domain, signTypes, prepare.typedData.message);
  return service.activateWithSignature({
    actor: FUNDER_ACTOR,
    campaignId: CAMPAIGN_ID,
    signature,
    walletAddress: FUNDER_WALLET_ADDRESS,
  });
}

test("prepare builds a stable content commitment and a readable typed message", async () => {
  const service = createService();
  const prepare = await service.prepareFunding({ actor: FUNDER_ACTOR, campaignId: CAMPAIGN_ID, walletAddress: FUNDER_WALLET_ADDRESS });
  assert.match(prepare.contentCommitment, /^0x[0-9a-f]{64}$/);
  assert.equal(prepare.typedData.domain.chainId, 11155111);
  assert.equal(prepare.typedData.domain.name, "DanaTerang Campaign Funding");
  assert.equal(prepare.typedData.message.funder, FUNDER_WALLET_ADDRESS);
  const again = await service.prepareFunding({ actor: FUNDER_ACTOR, campaignId: CAMPAIGN_ID, walletAddress: FUNDER_WALLET_ADDRESS });
  assert.equal(again.contentCommitment, prepare.contentCommitment);
  // The commitment covers the outline only; the milestone list is not part of it.
  assert.equal(prepare.record.totalBudget, "100000000.00");
});

test("activation records the on-chain funding and activates the campaign", async () => {
  const repository = createFakeRepositories();
  const activated = [];
  const service = createService({
    repository,
    contract: { async fundCampaign() { return { hash: TX_HASH, async wait() { return { status: 1, blockNumber: 4321 }; } }; } },
  });
  void activated;
  const result = await signedActivation(service);
  assert.equal(result.campaign.status, "ACTIVE");
  assert.equal(repository.funding.transactionHash, TX_HASH);
  assert.equal(repository.funding.funderWallet, FUNDER_WALLET_ADDRESS.toLowerCase());
  assert.equal(repository.funding.contentCommitment.length, 66);
});

test("a signature by a different wallet is rejected before any chain call", async () => {
  let chainCalls = 0;
  const service = createService({
    contract: { async fundCampaign() { chainCalls += 1; return { hash: TX_HASH, async wait() { return { status: 1, blockNumber: 1 }; } }; } },
  });
  const impostor = new Wallet(`0x${"8".repeat(64)}`);
  const prepare = await service.prepareFunding({ actor: FUNDER_ACTOR, campaignId: CAMPAIGN_ID, walletAddress: FUNDER_WALLET_ADDRESS });
  const { EIP712Domain, ...signTypes } = prepare.typedData.types;
  const signature = await impostor.signTypedData(prepare.typedData.domain, signTypes, prepare.typedData.message);
  await assert.rejects(
    service.activateWithSignature({ actor: FUNDER_ACTOR, campaignId: CAMPAIGN_ID, signature, walletAddress: FUNDER_WALLET_ADDRESS }),
    { code: "INVALID_FUNDING_SIGNATURE" },
  );
  assert.equal(chainCalls, 0);
});

test("activation recovers when the funding is already recorded on-chain", async () => {
  const repository = createFakeRepositories();
  // Pre-seed the record as if a previous attempt stored it.
  await repository.recordFunding({
    id: "seed", campaignId: CAMPAIGN_ID, contentCommitment: "existing", funderUserId: FUNDER_ID,
    funderWallet: FUNDER_WALLET_ADDRESS.toLowerCase(), registryAddress: `0x${"c".repeat(40)}`,
    eip712Signature: `0x${"9a".repeat(66)}`, transactionHash: TX_HASH, blockNumber: 4321, now: FIXED_NOW,
  });
  const activated = [];
  const service = createService({
    repository,
    contract: { async fundCampaign() { throw new Error("EXPECT_CAMPAIGN_ALREADY_FUNDED"); } },
  });
  const result = await signedActivation(service);
  assert.equal(result.campaign.status, "ACTIVE");
  assert.equal(result.funding.transactionHash, TX_HASH);
});

test("activation fails closed without a registry contract", async () => {
  const service = createService({ repository: createFakeRepositories(), contract: null });
  await assert.rejects(
    signedActivation(service),
    { code: "FUNDING_DISABLED" },
  );
});

test("buildContentCommitment rejects a missing campaign source", () => {
  assert.throws(() => buildContentCommitment(null), { code: "FUNDING_SOURCE_INVALID" });
});
