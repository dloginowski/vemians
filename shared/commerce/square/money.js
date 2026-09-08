/*
 * Money, at the one point where Square's numbers become ours.
 *
 * Test-PRD-P0-15-money_minor_units. Money is an integer minor amount plus an
 * explicit currency, everywhere, in every store. No floats, no implied
 * currency.
 *
 * The good news is that Square agrees: its `Money` is `{amount, currency}` with
 * `amount` in the smallest denomination — 1099 for $10.99 — which is exactly
 * our shape. So this file is not a conversion, it is a GATE. Its whole job is
 * to make the one dangerous case loud:
 *
 *     JSON.parse('{"amount": 10.99}')  ->  10.99
 *
 * A float arriving from a provider that promised integers is a data bug, and
 * rounding it silently is how a shop charges the wrong price for a year. So a
 * non-integer amount throws here rather than being coerced. `Number.parseFloat`
 * and `Math.round` appear nowhere in this adapter, deliberately.
 *
 * Amounts are carried internally as BIGINT, matching `Money.amountMinor` in
 * shared/commerce/port.ts. They narrow to a JS number only at the D1 bind
 * boundary (`toStorableMinor`), because D1 has no bigint bind type — and that
 * narrowing asserts the value is a safe integer rather than assuming it.
 */

export class MoneyError extends Error {
  constructor(message) {
    super(message);
    this.name = "MoneyError";
  }
}

/* ISO-4217 is three letters. A missing currency is not defaultable: "1099" is
   a different amount of money in JPY than in USD, and guessing is how an
   implied currency gets into a store that the PRD says may not have one. */
function requireCurrency(currency, context) {
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new MoneyError(`${context}: currency must be an ISO-4217 code, got ${JSON.stringify(currency)}`);
  }
  return currency;
}

/**
 * Square `Money` -> our `Money`.
 *
 * Accepts the three encodings a JSON body can legally carry an integer in
 * (number, decimal string, bigint) and rejects everything else, loudly.
 *
 * @returns {{ amountMinor: bigint, currency: string }}
 */
export function moneyFromSquare(money, context = "money") {
  if (money === null || typeof money !== "object") {
    throw new MoneyError(`${context}: expected a Square Money object, got ${JSON.stringify(money)}`);
  }
  const { amount, currency } = money;
  return {
    amountMinor: minorFromSquare(amount, context),
    currency: requireCurrency(currency, context),
  };
}

/** The amount half of the above, for payloads that carry a bare quantity. */
export function minorFromSquare(amount, context = "amount") {
  if (typeof amount === "bigint") return amount;

  if (typeof amount === "number") {
    if (!Number.isInteger(amount)) {
      /* THE case this module exists for. Do not round it. */
      throw new MoneyError(
        `${context}: ${amount} is not an integer minor amount — refusing to round a float into money`,
      );
    }
    if (!Number.isSafeInteger(amount)) {
      throw new MoneyError(`${context}: ${amount} exceeds the safe integer range`);
    }
    return BigInt(amount);
  }

  if (typeof amount === "string") {
    if (!/^-?\d+$/.test(amount)) {
      throw new MoneyError(`${context}: "${amount}" is not an integer minor amount`);
    }
    return BigInt(amount);
  }

  throw new MoneyError(`${context}: expected an integer minor amount, got ${typeof amount}`);
}

/** Our `Money` -> Square `Money`, for outbound writes (payment links, prices). */
export function moneyToSquare(money, context = "money") {
  if (typeof money?.amountMinor !== "bigint") {
    throw new MoneyError(`${context}: amountMinor must be a bigint`);
  }
  const currency = requireCurrency(money.currency, context);
  return { amount: toStorableMinor(money, context), currency };
}

/**
 * bigint -> the JS number D1 will bind as an INTEGER column.
 *
 * D1's bind types are number | string | null | ArrayBuffer | boolean; there is
 * no bigint among them. The narrowing is therefore real, so it is asserted
 * rather than assumed: 2^53 minor units is ~90 trillion dollars, and a value
 * past it means something upstream is wrong, not that we should truncate.
 */
export function toStorableMinor(money, context = "money") {
  const amount = typeof money === "bigint" ? money : money?.amountMinor;
  if (typeof amount !== "bigint") {
    throw new MoneyError(`${context}: expected a bigint minor amount`);
  }
  if (amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MoneyError(`${context}: ${amount} does not fit a D1 INTEGER bind safely`);
  }
  return Number(amount);
}
