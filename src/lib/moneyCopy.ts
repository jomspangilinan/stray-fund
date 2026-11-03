/** The test-money claim, said only when PAYPAL_ENV is not live. Callers pass moneyIsTest(). */
export function testMoneyLine(testMoney: boolean): string {
  return testMoney ? "Test money only." : "";
}

/** The fee note under the donate form. The example amount is from the sandbox, so live money gets no example. */
export function feeNote(testMoney: boolean): string {
  return testMoney
    ? "Test money only. PayPal's fee (about ₱18 on ₱100) shows after you pay."
    : "PayPal takes a fee, shown after you pay.";
}
