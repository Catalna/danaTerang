import { randomUUID } from "node:crypto";

function failure(code) { return Object.assign(new Error(code), { code }); }
function units(amount) {
  const [whole, fraction = ""] = String(amount).split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}
function decimal(value) {
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}
function date(value) { return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10); }
function scope(actor, alias = "c") {
  if (actor?.role === "ADMIN") return { sql: "TRUE", parameters: [] };
  if (actor?.role === "FUNDER") return { sql: `${alias}.funder_id = $1`, parameters: [actor.id] };
  if (actor?.role === "ORGANIZER" && actor.organizationId) return { sql: `${alias}.organization_id = $1`, parameters: [actor.organizationId] };
  throw failure("FORBIDDEN");
}
function project(row, role) {
  return {
    id: row.id, campaignId: row.campaign_id, campaignTitle: row.campaign_title,
    milestoneId: row.milestone_id, milestoneTitle: row.milestone_title,
    reportedAmount: decimal(units(row.reported_amount)), currency: row.currency,
    status: row.status, method: row.method, paidAt: date(row.paid_at), createdAt: row.created_at,
    ...(role === "ADMIN" ? {} : { reporterId: row.reporter_user_id, transactionReference: row.transaction_reference, notes: row.notes }),
  };
}

const REPORT_QUERY = `SELECT p.*, m.campaign_id, m.title AS milestone_title, c.title AS campaign_title
  FROM payment_reports p JOIN milestones m ON m.id = p.milestone_id JOIN campaigns c ON c.id = m.campaign_id`;

export function createPaymentRepository(pool) {
  return Object.freeze({
    async listForUser(actor) {
      const access = scope(actor);
      const result = await pool.query(`${REPORT_QUERY} WHERE ${access.sql} ORDER BY p.created_at DESC, p.id ASC`, access.parameters);
      return result.rows.map((row) => project(row, actor.role));
    },

    async listEligibleMilestones(actor) {
      if (actor?.role !== "FUNDER") return [];
      const result = await pool.query(
        `SELECT m.id, m.title, m.campaign_id, m.budget_amount, m.currency, c.title AS campaign_title
         FROM milestones m JOIN campaigns c ON c.id = m.campaign_id
         WHERE c.funder_id = $1 AND c.status IN ('ACTIVE', 'COMPLETED') AND m.status <> 'CANCELLED'
           AND EXISTS (SELECT 1 FROM evidence e JOIN verifications v ON v.evidence_id = e.id
                       WHERE e.milestone_id = m.id AND e.status <> 'SUPERSEDED' AND v.status = 'VERIFIED')
         ORDER BY c.title ASC, m.order_index ASC`, [actor.id],
      );
      const eligible = [];
      for (const row of result.rows) {
        const reports = await pool.query("SELECT reported_amount FROM payment_reports WHERE milestone_id = $1", [row.id]);
        const remaining = units(row.budget_amount) - reports.rows.reduce((sum, report) => sum + units(report.reported_amount), 0n);
        if (remaining > 0n) eligible.push({
          milestoneId: row.id, title: row.title, campaignId: row.campaign_id, campaignTitle: row.campaign_title,
          currency: row.currency, remainingAmount: decimal(remaining),
        });
      }
      return eligible;
    },

    async createReport({ actor, milestoneId, requestId, reportedAmount, currency, paidAt, transactionReference, notes = "", now = new Date() }) {
      if (actor?.role !== "FUNDER") throw failure("FORBIDDEN");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const context = await client.query(
          `SELECT m.id, m.budget_amount, m.currency, m.status, c.status AS campaign_status
           FROM milestones m JOIN campaigns c ON c.id = m.campaign_id
           WHERE m.id = $1 AND c.funder_id = $2 FOR UPDATE OF m`, [milestoneId, actor.id],
        );
        if (!context.rowCount) throw failure("MILESTONE_NOT_FOUND");
        const previous = await client.query(`${REPORT_QUERY} WHERE p.reporter_user_id = $1 AND p.request_id = $2`, [actor.id, requestId]);
        if (previous.rowCount) {
          const row = previous.rows[0];
          if (row.milestone_id !== milestoneId || units(row.reported_amount) !== units(reportedAmount) || row.currency !== currency
              || date(row.paid_at) !== paidAt || row.transaction_reference !== transactionReference || row.notes !== notes) {
            throw failure("PAYMENT_REQUEST_CONFLICT");
          }
          await client.query("COMMIT");
          return { report: project(row, actor.role), created: false };
        }
        const milestone = context.rows[0];
        if (!["ACTIVE", "COMPLETED"].includes(milestone.campaign_status) || milestone.status === "CANCELLED") throw failure("PAYMENT_NOT_READY");
        if (currency !== milestone.currency) throw failure("CURRENCY_MISMATCH");
        const verified = await client.query(
          `SELECT e.id FROM evidence e JOIN verifications v ON v.evidence_id = e.id
           WHERE e.milestone_id = $1 AND e.status <> 'SUPERSEDED' AND v.status = 'VERIFIED' LIMIT 1`, [milestoneId],
        );
        if (!verified.rowCount) throw failure("PAYMENT_NOT_READY");
        const existing = await client.query("SELECT reported_amount FROM payment_reports WHERE milestone_id = $1", [milestoneId]);
        const total = existing.rows.reduce((sum, row) => sum + units(row.reported_amount), 0n);
        if (units(reportedAmount) <= 0n || total + units(reportedAmount) > units(milestone.budget_amount)) throw failure("PAYMENT_BUDGET_EXCEEDED");
        const id = randomUUID();
        await client.query(
          `INSERT INTO payment_reports (id, milestone_id, reporter_user_id, request_id, reported_amount, currency, paid_at, transaction_reference, notes, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, milestoneId, actor.id, requestId, reportedAmount, currency, paidAt, transactionReference, notes, now],
        );
        await client.query(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, details, created_at)
           VALUES ($1, $2, 'PAYMENT_REPORTED', 'PAYMENT_REPORT', $3, $4, $5)`,
          [randomUUID(), actor.id, id, { milestoneId, status: "PAYMENT_REPORTED" }, now],
        );
        const saved = await client.query(`${REPORT_QUERY} WHERE p.id = $1`, [id]);
        await client.query("COMMIT");
        return { report: project(saved.rows[0], actor.role), created: true };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* Preserve original error. */ }
        throw error;
      } finally { client.release(); }
    },
  });
}
