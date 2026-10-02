import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SaleorOrderForShipstation } from "./map-saleor-order";

function makeOrder(overrides: Partial<SaleorOrderForShipstation> = {}): SaleorOrderForShipstation {
	const address = {
		firstName: "Ada",
		lastName: "Lovelace",
		companyName: null,
		streetAddress1: "1 Lovelace Way",
		streetAddress2: null,
		city: "London",
		countryArea: "Greater London",
		postalCode: "W1A 1AA",
		country: { code: "GB" },
		phone: "+44123456789",
	};

	return {
		id: "T3JkZXI6MQ==",
		number: "1001",
		created: "2026-05-14T10:00:00Z",
		userEmail: " ADA@EXAMPLE.COM ",
		user: null,
		total: { gross: { amount: 49.99, currency: "USD" } },
		shippingPrice: { gross: { amount: 9.99 } },
		weight: { value: 1.5, unit: "KG" },
		billingAddress: address,
		shippingAddress: address,
		lines: [
			{
				id: "T3JkZXJMaW5lOjE=",
				productSku: "BPC-157-5MG",
				productName: "BPC-157",
				variantName: "5mg",
				quantity: 1,
				unitPrice: { gross: { amount: 49.99 } },
				thumbnail: {
					url: "https://cdn.example.com/bpc-157.jpg",
				},
			},
		],
		shippingMethodName: "USPS Priority",
		customerNote: " Leave at the back door ",
		...overrides,
	};
}

beforeEach(() => {
	vi.resetModules();
	vi.stubEnv("SHIPSTATION_V1_API_KEY", "test-key");
	vi.stubEnv("SHIPSTATION_V1_API_SECRET", "test-secret");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("mapSaleorOrderToShipstationV1", () => {
	it("maps the customer identifier and complete order", async () => {
		const { mapSaleorOrderToShipstationV1 } = await import("./v1-customer-sync");

		const result = mapSaleorOrderToShipstationV1(makeOrder());

		expect(result.orderKey).toBe("1");
		expect(result.orderNumber).toBe("1001");
		expect(result.customerUsername).toBe("ada@example.com");
		expect(result.customerEmail).toBe("ada@example.com");
		expect(result.orderStatus).toBe("awaiting_shipment");
		expect(result.shipTo.name).toBe("Ada Lovelace");
		expect(result.weight).toEqual({
			value: 1500,
			units: "grams",
		});
		expect(result.items[0]).toMatchObject({
			sku: "BPC-157-5MG",
			name: "BPC-157 — 5mg",
			quantity: 1,
		});
		expect(result.customerNotes).toBe("Leave at the back door");
	});

	it("falls back to the Saleor account email", async () => {
		const { mapSaleorOrderToShipstationV1 } = await import("./v1-customer-sync");

		const result = mapSaleorOrderToShipstationV1(
			makeOrder({
				userEmail: null,
				user: { email: "fallback@example.com" },
			}),
		);

		expect(result.customerUsername).toBe("fallback@example.com");
	});

	it("rejects an order without an email", async () => {
		const { mapSaleorOrderToShipstationV1 } = await import("./v1-customer-sync");

		expect(() =>
			mapSaleorOrderToShipstationV1(
				makeOrder({
					userEmail: null,
					user: null,
				}),
			),
		).toThrow(/no customer email/);
	});
});

describe("syncSaleorCustomerToShipstationV1", () => {
	it("does not update until the exact V2-created order is found", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					orders: [
						{
							orderId: 123,
							orderNumber: "1001",
							orderKey: "different-order",
							customerUsername: null,
						},
					],
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { syncSaleorCustomerToShipstationV1 } = await import("./v1-customer-sync");

		await expect(syncSaleorCustomerToShipstationV1(makeOrder())).rejects.toMatchObject({
			status: 503,
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("updates an exact order even when its username already matches", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						orders: [
							{
								orderId: 123,
								orderNumber: "1001",
								orderKey: "1",
								customerUsername: "ada@example.com",
							},
						],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						orderId: 123,
						orderNumber: "1001",
						orderKey: "1",
						customerId: 456,
						customerUsername: "ada@example.com",
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				),
			);

		vi.stubGlobal("fetch", fetchMock);

		const { syncSaleorCustomerToShipstationV1 } = await import("./v1-customer-sync");

		const result = await syncSaleorCustomerToShipstationV1(makeOrder());

		expect(result).toEqual({
			orderId: 123,
			updated: true,
			customerId: 456,
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("updates a verified existing order with the customer identifier", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						orders: [
							{
								orderId: 123,
								orderNumber: "1001",
								orderKey: "1",
								customerUsername: null,
							},
						],
					}),
					{
						status: 200,
						headers: {
							"Content-Type": "application/json",
						},
					},
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						orderId: 123,
						orderNumber: "1001",
						orderKey: "1",
						customerId: 456,
						customerUsername: "ada@example.com",
					}),
					{
						status: 200,
						headers: {
							"Content-Type": "application/json",
						},
					},
				),
			);

		vi.stubGlobal("fetch", fetchMock);

		const { syncSaleorCustomerToShipstationV1 } = await import("./v1-customer-sync");

		const result = await syncSaleorCustomerToShipstationV1(makeOrder());

		expect(result).toEqual({
			orderId: 123,
			updated: true,
			customerId: 456,
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);

		const [, updateRequest] = fetchMock.mock.calls[1]!;
		const request = updateRequest as RequestInit;
		const body = JSON.parse(String(request.body));

		expect(body.customerUsername).toBe("ada@example.com");
		expect(body.customerEmail).toBe("ada@example.com");
		expect(body.orderKey).toBe("1");
	});
});
