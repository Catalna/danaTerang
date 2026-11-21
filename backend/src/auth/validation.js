const ORGANIZATION_TYPES = new Set(["NGO", "COMPANY", "GOVERNMENT", "COMMUNITY", "OTHER"]);
const ASSIGNABLE_ROLES = new Set(["ORGANIZER", "FUNDER", "VERIFIER", "BENEFICIARY"]);
const PUBLIC_REGISTRATION_ROLES = new Set(["ORGANIZER", "FUNDER"]);
const REGISTRATION_ACCOUNT_TYPES = new Set(["INDIVIDUAL", "ORGANIZATION"]);
// Bump this version whenever the published Terms & Conditions text changes;
// every acceptance is recorded with this version for audit purposes.
export const TERMS_VERSION = "2026-10-07-funder-terms-v1";
const CURRENCIES = new Set(Intl.supportedValuesOf("currency"));
const FUNDING_MODES = new Set(["EXTERNAL_TRACKING"]);
const CAMPAIGN_STATUSES = new Set(["DRAFT", "ACTIVE", "COMPLETED", "CANCELLED"]);
const MILESTONE_STATUSES = new Set(["PLANNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]);
const CAUSE_CATEGORIES = new Set(["DISASTER_RELIEF", "EDUCATION", "HEALTH", "COMMUNITY", "OTHER"]);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactlyKeys(value, expected) {
  return isPlainObject(value)
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value, allowed) {
  return isPlainObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isPositiveDecimal(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/.test(value)) return false;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")) > 0n;
}

function parseCurrency(value) {
  if (typeof value !== "string") return null;
  const currency = value.toUpperCase();
  return CURRENCIES.has(currency) ? currency : null;
}

export function parseRegistration(value) {
  const required = ["name", "email", "password", "role", "accountType", "acceptedTermsVersion"];
  const allowed = [...required, "organizationName", "organizationType"];
  if (!hasOnlyKeys(value, allowed) || !required.every((key) => Object.hasOwn(value, key))) return null;
  if (typeof value.name !== "string" || typeof value.email !== "string") return null;
  if (typeof value.password !== "string") return null;
  if (value.acceptedTermsVersion !== TERMS_VERSION) return null;
  if (!PUBLIC_REGISTRATION_ROLES.has(value.role) || !REGISTRATION_ACCOUNT_TYPES.has(value.accountType)) return null;
  if (value.role === "ORGANIZER" && value.accountType !== "ORGANIZATION") return null;

  const name = value.name.trim();
  const email = value.email.trim().toLowerCase();
  if (name.length < 1 || name.length > 160) return null;
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return null;
  if (value.password.length < 12 || value.password.length > 128) return null;

  let organizationName = null;
  let organizationType = null;
  if (value.accountType === "ORGANIZATION") {
    if (typeof value.organizationName !== "string" || !ORGANIZATION_TYPES.has(value.organizationType)) return null;
    organizationName = value.organizationName.trim();
    organizationType = value.organizationType;
    if (organizationName.length < 2 || organizationName.length > 180) return null;
  } else if (value.role !== "FUNDER" || Object.hasOwn(value, "organizationName") || Object.hasOwn(value, "organizationType")) {
    return null;
  }

  return {
    name,
    email,
    password: value.password,
    role: value.role,
    accountType: value.accountType,
    organizationName,
    organizationType,
    acceptedTermsVersion: TERMS_VERSION,
  };
}

function isIsoTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

export function parseWalletBind(value) {
  if (!isPlainObject(value)) return null;
  if (!hasExactlyKeys(value, ["signature", "walletAddress"])) return null;
  if (typeof value.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(value.signature)) return null;
  if (typeof value.walletAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value.walletAddress)) return null;
  return { signature: value.signature, walletAddress: value.walletAddress };
}

export function parseFundingActivation(value) {
  if (!isPlainObject(value)) return null;
  if (!hasExactlyKeys(value, ["signature", "walletAddress"])) return null;
  if (typeof value.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(value.signature)) return null;
  if (typeof value.walletAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value.walletAddress)) return null;
  return { signature: value.signature, walletAddress: value.walletAddress };
}

export function parseOrganizationVerification(value) {
  if (!hasExactlyKeys(value, ["verified"]) || typeof value.verified !== "boolean") return null;
  return { verified: value.verified };
}

export function parseCampaignPublication(value) {
  if (!hasExactlyKeys(value, ["published"]) || typeof value.published !== "boolean") return null;
  return { published: value.published };
}

export function parseLogin(value) {
  if (!hasExactlyKeys(value, ["email", "password"])) return null;
  if (typeof value.email !== "string" || typeof value.password !== "string") return null;
  const email = value.email.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return null;
  if (value.password.length < 12 || value.password.length > 128) return null;
  return { email, password: value.password };
}

export function parseRoleUpdate(value) {
  if (!hasExactlyKeys(value, ["role"]) || !ASSIGNABLE_ROLES.has(value.role)) return null;
  return { role: value.role };
}

export function parseCampaignCreate(value) {
  const allowed = ["funderId", "title", "description", "totalBudget", "currency", "fundingMode", "startDate", "endDate", "fundraisingCloseAt", "causeCategory"];
  if (!hasOnlyKeys(value, allowed) || !["title", "totalBudget", "currency"].every((key) => Object.hasOwn(value, key))) return null;
  if (Object.hasOwn(value, "funderId") && value.funderId !== null && !isUserId(value.funderId)) return null;
  const legacyFundedCampaign = isUserId(value.funderId);
  if (!legacyFundedCampaign && !isIsoTimestamp(value.fundraisingCloseAt)) return null;
  if (typeof value.title !== "string" || typeof value.description !== "undefined" && typeof value.description !== "string") return null;
  const title = value.title.trim();
  const description = (value.description ?? "").trim();
  const currency = parseCurrency(value.currency);
  const fundingMode = value.fundingMode ?? "EXTERNAL_TRACKING";
  const causeCategory = value.causeCategory ?? "OTHER";
  if (title.length < 3 || title.length > 160 || description.length > 4000) return null;
  if (!isPositiveDecimal(value.totalBudget) || !currency || !FUNDING_MODES.has(fundingMode)) return null;
  if (!CAUSE_CATEGORIES.has(causeCategory)) return null;
  if (!legacyFundedCampaign && currency !== "IDR") return null;
  if (value.startDate !== undefined && !isIsoDate(value.startDate)) return null;
  if (value.endDate !== undefined && !isIsoDate(value.endDate)) return null;
  if (value.startDate && value.endDate && value.endDate < value.startDate) return null;
  return {
    funderId: legacyFundedCampaign ? value.funderId : null,
    title,
    description,
    totalBudget: value.totalBudget,
    currency,
    fundingMode,
    causeCategory,
    startDate: value.startDate ?? null,
    endDate: value.endDate ?? null,
    fundraisingCloseAt: legacyFundedCampaign ? null : new Date(value.fundraisingCloseAt).toISOString(),
  };
}

export function parseCampaignTermsSignature(value) {
  if (!isPlainObject(value) || !hasExactlyKeys(value, ["signature", "walletAddress"])) return null;
  if (typeof value.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(value.signature)) return null;
  if (typeof value.walletAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value.walletAddress)) return null;
  return { signature: value.signature, walletAddress: value.walletAddress };
}

export function parseCampaignUpdate(value) {
  const allowed = ["title", "description", "totalBudget", "currency", "startDate", "endDate", "fundraisingCloseAt", "causeCategory"];
  if (!hasOnlyKeys(value, allowed) || Object.keys(value).length === 0) return null;
  if (value.title !== undefined && (typeof value.title !== "string" || value.title.trim().length < 3 || value.title.trim().length > 160)) return null;
  if (value.description !== undefined && (typeof value.description !== "string" || value.description.trim().length > 4000)) return null;
  if (value.totalBudget !== undefined && !isPositiveDecimal(value.totalBudget)) return null;
  if (value.currency !== undefined && !parseCurrency(value.currency)) return null;
  if (value.causeCategory !== undefined && !CAUSE_CATEGORIES.has(value.causeCategory)) return null;
  if (value.startDate !== undefined && value.startDate !== null && !isIsoDate(value.startDate)) return null;
  if (value.endDate !== undefined && value.endDate !== null && !isIsoDate(value.endDate)) return null;
  if (value.fundraisingCloseAt !== undefined && value.fundraisingCloseAt !== null && !isIsoTimestamp(value.fundraisingCloseAt)) return null;
  if (value.startDate && value.endDate && value.endDate < value.startDate) return null;
  return {
    ...value,
    ...(value.title === undefined ? {} : { title: value.title.trim() }),
    ...(value.description === undefined ? {} : { description: value.description.trim() }),
    ...(value.currency === undefined ? {} : { currency: parseCurrency(value.currency) }),
    ...(value.fundraisingCloseAt === undefined ? {} : { fundraisingCloseAt: value.fundraisingCloseAt === null ? null : new Date(value.fundraisingCloseAt).toISOString() }),
  };
}

export function parseDonationCheckout(value) {
  if (!hasExactlyKeys(value, ["amount", "idempotencyKey", "reallocationPolicy", "returnUrl"])) return null;
  if (!isPositiveDecimal(value.amount) || !isUserId(value.idempotencyKey)) return null;
  if (!["REDIRECT_RELATED", "REFUND"].includes(value.reallocationPolicy)) return null;
  if (typeof value.returnUrl !== "string" || value.returnUrl.length > 2048) return null;
  try {
    const url = new URL(value.returnUrl);
    if (!new Set(["http:", "https:"]).has(url.protocol)) return null;
  } catch {
    return null;
  }
  return {
    amount: value.amount,
    idempotencyKey: value.idempotencyKey,
    reallocationPolicy: value.reallocationPolicy,
    returnUrl: value.returnUrl,
  };
}

export function parseSurplusTransfer(value) {
  if (!hasExactlyKeys(value, ["destinationCampaignId", "amount", "reason"])) return null;
  if (!isUserId(value.destinationCampaignId) || !isPositiveDecimal(value.amount)) return null;
  if (typeof value.reason !== "string" || value.reason.trim().length < 5 || value.reason.trim().length > 1000) return null;
  return { destinationCampaignId: value.destinationCampaignId, amount: value.amount, reason: value.reason.trim() };
}

export function parsePayoutRecipientUpdate(value) {
  if (!hasExactlyKeys(value, ["provider", "providerRecipientId"])) return null;
  if (typeof value.provider !== "string" || !/^[a-z0-9_-]{2,40}$/i.test(value.provider)) return null;
  if (typeof value.providerRecipientId !== "string" || value.providerRecipientId.trim().length < 1 || value.providerRecipientId.trim().length > 200) return null;
  return { provider: value.provider.toLowerCase(), providerRecipientId: value.providerRecipientId.trim() };
}

export function parseMilestoneDisbursement(value) {
  if (!hasExactlyKeys(value, ["amount", "idempotencyKey"])) return null;
  if (!isPositiveDecimal(value.amount) || !isUserId(value.idempotencyKey)) return null;
  return { amount: value.amount, idempotencyKey: value.idempotencyKey };
}

export function parseMilestoneCreate(value) {
  const allowed = ["title", "description", "budgetAmount", "currency", "orderIndex", "startDate", "dueDate"];
  if (!hasOnlyKeys(value, allowed) || !["title", "budgetAmount", "currency", "orderIndex"].every((key) => Object.hasOwn(value, key))) return null;
  if (typeof value.title !== "string" || (value.description !== undefined && typeof value.description !== "string")) return null;
  const title = value.title.trim();
  const description = (value.description ?? "").trim();
  const currency = parseCurrency(value.currency);
  if (title.length < 3 || title.length > 160 || description.length > 4000) return null;
  if (!isPositiveDecimal(value.budgetAmount) || !currency || !Number.isSafeInteger(value.orderIndex) || value.orderIndex < 0) return null;
  if (value.startDate !== undefined && value.startDate !== null && !isIsoDate(value.startDate)) return null;
  if (value.dueDate !== undefined && value.dueDate !== null && !isIsoDate(value.dueDate)) return null;
  if (value.startDate && value.dueDate && value.dueDate < value.startDate) return null;
  return { ...value, title, description, currency };
}

export function parseMilestoneStatus(value) {
  if (!hasExactlyKeys(value, ["status"]) || !MILESTONE_STATUSES.has(value.status)) return null;
  return { status: value.status };
}

export function parsePaymentReport(value) {
  const required = ["requestId", "reportedAmount", "currency", "paidAt", "transactionReference"];
  if (!hasOnlyKeys(value, [...required, "notes"]) || !required.every((key) => Object.hasOwn(value, key))) return null;
  if (!isUserId(value.requestId) || !isPositiveDecimal(value.reportedAmount) || !parseCurrency(value.currency)) return null;
  if (!isIsoDate(value.paidAt) || value.paidAt > new Date().toISOString().slice(0, 10)) return null;
  if (typeof value.transactionReference !== "string" || !value.transactionReference.trim() || value.transactionReference.trim().length > 200) return null;
  if (value.notes !== undefined && (typeof value.notes !== "string" || value.notes.trim().length > 2000)) return null;
  return { ...value, currency: parseCurrency(value.currency), transactionReference: value.transactionReference.trim(), notes: (value.notes ?? "").trim() };
}

export function isUserId(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
