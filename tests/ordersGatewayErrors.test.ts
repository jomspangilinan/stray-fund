import { beforeEach, describe, expect, it, vi } from "vitest";

const getOrder = vi.fn();
vi.mock("@paypal/paypal-server-sdk", () => ({
  CheckoutPaymentIntent: { Capture: "CAPTURE" },
  Environment: { Production: "production", Sandbox: "sandbox" },
  Client: class {},
  OrdersController: class {
    getOrder = getOrder;
  },
}));

import { OrderNotFound, PayPalRateLimited, sdkOrdersGateway } from "../src/server/paypal/orders";

beforeEach(() => {
  vi.stubEnv("PAYPAL_CLIENT_ID", "test-id");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "test-secret");
  getOrder.mockReset();
});

describe("the real orders gateway reading an order", () => {
  it("maps a 429 to PayPalRateLimited", async () => {
    getOrder.mockRejectedValue(Object.assign(new Error("Too Many Requests"), { statusCode: 429 }));
    await expect(sdkOrdersGateway.getOrder("O-1")).rejects.toBeInstanceOf(PayPalRateLimited);
  });

  it("maps a 404 to OrderNotFound", async () => {
    getOrder.mockRejectedValue(Object.assign(new Error("Not Found"), { statusCode: 404 }));
    await expect(sdkOrdersGateway.getOrder("O-1")).rejects.toBeInstanceOf(OrderNotFound);
  });

  it("leaves other errors alone", async () => {
    const boom = Object.assign(new Error("Server Error"), { statusCode: 500 });
    getOrder.mockRejectedValue(boom);
    await expect(sdkOrdersGateway.getOrder("O-1")).rejects.toBe(boom);
  });
});
