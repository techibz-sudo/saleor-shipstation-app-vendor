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

describe("ShipStation V1 order operations", () => {
	it("creates the order directly through V1 with customer identifiers", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
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
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const [url, request] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://ssapi.shipstation.com/orders/createorder");
		expect(request).toMatchObject({ method: "POST" });

		const body = JSON.parse(String((request as RequestInit).body));
		expect(body.orderKey).toBe("1");
		expect(body.orderNumber).toBe("1001");
		expect(body.customerUsername).toBe("ada@example.com");
		expect(body.customerEmail).toBe("ada@example.com");
	});

	it("finds only the V1 order with the exact Saleor order key", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					orders: [
						{
							orderId: 122,
							orderNumber: "1001",
							orderKey: "different-order",
							orderStatus: "awaiting_shipment",
						},
						{
							orderId: 123,
							orderNumber: "1001",
							orderKey: "1",
							orderStatus: "awaiting_shipment",
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

		const { findSaleorOrderInShipstationV1 } = await import("./v1-customer-sync");

		const result = await findSaleorOrderInShipstationV1("T3JkZXI6MQ==", "1001");

		expect(result).toMatchObject({
			orderId: 123,
			orderKey: "1",
			orderStatus: "awaiting_shipment",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("returns null when no exact Saleor order key exists", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					orders: [
						{
							orderId: 122,
							orderNumber: "1001",
							orderKey: "different-order",
							orderStatus: "awaiting_shipment",
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

		const { findSaleorOrderInShipstationV1 } = await import("./v1-customer-sync");

		const result = await findSaleorOrderInShipstationV1("T3JkZXI6MQ==", "1001");

		expect(result).toBeNull();
	});

	it("deletes a verified V1 order by its numeric order ID", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const { deleteShipstationV1Order } = await import("./v1-customer-sync");

		await deleteShipstationV1Order(123);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, request] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://ssapi.shipstation.com/orders/123");
		expect(request).toMatchObject({ method: "DELETE" });
	});
});
