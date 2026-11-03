/*
 * Stands in for https://www.paypal.com/sdk/js in the end-to-end test only. The test serves this file for
 * that address, so the real donate page, its real order and capture routes, and the fake PayPal behind
 * them all run. The button here does what PayPal's does: ask the page for an order, then tell it the
 * buyer approved.
 */
window.paypal = {
  Buttons(props) {
    let host = null;
    return {
      isEligible: () => true,
      updateProps() {},
      async close() {
        if (host) host.replaceChildren();
      },
      async render(el) {
        host = el;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Pay with fake PayPal";
        button.setAttribute("data-testid", "fake-paypal");
        button.addEventListener("click", async () => {
          try {
            const orderID = await props.createOrder({}, {});
            await props.onApprove({ orderID }, {});
          } catch (e) {
            props.onError?.(e);
          }
        });
        el.replaceChildren(button);
      },
    };
  },
};
