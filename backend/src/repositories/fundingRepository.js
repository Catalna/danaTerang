function repositoryError(code) {
  return Object.assign(new Error(code), { code });
}

function rowToFunding(row) {
  if (!row) return null;
  return {
    id: row.id,
    campaignId: row.campaign_id,
    contentCommitment: row.content_commitment,
    funderUserId: row.funder_user_id,
    funderWallet: row.funder_wallet,
    registryAddress: row.registry_address,
    eip712Signature: row.eip712_signature,
    status: row.status,
    transactionHash: row.transaction_hash,
    blockNumber: row.block_number === null || row.block_number === undefined ? null : Number(row.block_number),
    fundingVersion: row.funding_version,
    createdAt: row.created_at,
  };
}

export function createFundingRepository(pool) {
  if (!pool) throw new TypeError("Funding repository requires a database pool");

  return {
    /** Campaign core fields that the Funder's signature commits to. */
    async getFundingSource(campaignId) {
      const result = await pool.query(
        `SELECT c.id, c.title, c.description, c.total_budget::text AS total_budget, c.currency,
                c.funding_mode, c.start_date, c.end_date, c.status,
                c.organization_id AS organizer_organization_id, c.funder_id
         FROM campaigns c WHERE c.id = $1`,
        [campaignId],
      );
      if (result.rowCount === 0) throw repositoryError("FUNDING_SOURCE_NOT_FOUND");
      const row = result.rows[0];
      return {
        campaignId: row.id,
        title: row.title,
        description: row.description ?? "",
        totalBudget: row.total_budget,
        currency: row.currency,
        fundingMode: row.funding_mode,
        startDate: row.start_date,
        endDate: row.end_date,
        status: row.status,
        organizerOrganizationId: row.organizer_organization_id,
        funderUserId: row.funder_id,
      };
    },

    async recordFunding({
      id, campaignId, contentCommitment, funderUserId, funderWallet,
      registryAddress, eip712Signature, transactionHash, blockNumber, now,
    }) {
      const result = await pool.query(
        `INSERT INTO campaign_funding_records
           (id, campaign_id, content_commitment, funder_user_id, funder_wallet,
            registry_address, eip712_signature, status, transaction_hash, block_number,
            funding_version, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ANCHORED', $8, $9, 1, $10)
         ON CONFLICT (campaign_id) DO NOTHING
         RETURNING *`,
        [id, campaignId, contentCommitment, funderUserId, funderWallet,
          registryAddress, eip712Signature, transactionHash, blockNumber, now],
      );
      if (result.rowCount === 0) {
        const existing = await pool.query("SELECT * FROM campaign_funding_records WHERE campaign_id = $1", [campaignId]);
        return { created: false, record: rowToFunding(existing.rows[0]) };
      }
      return { created: true, record: rowToFunding(result.rows[0]) };
    },

    async getFundingByCampaign(campaignId) {
      const result = await pool.query("SELECT * FROM campaign_funding_records WHERE campaign_id = $1", [campaignId]);
      return rowToFunding(result.rows[0]);
    },
  };
}
