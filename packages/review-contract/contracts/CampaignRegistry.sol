// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice On-chain registry of campaign funding agreements. The linked Funder
/// signs a readable EIP-712 commitment ("I fund this campaign outline up to the
/// recorded budget ceiling") and this contract verifies the signature itself
/// before storing `campaignId -> contentCommitment`. Submission is
/// permissionless on purpose: the signature is the authorization, so a relayer
/// can relay genuine consents but can never fabricate one. There is no owner,
/// no admin, and no delete path; corrections go through signed, append-only
/// amendments that preserve the full history.
contract CampaignRegistry is EIP712("DanaTerang Campaign Funding", "1") {
    error EXPECT_ZERO_CAMPAIGN_ID();
    error EXPECT_ZERO_COMMITMENT();
    error EXPECT_ZERO_FUNDER();
    error EXPECT_CAMPAIGN_ALREADY_FUNDED();
    error EXPECT_CAMPAIGN_NOT_FUNDED();
    error EXPECT_BAD_SIGNATURE();
    error EXPECT_FUNDER_MISMATCH();
    error EXPECT_VERSION_MISMATCH();

    bytes32 private constant CAMPAIGN_FUNDING_TYPEHASH =
        keccak256("CampaignFunding(bytes32 campaignId,bytes32 contentCommitment,address funder,uint256 version)");
    bytes32 private constant CAMPAIGN_FUNDING_AMENDMENT_TYPEHASH =
        keccak256("CampaignFundingAmendment(bytes32 campaignId,bytes32 newContentCommitment,uint256 version)");

    struct CampaignFunding {
        bytes32 campaignId;
        bytes32 contentCommitment;
        address funder;
        uint256 version;
    }

    struct CampaignFundingAmendment {
        bytes32 campaignId;
        bytes32 newContentCommitment;
        uint256 version;
    }

    struct FundingRecord {
        bytes32 contentCommitment;
        address funder;
        uint256 version;
        uint64 fundedAt;
    }

    event CampaignFunded(bytes32 indexed campaignId, address indexed funder, bytes32 contentCommitment, uint256 version);
    event CampaignFundingAmended(bytes32 indexed campaignId, address indexed funder, bytes32 newContentCommitment, uint256 version);

    mapping(bytes32 => FundingRecord) private _records;

    function fundCampaign(bytes32 campaignId, bytes32 contentCommitment, address funder, bytes calldata signature) external {
        if (campaignId == bytes32(0)) revert EXPECT_ZERO_CAMPAIGN_ID();
        if (contentCommitment == bytes32(0)) revert EXPECT_ZERO_COMMITMENT();
        if (funder == address(0)) revert EXPECT_ZERO_FUNDER();
        if (_records[campaignId].funder != address(0)) revert EXPECT_CAMPAIGN_ALREADY_FUNDED();

        CampaignFunding memory message = CampaignFunding({
            campaignId: campaignId,
            contentCommitment: contentCommitment,
            funder: funder,
            version: 1
        });
        if (ECDSA.recover(_hashTypedDataV4(_hashFunding(message)), signature) != funder) {
            revert EXPECT_BAD_SIGNATURE();
        }

        _records[campaignId] = FundingRecord({
            contentCommitment: contentCommitment,
            funder: funder,
            version: 1,
            fundedAt: uint64(block.timestamp)
        });
        emit CampaignFunded(campaignId, funder, contentCommitment, 1);
    }

    function amendCampaignFunding(bytes32 campaignId, bytes32 newContentCommitment, uint256 expectedVersion, bytes calldata signature) external {
        if (campaignId == bytes32(0)) revert EXPECT_ZERO_CAMPAIGN_ID();
        if (newContentCommitment == bytes32(0)) revert EXPECT_ZERO_COMMITMENT();
        FundingRecord memory record = _records[campaignId];
        if (record.funder == address(0)) revert EXPECT_CAMPAIGN_NOT_FUNDED();
        if (expectedVersion != record.version) revert EXPECT_VERSION_MISMATCH();

        CampaignFundingAmendment memory message = CampaignFundingAmendment({
            campaignId: campaignId,
            newContentCommitment: newContentCommitment,
            version: record.version + 1
        });
        if (ECDSA.recover(_hashTypedDataV4(_hashAmendment(message)), signature) != record.funder) {
            revert EXPECT_FUNDER_MISMATCH();
        }

        _records[campaignId].contentCommitment = newContentCommitment;
        _records[campaignId].version = record.version + 1;
        emit CampaignFundingAmended(campaignId, record.funder, newContentCommitment, record.version + 1);
    }

    function getFunding(bytes32 campaignId) external view returns (bytes32 contentCommitment, address funder, uint256 version, uint64 fundedAt) {
        FundingRecord memory record = _records[campaignId];
        return (record.contentCommitment, record.funder, record.version, record.fundedAt);
    }

    function fundingVersion(bytes32 campaignId) external view returns (uint256) {
        return _records[campaignId].version;
    }

    // Returns the STRUCT hash only; _hashTypedDataV4 is applied by the caller
    // exactly once. (A previous draft hashed twice here, breaking verification.)
    function _hashFunding(CampaignFunding memory message) private pure returns (bytes32) {
        return keccak256(abi.encode(
            CAMPAIGN_FUNDING_TYPEHASH,
            message.campaignId,
            message.contentCommitment,
            message.funder,
            message.version
        ));
    }

    function _hashAmendment(CampaignFundingAmendment memory message) private pure returns (bytes32) {
        return keccak256(abi.encode(
            CAMPAIGN_FUNDING_AMENDMENT_TYPEHASH,
            message.campaignId,
            message.newContentCommitment,
            message.version
        ));
    }
}
