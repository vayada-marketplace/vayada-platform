import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import pg from "pg";

import { createStripeBookingPaymentProvider } from "/app/apps/api/dist/domains/stripeBookingPayments.js";

const QA_PROPERTY_ID = "7e74ee43-517f-47bd-9167-6733568fea71";
const AMOUNT_MINOR = 15_000;
const APPLICATION_FEE_MINOR = 750;
const CURRENCY = "eur";

const stripeSecretKey = requiredEnv("STRIPE_SECRET_KEY");
const databaseUrl = requiredEnv("TARGET_DATABASE_URL");
const scope = requiredEnv("VAYADA_STRIPE_SMOKE_SCOPE");
const cleanupPaymentIntentId = process.env.VAYADA_STRIPE_SMOKE_CLEANUP_PAYMENT_INTENT_ID?.trim();

if (!stripeSecretKey.startsWith("rk_test_")) {
  throw new Error("Stripe smoke requires an rk_test_ restricted key.");
}
if (scope !== "isolated-qa-only") {
  throw new Error("Stripe smoke task is not scoped to isolated QA.");
}
if (cleanupPaymentIntentId && !/^pi_[A-Za-z0-9]+$/.test(cleanupPaymentIntentId)) {
  throw new Error("Cleanup requires a valid test PaymentIntent ID.");
}

const connectionUrl = new URL(databaseUrl);
if (
  connectionUrl.searchParams.get("sslmode") === "require" &&
  !connectionUrl.searchParams.has("uselibpqcompat")
) {
  connectionUrl.searchParams.set("uselibpqcompat", "true");
}

const db = new pg.Client({ connectionString: connectionUrl.toString() });
const paymentProvider = createStripeBookingPaymentProvider({ secretKey: stripeSecretKey });
let createdPaymentIntentId;
let providerAccountRef;

try {
  await db.connect();
  const accountResult = await db.query(
    `SELECT provider_account_id AS "providerAccountRef"
       FROM finance.payment_provider_accounts
      WHERE account_scope = 'property'
        AND provider = 'stripe'
        AND property_id = $1::uuid
        AND provider_account_id LIKE 'acct_%'
      ORDER BY created_at ASC
      LIMIT 1`,
    [QA_PROPERTY_ID],
  );
  providerAccountRef = accountResult.rows[0]?.providerAccountRef;
  if (typeof providerAccountRef !== "string" || !providerAccountRef.startsWith("acct_")) {
    throw new Error("The isolated QA property has no Stripe connected account.");
  }

  if (cleanupPaymentIntentId) {
    const cleanup = await cleanupStripePayment(cleanupPaymentIntentId, providerAccountRef);
    const databaseRowsPersisted = await persistedPaymentRows(cleanupPaymentIntentId);
    if (databaseRowsPersisted !== 0) {
      throw new Error(`Cleanup found ${databaseRowsPersisted} persisted target payment row(s).`);
    }
    console.log(
      JSON.stringify({
        status: "CLEAN",
        paymentIntentId: cleanupPaymentIntentId,
        cleanup,
        databaseRowsPersisted,
      }),
    );
  } else {
    const runId = `vay-1301-${randomUUID()}`;
    const created = await paymentProvider.createPaymentIntent({
      propertyId: QA_PROPERTY_ID,
      bookingReference: runId,
      providerAccountRef,
      amountMinor: AMOUNT_MINOR,
      applicationFeeAmountMinor: APPLICATION_FEE_MINOR,
      currency: CURRENCY,
      captureMethod: "manual",
      idempotencyKey: `${runId}:create`,
    });
    createdPaymentIntentId = created.paymentIntentId;
    console.log(JSON.stringify({ status: "CREATED", paymentIntentId: createdPaymentIntentId }));
    if (created.status !== "requires_payment_method") {
      throw new Error("Stripe did not create a test PaymentIntent awaiting confirmation.");
    }

    await stripeRequest(
      "POST",
      `/payment_intents/${encodeURIComponent(createdPaymentIntentId)}/confirm`,
      [["payment_method", "pm_card_visa"]],
      providerAccountRef,
      `${runId}:confirm`,
    );
    await paymentProvider.capturePaymentIntent(
      createdPaymentIntentId,
      providerAccountRef,
      `${runId}:capture`,
    );
    const retrieved = await paymentProvider.retrievePaymentIntent(
      createdPaymentIntentId,
      providerAccountRef,
    );
    const breakdown = retrieved.feeBreakdown;
    if (retrieved.status !== "succeeded" || !breakdown) {
      throw new Error("Stripe did not return the captured balance-transaction breakdown.");
    }
    if (
      breakdown.grossAmountMinor !== AMOUNT_MINOR ||
      breakdown.applicationFeeAmountMinor !== APPLICATION_FEE_MINOR ||
      breakdown.currency !== CURRENCY.toUpperCase() ||
      breakdown.netPayoutAmountMinor !==
        breakdown.grossAmountMinor -
          breakdown.processorFeeAmountMinor -
          breakdown.applicationFeeAmountMinor
    ) {
      throw new Error("Stripe returned an unexpected connected-account fee breakdown.");
    }
    const cleanup = await cleanupStripePayment(createdPaymentIntentId, providerAccountRef);
    const databaseRowsPersisted = await persistedPaymentRows(createdPaymentIntentId);
    if (databaseRowsPersisted !== 0) {
      throw new Error(`Smoke found ${databaseRowsPersisted} persisted target payment row(s).`);
    }

    console.log(
      JSON.stringify({
        status: "PASS",
        paymentIntentId: createdPaymentIntentId,
        chargeId: breakdown.chargeId,
        balanceTransactionId: breakdown.balanceTransactionId,
        gross: decimal(breakdown.grossAmountMinor),
        stripeFee: decimal(breakdown.processorFeeAmountMinor),
        applicationFee: decimal(breakdown.applicationFeeAmountMinor),
        netPayout: decimal(breakdown.netPayoutAmountMinor),
        currency: breakdown.currency,
        cleanup,
        databaseRowsPersisted,
      }),
    );
  }
} catch (error) {
  if (createdPaymentIntentId && providerAccountRef) {
    try {
      await cleanupStripePayment(createdPaymentIntentId, providerAccountRef);
    } catch (cleanupError) {
      console.error(`Automatic cleanup failed: ${message(cleanupError)}`);
    }
  }
  throw error;
} finally {
  await db.end().catch(() => undefined);
}

async function cleanupStripePayment(paymentIntentId, providerAccountRef) {
  const intent = await stripeRequest(
    "GET",
    `/payment_intents/${encodeURIComponent(paymentIntentId)}`,
    [["expand[]", "latest_charge"]],
    providerAccountRef,
  );
  if (intent.livemode !== false) throw new Error("Cleanup refused a live PaymentIntent.");
  const metadata = object(intent.metadata);
  if (
    text(metadata.vayada_property_id) !== QA_PROPERTY_ID ||
    !text(metadata.vayada_booking_reference)?.startsWith("vay-1301-") ||
    Number(intent.amount) !== AMOUNT_MINOR ||
    text(intent.currency)?.toLowerCase() !== CURRENCY
  ) {
    throw new Error("Cleanup refused a PaymentIntent not owned by this smoke.");
  }

  const charge = object(intent.latest_charge);
  const chargeId = text(charge.id);
  if (chargeId && charge.refunded === true) return { action: "already_refunded", chargeId };
  if (intent.status === "succeeded") {
    if (!chargeId) throw new Error("Captured PaymentIntent has no refundable charge.");
    const refund = await stripeRequest(
      "POST",
      "/refunds",
      [
        ["charge", chargeId],
        ["refund_application_fee", "true"],
      ],
      providerAccountRef,
      `vay-1301:${paymentIntentId}:refund`,
    );
    if (refund.livemode !== false || refund.status !== "succeeded") {
      throw new Error("Stripe did not confirm the test refund.");
    }
    return { action: "refunded", refundId: text(refund.id) };
  }
  if (intent.status === "canceled") return { action: "already_canceled" };

  const canceled = await paymentProvider.cancelPaymentIntent(
    paymentIntentId,
    providerAccountRef,
    `vay-1301:${paymentIntentId}:cancel`,
  );
  if (canceled.status !== "canceled") {
    throw new Error("Stripe did not confirm test PaymentIntent cancellation.");
  }
  return { action: "canceled" };
}

async function persistedPaymentRows(paymentIntentId) {
  const result = await db.query(
    `SELECT count(*)::int AS count
       FROM finance.payments
      WHERE provider_payment_intent_id = $1`,
    [paymentIntentId],
  );
  return Number(result.rows[0]?.count ?? -1);
}

async function stripeRequest(method, path, fields, providerAccountRef, idempotencyKey) {
  const form = new URLSearchParams(fields);
  const response = await fetch(
    `https://api.stripe.com/v1${path}${method === "GET" && form.size ? `?${form}` : ""}`,
    {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${stripeSecretKey}:`).toString("base64")}`,
        "Stripe-Account": providerAccountRef,
        ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(method === "POST" ? { body: form.toString() } : {}),
    },
  );
  const payload = object(await response.json());
  if (!response.ok) {
    throw new Error(text(object(payload.error).message) ?? `Stripe request failed (${response.status}).`);
  }
  return payload;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function decimal(amountMinor) {
  return (amountMinor / 100).toFixed(2);
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
