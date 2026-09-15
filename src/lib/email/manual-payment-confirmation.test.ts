import { describe, expect, it, vi } from "vitest";

vi.mock("@/env", () => ({
	env: { MANUAL_PAYMENT_SUPPORT_EMAIL: "support@infinitybiolabs.com" },
}));

describe("renderManualPaymentConfirmation", () => {
	it("shows the original shipping price and separates every discount", async () => {
		const { renderManualPaymentConfirmation } = await import("./manual-payment-confirmation");
		const message = renderManualPaymentConfirmation(
			{
				id: "order-id",
				number: "5038",
				created: "2026-09-15T12:00:00Z",
				userEmail: "buyer@example.com",
				user: null,
				total: { gross: { amount: 131.35, currency: "USD" } },
				shippingPrice: { gross: { amount: 7.78 } },
				undiscountedShippingPrice: { amount: 9.95 },
				discounts: [
					{ reason: "WELCOME20", total: { amount: 31.6 } },
					{ reason: "Manual payment savings", total: { amount: 5 } },
				],
				weight: null,
				billingAddress: null,
				shippingAddress: null,
				lines: [
					{
						id: "line-id",
						productSku: "GLP3-10",
						productName: "GLP-3",
						variantName: "10mg Vial",
						quantity: 2,
						unitPrice: { gross: { amount: 61.785 } },
						undiscountedUnitPrice: { gross: { amount: 105 } },
						unitDiscount: { amount: 26 },
						thumbnail: null,
					},
				],
				metadata: [{ key: "manual_payment_discount_amount", value: "5.00" }],
			},
			"cash_app",
		);

		expect(message.html).toContain("GLP-3 (10mg Vial) × 2");
		expect(message.html).toContain("Sale savings");
		expect(message.html).toContain("-$52.00");
		expect(message.html).toContain("Promotion (WELCOME20)");
		expect(message.html).toContain("-$31.60");
		expect(message.html).toContain("$9.95");
		expect(message.html).not.toContain("$7.78");
		expect(message.html).toContain("$131.35");
	});

	it("does not invent a $5 discount when the order has none", async () => {
		const { renderManualPaymentConfirmation } = await import("./manual-payment-confirmation");
		const message = renderManualPaymentConfirmation(
			{
				id: "order-id",
				number: "5039",
				created: "2026-09-15T12:00:00Z",
				userEmail: "buyer@example.com",
				user: null,
				total: { gross: { amount: 100, currency: "USD" } },
				shippingPrice: { gross: { amount: 10 } },
				undiscountedShippingPrice: { amount: 10 },
				discounts: [],
				weight: null,
				billingAddress: null,
				shippingAddress: null,
				lines: [
					{
						id: "line-id",
						productSku: "TEST",
						productName: "Test Product",
						variantName: null,
						quantity: 1,
						unitPrice: { gross: { amount: 90 } },
						undiscountedUnitPrice: { gross: { amount: 90 } },
						unitDiscount: { amount: 0 },
						thumbnail: null,
					},
				],
				metadata: [],
			},
			"venmo",
		);

		expect(message.html).not.toContain("Manual-payment discount");
		expect(message.text).not.toContain("-$5.00");
	});
});
