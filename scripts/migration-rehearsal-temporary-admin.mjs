// VAY-1361 approved temporary Identity-owned rehearsal boundary, not provisioning.
import { createHash as identityHash } from "node:crypto";
import { createRequire } from "node:module";
import { binding, guardedConnection, requireTrue } from "./migration-rehearsal-reader-contract.mjs";
import { applicationEnvironment, captureRows, captureRowsSnapshot, runReadOnlyApplication } from "./migration-rehearsal-app-readonly.mjs";

export const temporaryAdmin = {
  users: "21630265-3a7f-40f6-9569-cd06016bedac",
  external_identities: "6c1428fb-16ba-468f-943e-d8a12d29b092",
  organizations: "c75d2566-7488-4c48-8573-ba5f13208372",
  organization_memberships: "2c8f1198-694d-476a-81e3-7546c2ac3aa6",
  organization_resource_links: "a6ee4a9b-f579-4c0a-b688-8e3461506f4a",
};
const originalData = "d5c52a18f986911c1c33656eaad48e2ed0e154448c5874664599f625395e357b";
const testEmail = "f.maliqi+codex-admin@vayada.com";
const testSlug = "vay1361-27ba9106-temporary-admin";
const hashIdentity = value => identityHash("sha256").update(value).digest("hex");
// Exact read-only constraint trigger and its transitive function from release 0105.
export const identityTriggerSql = `SELECT
  (SELECT jsonb_agg(jsonb_build_object('table',tgrelid::regclass::text,'name',tgname,'enabled',tgenabled,
    'definition',pg_get_triggerdef(oid,false)) ORDER BY tgrelid::regclass::text,tgname)
    FROM pg_trigger WHERE NOT tgisinternal AND tgrelid=ANY($1::regclass[])) AS triggers,
  (SELECT jsonb_agg(pg_get_functiondef(oid) ORDER BY proname) FROM pg_proc
    WHERE oid=ANY(ARRAY['identity.enforce_membership_delegation_from_membership()'::regprocedure,
      'identity.assert_membership_delegation_integrity(uuid)'::regprocedure])) AS functions`;

export function verifyAdminSession(session, now = Date.now()) {
  requireTrue(typeof session.workosUserId === "string" && typeof session.workosOrgId === "string"
    && hashIdentity(session.workosUserId) === "1db71651043667105f6c270e800029bba9fdc7161fdbcb1c528a86db21e76c2b"
    && hashIdentity(session.workosOrgId) === "0222289cdc132448e75e88f11cdaf10e74206e4f45b47a0ec46ca120f206fa62", "TEST_ADMIN_SUBJECT");
  requireTrue(Number.isSafeInteger(session.expiresAt) && session.expiresAt * 1000 > now + 180000
    && session.expiresAt * 1000 <= now + 300000, "TEST_SESSION_WINDOW");
}

async function lockIdentity(client) {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  await client.query("SELECT pg_advisory_xact_lock(1361,1361)");
  await client.query(`LOCK TABLE ${Object.keys(temporaryAdmin).map(name => 'identity.' + name).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
}

async function deleteTestRows(client) {
  for (const name of ["organization_resource_links", "organization_memberships", "external_identities", "organizations", "users"])
    requireTrue((await client.query(`DELETE FROM identity.${name} WHERE id=$1`, [temporaryAdmin[name]])).rowCount === 1, "TEST_CLEANUP_ROW_COUNT");
}

async function verifyIdentityTriggers(client) {
  const tables = Object.keys(temporaryAdmin).map(name => "identity." + name);
  requireTrue(hashIdentity(JSON.stringify((await client.query(identityTriggerSql, [tables])).rows[0])) ===
    "0c4a4faa097a7c43cdcd22fc1929befd4944e6976fc48367762265bb5e75666c", "IDENTITY_TRIGGER_DRIFT");
}

export async function installTemporaryAdmin(client, session) {
  await lockIdentity(client);
  try {
    requireTrue((await captureRowsSnapshot(client)).sha256 === originalData, "MIGRATED_ROWS_CHANGED");
    await verifyIdentityTriggers(client);
    for (const [name, id] of Object.entries(temporaryAdmin))
      requireTrue((await client.query(`SELECT count(*)::int AS count FROM identity.${name} WHERE id=$1`, [id])).rows[0]?.count === 0, "TEST_ID_COLLISION");
    const { rows: [collision] } = await client.query(`SELECT
      EXISTS(SELECT 1 FROM identity.users WHERE lower(email)=$1) OR
      EXISTS(SELECT 1 FROM identity.external_identities WHERE provider_user_id=$2 OR lower(provider_email)=$1) OR
      EXISTS(SELECT 1 FROM identity.organizations WHERE workos_org_id=$3 OR slug=$4) AS found`,
      [testEmail, session.workosUserId, session.workosOrgId, testSlug]);
    requireTrue(collision?.found === false, "TEST_IDENTITY_COLLISION");
    requireTrue((await client.query(`SELECT EXISTS(SELECT 1 FROM identity.role_permission_grants
      WHERE organization_kind='platform' AND role_key='platform_admin' AND permission_key='platform.user.suspend') AS present,
      EXISTS(SELECT 1 FROM identity.role_permission_grants WHERE organization_kind='platform' AND role_key='vay1361_no_grants') AS denied_role`)).rows
      .some(row => row.present === true && row.denied_role === false), "EXISTING_PERMISSION_CONTRACT");
    await client.query("INSERT INTO identity.users (id,email,name,status) VALUES ($1,$2,'VAY-1361 temporary test admin','active')", [temporaryAdmin.users, testEmail]);
    await client.query(`INSERT INTO identity.external_identities (id,user_id,provider,provider_user_id,provider_email,raw_profile)
      VALUES ($1,$2,'workos',$3,$4,$5::jsonb)`, [temporaryAdmin.external_identities, temporaryAdmin.users, session.workosUserId, testEmail, JSON.stringify({ rehearsalRunId: binding.runId, temporary: true })]);
    await client.query(`INSERT INTO identity.organizations (id,kind,name,slug,status,workos_org_id)
      VALUES ($1,'platform','VAY-1361 temporary test organization',$2,'active',$3)`, [temporaryAdmin.organizations, testSlug, session.workosOrgId]);
    await client.query(`INSERT INTO identity.organization_memberships (id,organization_id,user_id,status,role_key,property_access_mode,access_origin)
      VALUES ($1,$2,$3,'active','platform_admin','assigned','agency')`, [temporaryAdmin.organization_memberships, temporaryAdmin.organizations, temporaryAdmin.users]);
    await client.query(`INSERT INTO identity.organization_resource_links (id,organization_id,product,resource_type,resource_id,relationship,status)
      VALUES ($1,$2,'platform','platform','vayada','operator','active')`, [temporaryAdmin.organization_resource_links, temporaryAdmin.organizations]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    const installed = await captureRowsSnapshot(client);
    requireTrue(installed.tables === 210 && installed.rows === 449384, "TEMPORARY_ROW_DELTA");
    // Prove before commit that deleting only these five rows restores the exact data.
    await client.query("SAVEPOINT cleanup_probe");
    await deleteTestRows(client);
    requireTrue((await captureRowsSnapshot(client)).sha256 === originalData, "TEST_INSERT_SIDE_EFFECT");
    await client.query("ROLLBACK TO SAVEPOINT cleanup_probe");
    console.log(JSON.stringify({ status: "TEMPORARY_ADMIN_PREPARED", runId: binding.runId, temporaryDataSha256: installed.sha256, committed: false }));
    await client.query("COMMIT");
    return installed.sha256;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

export async function removeTemporaryAdmin(client, expectedHash) {
  requireTrue(/^[a-f0-9]{64}$/.test(expectedHash ?? "") && expectedHash !== originalData, "EXPECTED_TEST_HASH");
  await lockIdentity(client);
  try {
    await verifyIdentityTriggers(client);
    requireTrue((await captureRowsSnapshot(client)).sha256 === expectedHash, "TEST_OR_MIGRATED_DATA_DRIFT");
    await deleteTestRows(client);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    requireTrue((await captureRowsSnapshot(client)).sha256 === originalData, "CLEANUP_DATA_MISMATCH");
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

export async function checkAdminRoutes(get, reader, admin, token, session) {
  const headers = { authorization: "Bearer " + token };
  const request = async (id, status) => {
    requireTrue(session.expiresAt * 1000 > Date.now() + 10000, "TEST_TOKEN_EXPIRED");
    const response = await get("/api/identity/admin/users/" + id, headers);
    requireTrue(response.status === status, "ADMIN_ROUTE_STATUS_" + status);
    const body = await response.json();
    if (status !== 200) requireTrue(!body.id && !body.email && !body.users && !body.profile, "DENIED_DATA_DISCLOSURE");
    return body;
  };
  const self = await request(temporaryAdmin.users, 200);
  requireTrue(self.id === temporaryAdmin.users && self.email === testEmail, "ADMIN_SELF_MISMATCH");
  const migrated = (await reader.query("SELECT id,email FROM identity.users WHERE id<>$1 ORDER BY id LIMIT 1", [temporaryAdmin.users])).rows[0];
  requireTrue(migrated, "NO_MIGRATED_IDENTITY_SAMPLE");
  const actual = await request(migrated.id, 200);
  requireTrue(actual.id === migrated.id && actual.email === migrated.email, "MIGRATED_IDENTITY_READ_MISMATCH");
  for (const [table, column, denied, restored, status] of [
    ["organization_memberships", "role_key", "vay1361_no_grants", "platform_admin", 403],
    ["organization_memberships", "status", "inactive", "active", 401],
    ["organization_resource_links", "status", "archived", "active", 403],
  ]) {
    const change = async value => requireTrue((await admin.query(`UPDATE identity.${table} SET ${column}=$1 WHERE id=$2`, [value, temporaryAdmin[table]])).rowCount === 1, "TEMPORARY_STATE_COUNT");
    await change(denied);
    try { await request(temporaryAdmin.users, status); }
    finally { await change(restored); }
  }
  await request(temporaryAdmin.users, 200);
  return ["admin-self", "migrated-identity-read", "missing-permission", "inactive-membership", "missing-platform-link", "restored-access"];
}

export const domainImpactSampleSql = `WITH candidates AS (
  SELECT property.id::text AS "propertyId", property.lifecycle_status AS "lifecycleStatus",
    property.lifecycle_revision::int AS "lifecycleRevision",
    (SELECT count(DISTINCT link.organization_id)::int FROM identity.organization_resource_links link
      WHERE link.resource_id=property.id::text AND link.status<>'archived') AS "linkedOrganizations",
    (SELECT count(*)::int FROM identity.product_entitlements entitlement
      WHERE entitlement.organization_id IN (SELECT link.organization_id FROM identity.organization_resource_links link
        WHERE link.resource_id=property.id::text AND link.status<>'archived')
      AND (entitlement.resource_id IS NULL OR entitlement.resource_id=property.id::text)
      AND entitlement.status='active') AS "activeEntitlements",
    (SELECT count(*)::int FROM identity.product_entitlements entitlement
      WHERE entitlement.organization_id IN (SELECT link.organization_id FROM identity.organization_resource_links link
        WHERE link.resource_id=property.id::text AND link.status<>'archived')
      AND (entitlement.resource_id IS NULL OR entitlement.resource_id=property.id::text)
      AND entitlement.status='suspended') AS "suspendedEntitlements",
    (SELECT count(*)::int FROM booking.guest_bookings booking WHERE booking.property_id=property.id) AS "totalBookings",
    (SELECT count(*)::int FROM booking.guest_bookings booking WHERE booking.property_id=property.id
      AND booking.lifecycle_status IN ('draft','pending_payment','confirmed')) AS "activeBookings",
    (SELECT count(*)::int FROM pms.room_types room_type WHERE room_type.property_id=property.id) AS "roomTypes",
    (SELECT count(*)::int FROM pms.rooms room WHERE room.property_id=property.id) AS rooms,
    (SELECT count(*)::int FROM finance.payments payment WHERE payment.property_id=property.id) AS "totalPayments",
    (SELECT count(*)::int FROM finance.payments payment WHERE payment.property_id=property.id
      AND payment.status IN ('requires_action','authorized','pending','disputed')) AS "unresolvedPayments",
    (SELECT count(*)::int FROM finance.payouts payout
      WHERE payout.property_id=property.id OR payout.related_property_id=property.id) AS "totalPayouts",
    (SELECT count(*)::int FROM finance.payouts payout
      WHERE (payout.property_id=property.id OR payout.related_property_id=property.id)
      AND payout.payout_status IN ('pending','scheduled','processing','failed')) AS "openPayouts",
    (SELECT count(*)::int FROM finance.billing_entitlements billing WHERE billing.property_id=property.id) AS "billingEntitlements",
    (SELECT count(*)::int FROM platform.media_objects media
      WHERE media.property_id=property.id AND media.lifecycle_status<>'deleted') AS "mediaObjects",
    EXISTS(SELECT 1 FROM marketplace.active_hotel_submission_revisions marketplace
      WHERE marketplace.property_id=property.id AND marketplace.activation_status='active')
      OR EXISTS(SELECT 1 FROM marketplace.marketplace_offer_read_model offer
        WHERE offer.property_id=property.id AND offer.visibility_status='public') AS "marketplaceActive",
    (SELECT profile.profile_status FROM distribution.public_hotel_bookability_profiles profile
      WHERE profile.property_id=property.id) AS "distributionStatus",
    EXISTS(SELECT 1 FROM distribution.active_public_booking_revision revision
      WHERE revision.property_id=property.id) AS "bookingRevisionActive",
    (SELECT count(*)::int FROM pms.channel_connections connection
      WHERE connection.property_id=property.id AND connection.connection_status IN ('connected','degraded')) AS "connectedChannels"
  FROM hotel_catalog.properties property
) SELECT * FROM candidates ORDER BY
  (("totalBookings">0)::int + (("roomTypes"+rooms)>0)::int
    + (("totalPayments"+"totalPayouts"+"billingEntitlements")>0)::int
    + ("marketplaceActive" OR "distributionStatus" IS NOT NULL OR "bookingRevisionActive")::int) DESC,
  "propertyId" LIMIT 1`;

export const bookingOracleSql = `WITH booking_rows AS (
  SELECT booking.id::text AS id, booking.public_reference AS "bookingReference",
    property.id::text AS "hotelId", property.display_name AS "hotelName",
    COALESCE(slug.slug,property.public_id) AS "hotelSlug",
    COALESCE(NULLIF(concat_ws(' ',booker.first_name,booker.last_name),''),'Guest') AS "guestName",
    COALESCE(booker.email,'') AS "guestEmail", booking.check_in::text AS "checkIn",
    booking.check_out::text AS "checkOut", GREATEST(booking.check_out-booking.check_in,1) AS nights,
    booking.total_amount::text AS "totalAmount", booking.currency,
    CASE WHEN booking.lifecycle_status IN ('draft','pending_payment') THEN 'pending'
      WHEN booking.lifecycle_status IN ('confirmed','completed','no_show') THEN 'accepted'
      WHEN booking.lifecycle_status='canceled' THEN 'withdrawn' ELSE 'rejected' END AS status,
    booking.lifecycle_status AS "rawStatus",
    COALESCE(NULLIF(booking.booking_metadata->>'channel',''),NULLIF(booking.source_system,''),'direct') AS channel,
    booking.created_at AS "requestedAt",
    CASE WHEN booking.lifecycle_status IN ('draft','pending_payment') THEN NULL
      ELSE COALESCE(latest_status.occurred_at,booking.updated_at) END AS "respondedAt"
  FROM booking.guest_bookings booking JOIN hotel_catalog.properties property ON property.id=booking.property_id
  LEFT JOIN LATERAL (SELECT property_slug.slug FROM hotel_catalog.property_slugs property_slug
    WHERE property_slug.property_id=property.id AND property_slug.purpose='canonical' AND property_slug.status='active'
    ORDER BY property_slug.created_at DESC,property_slug.id LIMIT 1) slug ON TRUE
  LEFT JOIN LATERAL (SELECT guest.first_name,guest.last_name,guest.email FROM booking.booking_guests guest
    WHERE guest.guest_booking_id=booking.id ORDER BY CASE guest.guest_role WHEN 'booker' THEN 0
      WHEN 'primary_guest' THEN 1 ELSE 2 END,guest.created_at,guest.id LIMIT 1) booker ON TRUE
  LEFT JOIN LATERAL (SELECT event.occurred_at FROM booking.booking_status_events event
    WHERE event.guest_booking_id=booking.id ORDER BY event.occurred_at DESC,event.id LIMIT 1) latest_status ON TRUE
) SELECT * FROM booking_rows ORDER BY "requestedAt" DESC,id LIMIT 2 OFFSET 0`;

export const collaborationOracleSql = `SELECT collaboration.id::text AS "collaborationId",
  offer.id::text AS "offerId",creator.id::text AS "creatorId",profile.property_id::text AS "hotelProfileId",
  creator.id::text AS "creatorProfileId",creator.organization_id::text AS "creatorOrganizationId",
  offer.organization_id::text AS "hotelOrganizationId",collaboration.initiator_type AS "initiatorSide",
  collaboration.lifecycle_status AS status,collaboration.compensation_type AS "compensationType",
  offer.title AS "offerTitle",NULLIF(concat_ws(', ',NULLIF(public_profile.location->>'city',''),
    NULLIF(public_profile.location->>'region',''),NULLIF(public_profile.location->>'countryCode','')),'') AS "hotelLocation",
  creator.display_name AS "creatorName",creator.profile_picture_url AS "creatorAvatarUrl",
  COALESCE(public_profile.display_name,property.display_name) AS "hotelName",
  collaboration.free_stay_min_nights AS "freeStayMinNights",collaboration.free_stay_max_nights AS "freeStayMaxNights",
  collaboration.paid_amount AS "paidAmount",collaboration.currency,collaboration.discount_percentage AS "discountPercentage",
  collaboration.affiliate_enabled AS "affiliateEnabled",
  collaboration.affiliate_commission_percentage AS "affiliateCommissionPercentage",
  collaboration.travel_date_from AS "travelDateFrom",collaboration.travel_date_to AS "travelDateTo",
  collaboration.preferred_date_from AS "preferredDateFrom",collaboration.preferred_date_to AS "preferredDateTo",
  collaboration.preferred_months AS "preferredMonths",COALESCE(deliverables.items,'[]'::jsonb) AS deliverables,
  messages.last_message_at AS "lastMessageAt",collaboration.application_message AS "applicationMessage",
  collaboration.hotel_agreed_at AS "hotelAgreedAt",collaboration.creator_agreed_at AS "creatorAgreedAt",
  collaboration.completed_at AS "completedAt",collaboration.cancelled_at AS "cancelledAt",
  collaboration.created_at AS "createdAt",collaboration.updated_at AS "updatedAt"
FROM marketplace.collaborations collaboration
JOIN marketplace.creator_profiles creator ON creator.id=collaboration.creator_profile_id
  AND creator.organization_id=collaboration.creator_organization_id
JOIN marketplace.marketplace_offers offer ON offer.id=collaboration.offer_id
  AND offer.property_id=collaboration.property_id AND offer.organization_id=collaboration.hotel_organization_id
JOIN marketplace.marketplace_hotel_profiles profile ON profile.property_id=offer.property_id
  AND profile.organization_id=offer.organization_id
JOIN hotel_catalog.properties property ON property.id=offer.property_id
LEFT JOIN hotel_catalog.property_public_profile_read_model public_profile ON public_profile.property_id=offer.property_id
LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('deliverableId',deliverable.id::text,
  'platform',deliverable.platform,'type',deliverable.deliverable_type,'quantity',deliverable.quantity,
  'status',deliverable.deliverable_status,'completedAt',deliverable.completed_at)
  ORDER BY deliverable.created_at,deliverable.id) AS items FROM marketplace.collaboration_deliverables deliverable
  WHERE deliverable.collaboration_id=collaboration.id AND deliverable.property_id=collaboration.property_id) deliverables ON TRUE
LEFT JOIN LATERAL (SELECT max(created_at) AS last_message_at FROM marketplace.marketplace_chat_messages message
  WHERE message.collaboration_id=collaboration.id AND message.property_id=collaboration.property_id) messages ON TRUE
ORDER BY collaboration.created_at DESC,collaboration.id ASC LIMIT 2 OFFSET 0`;

export const collaborationCountSql = `SELECT count(*)::int AS total FROM marketplace.collaborations collaboration
JOIN marketplace.creator_profiles creator ON creator.id=collaboration.creator_profile_id
  AND creator.organization_id=collaboration.creator_organization_id
JOIN marketplace.marketplace_offers offer ON offer.id=collaboration.offer_id
  AND offer.property_id=collaboration.property_id AND offer.organization_id=collaboration.hotel_organization_id
JOIN marketplace.marketplace_hotel_profiles profile ON profile.property_id=offer.property_id
  AND profile.organization_id=offer.organization_id
JOIN hotel_catalog.properties property ON property.id=offer.property_id
LEFT JOIN hotel_catalog.property_public_profile_read_model public_profile ON public_profile.property_id=offer.property_id`;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const sameJson = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const iso = value => value instanceof Date ? value.toISOString() : value;
const nullableNumber = value => value === null || value === undefined || value === "" ? null : Number(value);
const nullableDecimal = value => value === null || value === undefined || value === "" ? null : String(value);

function expectedBooking(row) {
  return { ...row, totalAmount: Number(row.totalAmount ?? 0), requestedAt: iso(row.requestedAt),
    respondedAt: row.respondedAt ? iso(row.respondedAt) : null };
}

function expectedCollaboration(row) {
  return { contractVersion: "marketplace-collaboration-reads.v1", authorizationMode: "hotel_group_resource_link",
    collaborationId: row.collaborationId, offerId: row.offerId, creatorId: row.creatorId, hotelProfileId: row.hotelProfileId,
    side: "hotel", initiatorSide: row.initiatorSide === "hotel" ? "hotel" : "creator",
    isInitiator: row.initiatorSide === "hotel",
    status: ["pending","negotiating","accepted","active","completed","cancelled","rejected","declined"].includes(row.status)
      ? row.status : "pending",
    compensationType: ["free_stay","paid","discount","custom"].includes(row.compensationType) ? row.compensationType : null,
    offerTitle: row.offerTitle, hotelLocation: row.hotelLocation,
    creator: { side: "creator", organizationId: row.creatorOrganizationId, profileId: row.creatorProfileId,
      displayName: row.creatorName ?? "Creator", avatarUrl: row.creatorAvatarUrl },
    hotel: { side: "hotel", organizationId: row.hotelOrganizationId, profileId: row.hotelProfileId,
      displayName: row.hotelName ?? "Hotel", avatarUrl: null },
    terms: { freeStayMinNights: nullableNumber(row.freeStayMinNights), freeStayMaxNights: nullableNumber(row.freeStayMaxNights),
      paidAmount: nullableDecimal(row.paidAmount), currency: row.currency ?? null,
      discountPercentage: nullableNumber(row.discountPercentage), affiliateEnabled: row.affiliateEnabled,
      affiliateCommissionPercentage: nullableDecimal(row.affiliateCommissionPercentage),
      travelDateFrom: row.travelDateFrom ? iso(row.travelDateFrom).slice(0,10) : null,
      travelDateTo: row.travelDateTo ? iso(row.travelDateTo).slice(0,10) : null,
      preferredDateFrom: row.preferredDateFrom ? iso(row.preferredDateFrom).slice(0,10) : null,
      preferredDateTo: row.preferredDateTo ? iso(row.preferredDateTo).slice(0,10) : null,
      preferredMonths: row.preferredMonths ?? [] },
    deliverables: Array.isArray(row.deliverables) ? row.deliverables.map((item,index) => ({
      deliverableId: item.deliverableId ?? item.id ?? `deliverable_${index}`, platform: item.platform ?? "custom",
      type: item.type ?? "Custom", quantity: nullableNumber(item.quantity) ?? 1,
      status: item.status === "completed" ? "completed" : "pending",
      completedAt: item.completedAt ?? item.completed_at ? iso(item.completedAt ?? item.completed_at) : null })) : [],
    lastMessageAt: row.lastMessageAt ? iso(row.lastMessageAt) : null, applicationMessage: row.applicationMessage,
    hotelAgreedAt: row.hotelAgreedAt ? iso(row.hotelAgreedAt) : null,
    creatorAgreedAt: row.creatorAgreedAt ? iso(row.creatorAgreedAt) : null,
    completedAt: row.completedAt ? iso(row.completedAt) : null, cancelledAt: row.cancelledAt ? iso(row.cancelledAt) : null,
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}

export async function checkAuthenticatedDomainRoutes(get, reader, admin, token, session) {
  const headers = { authorization: "Bearer " + token };
  const sample = (await reader.query(domainImpactSampleSql)).rows[0];
  requireTrue(sample && sample.totalBookings > 0 && sample.roomTypes + sample.rooms > 0
    && sample.totalPayments + sample.totalPayouts + sample.billingEntitlements > 0
    && (sample.marketplaceActive || sample.distributionStatus !== null || sample.bookingRevisionActive),
  "CROSS_DOMAIN_COVERAGE_GAP");
  const paths = [`/api/platform/admin/properties/${sample.propertyId}/retirement-impact`,
    "/api/platform/admin/bookings?limit=2&offset=0", "/api/marketplace/admin/collaborations?page=1&pageSize=2"];
  const denied = async (path, deniedHeaders, status, message) => {
    const response = await get(path, deniedHeaders);
    requireTrue(response.status === status, "DOMAIN_AUTH_DENIAL_" + status);
    const body = await response.json();
    requireTrue(sameJson(body, { statusCode: status, error: status === 401 ? "Unauthorized" : "Forbidden", message }),
      "DOMAIN_AUTH_DISCLOSURE");
  };
  for (const path of paths) {
    await denied(path, {}, 401, "A valid access token is required.");
    await denied(path, { authorization: "Bearer deliberately-invalid-rehearsal-token" }, 401,
      "A valid access token is required.");
  }
  const changeRole = async role => requireTrue((await admin.query(
    "UPDATE identity.organization_memberships SET role_key=$1 WHERE id=$2", [role, temporaryAdmin.organization_memberships]
  )).rowCount === 1, "TEMPORARY_DOMAIN_ROLE_COUNT");
  await changeRole("vay1361_no_grants");
  try { for (const path of paths) await denied(path, headers, 403,
    `Missing required permission: ${path.includes("/marketplace/") ? "platform.user.suspend" : "platform.admin.read"}`); }
  finally { await changeRole("platform_admin"); }
  const request = async path => {
    requireTrue(session.expiresAt * 1000 > Date.now() + 10000, "TEST_TOKEN_EXPIRED");
    const response = await get(path, headers);
    requireTrue(response.status === 200, "DOMAIN_ROUTE_STATUS");
    const body = await response.json();
    requireTrue(body && typeof body === "object" && !body.error && !body.detail, "DOMAIN_ROUTE_BODY");
    return body;
  };
  const blockers = [
    sample.activeBookings > 0 && { code: "active_bookings", ownerDomain: "booking", count: sample.activeBookings,
      message: "Resolve active bookings." },
    sample.unresolvedPayments > 0 && { code: "unresolved_payments", ownerDomain: "finance", count: sample.unresolvedPayments,
      message: "Resolve pending or disputed payments." },
    sample.openPayouts > 0 && { code: "open_payouts", ownerDomain: "finance", count: sample.openPayouts,
      message: "Resolve open payouts." },
    sample.connectedChannels > 0 && { code: "connected_channels", ownerDomain: "pms", count: sample.connectedChannels,
      message: "Disconnect active channel-manager connections." },
  ].filter(Boolean);
  const expectedImpact = { contractVersion: "platform-property-lifecycle.v1", propertyId: sample.propertyId,
    lifecycleStatus: sample.lifecycleStatus, lifecycleRevision: sample.lifecycleRevision,
    organizations: { linked: sample.linkedOrganizations },
    entitlements: { active: sample.activeEntitlements, suspended: sample.suspendedEntitlements },
    bookings: { total: sample.totalBookings, active: sample.activeBookings },
    inventory: { roomTypes: sample.roomTypes, rooms: sample.rooms },
    finance: { totalPayments: sample.totalPayments, unresolvedPayments: sample.unresolvedPayments,
      totalPayouts: sample.totalPayouts, openPayouts: sample.openPayouts,
      billingEntitlements: sample.billingEntitlements }, media: { objects: sample.mediaObjects },
    publicExposure: { marketplaceActive: sample.marketplaceActive, distributionStatus: sample.distributionStatus,
      bookingRevisionActive: sample.bookingRevisionActive }, blockers,
    canRetire: blockers.length === 0 && sample.lifecycleStatus !== "retired",
    hardDeletion: { allowed: false, reason: "hard_delete_not_supported" } };
  requireTrue(sameJson(await request(paths[0]), expectedImpact), "CROSS_DOMAIN_RESPONSE_MISMATCH");

  const expectedBookings = (await reader.query(bookingOracleSql)).rows.map(expectedBooking);
  requireTrue(expectedBookings.length > 0 && expectedBookings.length <= 2, "NO_MIGRATED_BOOKING_SAMPLE");
  requireTrue(sameJson(await request(paths[1]), { bookings: expectedBookings }), "BOOKING_ROUTE_TARGET_MISMATCH");

  const expectedCollaborations = (await reader.query(collaborationOracleSql)).rows.map(expectedCollaboration);
  const collaborationTotal = (await reader.query(collaborationCountSql)).rows[0]?.total;
  requireTrue(expectedCollaborations.length > 0 && expectedCollaborations.length <= 2
    && Number.isSafeInteger(collaborationTotal) && collaborationTotal >= expectedCollaborations.length,
  "NO_MIGRATED_COLLABORATION_SAMPLE");
  const expectedCollaborationBody = { contractVersion: "marketplace-admin.v1",
    authorizationMode: "platform_organization_membership", collaborations: expectedCollaborations,
    pagination: { page: 1, pageSize: 2, total: collaborationTotal } };
  requireTrue(sameJson(await request(paths[2]), expectedCollaborationBody), "MARKETPLACE_ROUTE_TARGET_MISMATCH");
  return { checks: ["domain-auth-denials", "cross-domain-retirement-impact", "booking-admin-list", "marketplace-admin-list"],
    coverage: { bookings: sample.totalBookings, roomTypes: sample.roomTypes, rooms: sample.rooms,
      financeRecords: sample.totalPayments + sample.totalPayouts + sample.billingEntitlements,
      marketplaceActive: sample.marketplaceActive,
      distributionStatePresent: Boolean(sample.distributionStatus !== null || sample.bookingRevisionActive),
      mediaObjects: sample.mediaObjects, connectedChannels: sample.connectedChannels,
      bookingRowsCompared: expectedBookings.length, collaborationRowsCompared: expectedCollaborations.length,
      collaborationTotal } };
}

export async function runTemporaryAdmin(Client, env) {
  applicationEnvironment(env); // Validate child isolation before credentials or writes.
  const token = env.REHEARSAL_TEST_SESSION;
  requireTrue(typeof token === "string" && token.length < 16000, "TEST_SESSION_REQUIRED");
  const req = createRequire(process.cwd() + "/package.json");
  const session = await req("@vayada/backend-auth").createWorkOSVerifier({ jwksUrl: env.WORKOS_JWKS_URL,
    issuer: env.WORKOS_ISSUER, audience: env.WORKOS_AUDIENCE })(token);
  verifyAdminSession(session);
  const admin = new Client({ connectionString: guardedConnection(env.ADMIN_DATABASE_URL, "admin").toString(),
    connectionTimeoutMillis: 5000, options: "-c statement_timeout=15000 -c lock_timeout=3000", application_name: "vay1361-temporary-admin" });
  let installed, checks, domainCoverage, failure;
  try {
    await admin.connect();
    await admin.query("SET search_path=pg_catalog");
    installed = await installTemporaryAdmin(admin, session);
    console.log(JSON.stringify({ status: "TEMPORARY_ADMIN_INSTALLED", runId: binding.runId, temporaryDataSha256: installed, addedRows: 5 }));
    await runReadOnlyApplication(Client, env, async (get, reader) => {
      checks = await checkAdminRoutes(get, reader, admin, token, session);
      const domains = await checkAuthenticatedDomainRoutes(get, reader, admin, token, session);
      checks.push(...domains.checks);
      domainCoverage = domains.coverage;
    });
  } catch (error) { failure = error; }
  finally {
    try {
      if (installed) {
        await removeTemporaryAdmin(admin, installed);
        requireTrue((await captureRows(admin)).sha256 === originalData, "POST_COMMIT_CLEANUP_MISMATCH");
        console.log(JSON.stringify({ status: "TEMPORARY_ADMIN_REMOVED", runId: binding.runId, dataSha256: originalData, removedRows: 5 }));
      }
    } finally { await admin.end().catch(() => {}); }
  }
  if (failure) throw failure;
  return { status: "PASS", scope: "temporary-admin-authenticated-domain-smoke", runId: binding.runId, release: binding.release,
    checks, domainCoverage, dataSha256: originalData, applicationStopped: true, temporaryAccessRemoved: true,
    authenticatedIdentityReadProven: true, otherDomainReadsProven: true, fullSmokeAccepted: false };
}

// Recovery only: never provision or launch an application, and refuse data drift.
export async function runTemporaryAdminCleanup(Client, env) {
  const admin = new Client({ connectionString: guardedConnection(env.ADMIN_DATABASE_URL, "admin").toString(),
    connectionTimeoutMillis: 5000, options: "-c statement_timeout=15000 -c lock_timeout=3000", application_name: "vay1361-admin-cleanup" });
  try {
    await admin.connect();
    await admin.query("SET search_path=pg_catalog");
    await removeTemporaryAdmin(admin, env.REHEARSAL_CLEANUP_HASH);
    requireTrue((await captureRows(admin)).sha256 === originalData, "POST_COMMIT_CLEANUP_MISMATCH");
    return { status: "PASS", scope: "temporary-admin-cleanup-only", runId: binding.runId,
      dataSha256: originalData, temporaryAccessRemoved: true, fullSmokeAccepted: false };
  } finally { await admin.end().catch(() => {}); }
}
