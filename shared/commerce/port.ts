/**
 * The commerce port.
 *
 * This is the ONLY surface through which the storefront and the agent may reach a
 * sales channel. Nothing beyond an adapter implementation may import a vendor SDK
 * or handle a vendor identifier.
 *
 * Our database is the system of record. A channel holds a *projection* of the
 * catalog so that its checkout works, and returns orders to us. That is all.
 *
 * Swapping vendor = one new implementation of `CommerceAdapter` + a re-projection.
 */

/** Money is always integer minor units plus an explicit currency. Never a float. */
export interface Money {
  readonly amountMinor: bigint;
  readonly currency: string; // ISO-4217
}

/** One of our UUIDs. Never a vendor identifier. */
export type Id = string & { readonly __brand: unique symbol };

export interface Variant {
  readonly id: Id;
  readonly sku: string | null;
  readonly title: string;
  readonly options: Readonly<Record<string, string>>;
  readonly price: Money;
}

export interface Product {
  readonly id: Id;
  readonly handle: string;
  readonly title: string;
  readonly description: string;
  readonly status: 'draft' | 'active' | 'archived';
  readonly variants: readonly Variant[];
  readonly mediaKeys: readonly string[]; // R2 keys. We own the originals.
}

export interface OrderLine {
  readonly variantId: Id | null; // null once the variant is deleted; snapshots persist
  readonly titleSnapshot: string;
  readonly skuSnapshot: string | null;
  readonly quantity: number;
  readonly unitPrice: Money;
}

export interface Order {
  readonly id: Id;
  readonly orderNumber: number;
  readonly status: 'pending' | 'paid' | 'fulfilled' | 'cancelled' | 'refunded';
  readonly lines: readonly OrderLine[];
  readonly total: Money;
  readonly placedAt: Date;
}

export interface InventoryLevel {
  readonly variantId: Id;
  readonly locationId: Id;
  readonly onHand: number;
  readonly reserved: number;
}

/** Result of projecting one entity onto a channel. */
export interface ProjectionResult {
  readonly entityId: Id;
  readonly externalId: string; // stored in `external_ref`, nowhere else
}

export interface CommerceAdapter {
  readonly channelKind: string; // 'shopify' | 'medusa' | ...

  // ---- outbound: our catalog -> the channel -------------------------------
  /** Create or update the channel's copy of a product. Idempotent. */
  projectProduct(product: Product): Promise<ProjectionResult>;
  /** Remove a product from the channel. Our copy is untouched. */
  retractProduct(productId: Id): Promise<void>;
  pushInventory(levels: readonly InventoryLevel[]): Promise<void>;

  // ---- inbound: the channel -> us ----------------------------------------
  /**
   * Normalise a vendor webhook into our Order shape.
   * Returns null for payloads this adapter does not handle.
   * MUST NOT write to the database - the caller persists, so ingest stays replayable
   * from `order.raw_payload`.
   */
  parseOrderWebhook(headers: Headers, body: string): Promise<Order | null>;
  /** Verify webhook authenticity before anything else touches the payload. */
  verifyWebhook(headers: Headers, body: string): Promise<boolean>;

  // ---- checkout ------------------------------------------------------------
  /**
   * A URL that hands the customer to the channel's hosted checkout.
   * Checkout is the one thing we deliberately rent: owning it means PCI scope,
   * fraud handling and payment-provider relationships.
   */
  createCheckoutUrl(
    items: readonly { variantId: Id; quantity: number }[],
  ): Promise<string>;
}

/**
 * Write operations an agent may request but MUST NOT execute unattended.
 * Every member goes through the approval gate and is recorded in `audit_log`.
 */
export const GATED_OPERATIONS = [
  'projectProduct',
  'retractProduct',
  'pushInventory',
  'price.set',
  'order.refund',
] as const;

export type GatedOperation = (typeof GATED_OPERATIONS)[number];
