import assert from "node:assert/strict";
import test from "node:test";

import { compileAndDeployRegistry } from "../testHelpers/compile-and-deploy-registry.js";

const ZERO = `0x${"00".repeat(32)}`;
const CAMPAIGN_ID = `0x${"21".repeat(32)}`;
const COMMITMENT = `0x${"42".repeat(32)}`;
const OTHER_COMMITMENT = `0x${"77".repeat(32)}`;

test("a genuine Funder signature records the funding agreement once", async () => {
  const chain = await compileAndDeployRegistry();
  try {
    const message = chain.fundingMessage({ campaignId: CAMPAIGN_ID, contentCommitment: COMMITMENT, funder: chain.funder.address });
    const signature = await chain.signFunding(chain.funder, chain.contract, message);
    // Permissionless relay: an outsider can submit what a funder genuinely signed.
    const submitted = await chain.contract.fundCampaign(message, signature, chain.outsider);
    await submitted.wait();

    const record = await chain.contract.getFunding(CAMPAIGN_ID);
    assert.equal(record.contentCommitment, COMMITMENT);
    assert.equal(record.funder, chain.funder.address);
    assert.equal(record.version, 1);
  } finally {
    await chain.close();
  }
});

test("forged, wrong-signer, and zero-input fundings are rejected", async () => {
  const chain = await compileAndDeployRegistry();
  try {
    const message = chain.fundingMessage({ campaignId: CAMPAIGN_ID, contentCommitment: COMMITMENT, funder: chain.funder.address });
    await assert.rejects(chain.contract.fundCampaign(message, `0x${"ab".repeat(65)}`));

    const outsiderSignature = await chain.signFunding(chain.outsider, chain.contract, message);
    await assert.rejects(chain.contract.fundCampaign(message, outsiderSignature));

    const wrongWalletMessage = chain.fundingMessage({ campaignId: CAMPAIGN_ID, contentCommitment: COMMITMENT, funder: chain.otherFunder.address });
    const funderSignature = await chain.signFunding(chain.funder, chain.contract, wrongWalletMessage);
    await assert.rejects(chain.contract.fundCampaign(wrongWalletMessage, funderSignature));

    await assert.rejects(chain.contract.fundCampaign(chain.fundingMessage({ campaignId: ZERO, contentCommitment: COMMITMENT, funder: chain.funder.address }), await chain.signFunding(chain.funder, chain.contract, chain.fundingMessage({ campaignId: ZERO, contentCommitment: COMMITMENT, funder: chain.funder.address }))));
    await assert.rejects(chain.contract.fundCampaign(chain.fundingMessage({ campaignId: CAMPAIGN_ID, contentCommitment: ZERO, funder: chain.funder.address }), await chain.signFunding(chain.funder, chain.contract, chain.fundingMessage({ campaignId: CAMPAIGN_ID, contentCommitment: ZERO, funder: chain.funder.address }))));
  } finally {
    await chain.close();
  }
});

test("a campaign can be funded only once", async () => {
  const chain = await compileAndDeployRegistry();
  try {
    const message = chain.fundingMessage({ campaignId: CAMPAIGN_ID, contentCommitment: COMMITMENT, funder: chain.funder.address });
    const signature = await chain.signFunding(chain.funder, chain.contract, message);
    (await chain.contract.fundCampaign(message, signature)).wait();

    const again = chain.fundingMessage({ campaignId: CAMPAIGN_ID, contentCommitment: OTHER_COMMITMENT, funder: chain.funder.address });
    await assert.rejects(chain.contract.fundCampaign(again, await chain.signFunding(chain.funder, chain.contract, again)));

    const record = await chain.contract.getFunding(CAMPAIGN_ID);
    assert.equal(record.contentCommitment, COMMITMENT);
  } finally {
    await chain.close();
  }
});

test("amendments are append-only and signed by the recorded funder", async () => {
  const chain = await compileAndDeployRegistry();
  try {
    const message = chain.fundingMessage({ campaignId: CAMPAIGN_ID, contentCommitment: COMMITMENT, funder: chain.funder.address });
    (await chain.contract.fundCampaign(message, await chain.signFunding(chain.funder, chain.contract, message))).wait();

    const amendment = { campaignId: CAMPAIGN_ID, newContentCommitment: OTHER_COMMITMENT, version: 2 };
    // Wrong expected version (current is 1) and wrong signer are rejected before any state changes.
    await assert.rejects(chain.contract.amendCampaignFunding(CAMPAIGN_ID, OTHER_COMMITMENT, 2, await chain.signAmendment(chain.funder, chain.contract, amendment)));
    const outsiderAmendment = await chain.signAmendment(chain.outsider, chain.contract, amendment);
    await assert.rejects(chain.contract.amendCampaignFunding(CAMPAIGN_ID, OTHER_COMMITMENT, 1, outsiderAmendment));

    const amendmentSignature = await chain.signAmendment(chain.funder, chain.contract, amendment);
    (await chain.contract.amendCampaignFunding(CAMPAIGN_ID, OTHER_COMMITMENT, 1, amendmentSignature)).wait();

    const record = await chain.contract.getFunding(CAMPAIGN_ID);
    assert.equal(record.contentCommitment, OTHER_COMMITMENT);
    assert.equal(record.funder, chain.funder.address);
    assert.equal(record.version, 2);

    // Old-version replay is rejected.
    const replaySignature = await chain.signAmendment(chain.funder, chain.contract, { campaignId: CAMPAIGN_ID, newContentCommitment: COMMITMENT, version: 2 });
    await assert.rejects(chain.contract.amendCampaignFunding(CAMPAIGN_ID, COMMITMENT, 2, replaySignature));
  } finally {
    await chain.close();
  }
});

test("amending an unfunded campaign is rejected and no admin path exists", async () => {
  const chain = await compileAndDeployRegistry();
  try {
    const amendment = { campaignId: CAMPAIGN_ID, newContentCommitment: OTHER_COMMITMENT, version: 1 };
    await assert.rejects(chain.contract.amendCampaignFunding(CAMPAIGN_ID, OTHER_COMMITMENT, 1, await chain.signAmendment(chain.funder, chain.contract, amendment)));
    const iface = chain.contract.interface;
    const names = iface.fragments.filter((f) => f.type === "function").map((f) => f.name);
    assert.deepEqual(names.sort(), ["amendCampaignFunding", "eip712Domain", "fundCampaign", "fundingVersion", "getFunding"]);
  } finally {
    await chain.close();
  }
});
