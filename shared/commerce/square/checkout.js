/*
 * Checkout: the Payment Links API, and nothing else.
 *
 * ADR-009: "Payment Links API -- a Square-hosted checkout page. Same principle
 * as before: checkout is the one thing worth renting, card data never touches
 * us, and PCI scope stays with Square."  And the refusal, explicitly:
 *
 *   "The Web Payments SDK would let us embed the card fields for a smoother
 *    flow, and would pull us into a wider PCI obligation for it. Not at this
 *    stage."
 *
 * So this file mints a URL and hands the customer over. It does not see a card
 * number, a token, or a `payment` object, and there is no code path here that
 * could — Test-PRD-P0-17-channel_agnostic_orders: "Card data is never stored; a
 * channel token and last four digits only, so the platform stays out of PCI
 * scope."
 *
 * THIS IS THE ONLY SQUARE CALL ON THE PUBLIC PATH.
 *
 * ADR-009's anti-patterns table forbids "storefront reading Square live per
 * request"; Test-PRD-P0-26-owned_storefront requires zero calls to a commerce
 * provider "except to mint a checkout URL". That exception is this function.
 * Browsing reads the mirror, so a Square outage costs the cart button and not
 * the shop.
 */
import { idempotencyKey } from "./ids.js";
import { moneyToSquare } from "./money.js";

const PAYMENT_LINKS = "/v2/online-checkout/payment-links";

/**
 * CreatePaymentLink over an ORDER of catalog line items.
 *
 * Line items reference Square by `catalog_object_id`, so Square prices the
 * order from its own catalog rather than trusting a price we send. That is the
 * correct direction under ADR-009 — Square is authoritative for price — and it
 * closes the obvious tamper: a client that edits a price in a cart payload
 * changes nothing, because the number never leaves our side.
 *
 * @param client        a createSquareClient()
 * @param lineItems     [{ externalRef, quantity }] — SQUARE variation ids.
 *                      Resolving our uuids to these is the mirror's job, done
 *                      in index.js, so this module never sees one of our ids
 *                      and never has to decide which id is which.
 * @param idempotencySeed a STABLE seed (a cart id). Square dedupes on
 *                      `idempotency_key`; a random key on a retry defeats the
 *                      mechanism and mints a second link for the same cart.
 */
export async function createPaymentLink(
  client,
  {
    lineItems,
    locationId,
    idempotencySeed,
    redirectUrl = null,
    description = null,
    askForShippingAddress = false,
    merchantSupportEmail = null,
  } = {},
) {
  const location = locationId ?? client.locationId;
  if (!location) {
    console.error("ERROR square/checkout: SQUARE_LOCATION_ID is unset — cannot mint a payment link");
    throw new Error("SQUARE_LOCATION_ID is unset");
  }
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error("createPaymentLink: no line items");
  }

  const line_items = lineItems.map((li, i) => {
    const quantity = Number(li?.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      /* order_line CHECK (quantity > 0) says the same thing one layer down. */
      throw new Error(`createPaymentLink: line ${i} quantity must be a positive integer`);
    }
    if (!li?.externalRef) {
      throw new Error(`createPaymentLink: line ${i} has no Square variation reference`);
    }
    return { catalog_object_id: li.externalRef, quantity: String(quantity) };
  });

  const body = {
    idempotency_key: idempotencyKey(idempotencySeed),
    order: { location_id: location, line_items },
    checkout_options: {
      ask_for_shipping_address: Boolean(askForShippingAddress),
      ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
      ...(merchantSupportEmail ? { merchant_support_email: merchantSupportEmail } : {}),
    },
    ...(description ? { description } : {}),
  };

  let payload;
  try {
    payload = await client.post(PAYMENT_LINKS, body);
  } catch (err) {
    /* A service-boundary failure on the one rented path (RULES.md §14). The
       caller shows "checkout is temporarily unavailable"; it must not fall back
       to some other checkout, and it must not fail silently into a dead link. */
    console.error(`ERROR square/checkout: CreatePaymentLink failed — ${err.message}`);
    throw err;
  }

  const link = payload?.payment_link;
  const url = link?.url ?? link?.long_url;
  if (!url) {
    console.error("ERROR square/checkout: CreatePaymentLink returned no url — refusing to hand out a dead link");
    throw new Error("CreatePaymentLink returned no url");
  }

  return {
    url,
    /* Square ids, returned for the caller to put in `external_ref` / the
       order's `external_id` — and nowhere else (ADR-009). */
    externalRef: link.id ?? null,
    orderExternalRef: link.order_id ?? null,
  };
}

/**
 * A quick-pay link for an ad-hoc amount, for the counter: no catalog object,
 * one name and one price. Kept separate from the catalog path so the ordinary
 * storefront route cannot accidentally send a price of its own choosing.
 */
export async function createQuickPayLink(
  client,
  { name, price, locationId, idempotencySeed, redirectUrl = null } = {},
) {
  const location = locationId ?? client.locationId;
  if (!location) {
    console.error("ERROR square/checkout: SQUARE_LOCATION_ID is unset — cannot mint a quick-pay link");
    throw new Error("SQUARE_LOCATION_ID is unset");
  }
  const body = {
    idempotency_key: idempotencyKey(idempotencySeed),
    quick_pay: {
      name: String(name ?? "").slice(0, 255),
      /* moneyToSquare throws on anything that is not an integer minor amount
         with an explicit currency (Test-PRD-P0-15-money_minor_units). */
      price_money: moneyToSquare(price, "quick pay price"),
      location_id: location,
    },
    ...(redirectUrl ? { checkout_options: { redirect_url: redirectUrl } } : {}),
  };

  const payload = await client.post(PAYMENT_LINKS, body);
  const link = payload?.payment_link;
  const url = link?.url ?? link?.long_url;
  if (!url) {
    console.error("ERROR square/checkout: quick-pay link returned no url");
    throw new Error("CreatePaymentLink returned no url");
  }
  return { url, externalRef: link.id ?? null, orderExternalRef: link.order_id ?? null };
}
