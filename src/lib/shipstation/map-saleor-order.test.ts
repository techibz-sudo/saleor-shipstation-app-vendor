import { describe, expect, it } from "vitest";

import { mapSaleorOrderToShipstation, type SaleorOrderForShipstation } from "./map-saleor-order";

const MAP_OPTIONS = { warehouseId: "se-test-warehouse" };

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
		userEmail: "ada@example.com",
		user: null,
		total: { gross: { amount: 49.99, currency: "USD" } },
		shippingPrice: { gross: { amount: 9.99 } },
		weight: { value: 250, unit: "G" },
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
				thumbnail: { url: "https://cdn.example.com/bpc-157.jpg" },
			},
		],
		shippingMethodName: "USPS Priority",
		...overrides,
	};
}

describe("mapSaleorOrderToShipstation (v2)", () => {
	it("produces a valid v2 shipment input for a happy-path order", () => {
		const order = makeOrder();
		const result = mapSaleorOrderToShipstation(order, MAP_OPTIONS);

		// Short form: Saleor base64 ID stripped to the inner identifier so we fit
		// inside ShipStation's 50-char external_shipment_id cap.
		expect(result.external_shipment_id).toBe("1");
		expect(result.external_order_id).toBe("1");
		expect(result.order_number).toBe("1001");
		expect(result.ship_date).toBe("2026-05-14");
		// create_sales_order: true is required for the order to surface in the
		// operator-facing Orders view. ShipStation auto-assigns it to its "API
		// Shipments" store when no explicit store_id is provided.
		expect(result.create_sales_order).toBe(true);
		expect(result.warehouse_id).toBe("se-test-warehouse");
		expect(result.shipment_status).toBe("pending");
		expect(result.ship_to.country_code).toBe("GB");
		expect(result.ship_to.name).toBe("Ada Lovelace");
		expect(result.ship_to.email).toBe("ada@example.com");
		expect(result.ship_to.city_locality).toBe("London");
		expect(result.ship_to.state_province).toBe("Greater London");
		expect(result.packages).toHaveLength(1);
		expect(result.packages[0]?.weight).toEqual({ value: 250, unit: "gram" });
		expect(result.shipping_paid).toEqual({ amount: 9.99, currency: "USD" });
		expect(result.amount_paid).toEqual({ amount: 49.99, currency: "USD" });
		expect(result.internal_notes).toContain("Saleor order 1001");
		expect(result.items).toHaveLength(1);
		expect(result.items![0]).toEqual({
			name: "BPC-157 — 5mg",
			quantity: 1,
			sku: "BPC-157-5MG",
			unit_price: 49.99,
			image_url: "https://cdn.example.com/bpc-157.jpg",
			external_order_id: "1",
			options: [{ name: "Variant", value: "5mg" }],
		});
	});

	it("keeps KG as kilogram (v2 accepts kilogram natively)", () => {
		const order = makeOrder({ weight: { value: 1.5, unit: "KG" } });
		const result = mapSaleorOrderToShipstation(order, MAP_OPTIONS);
		expect(result.packages[0]?.weight).toEqual({ value: 1.5, unit: "kilogram" });
	});

	it("falls back to user.email when userEmail is null", () => {
		const order = makeOrder({ userEmail: null, user: { email: "fallback@example.com" } });
		const result = mapSaleorOrderToShipstation(order, MAP_OPTIONS);
		expect(result.ship_to.email).toBe("fallback@example.com");
	});

	it("falls back to city as state_province when countryArea is empty (some countries lack states)", () => {
		const order = makeOrder({
			shippingAddress: { ...makeOrder().shippingAddress!, countryArea: null },
		});
		const result = mapSaleorOrderToShipstation(order, MAP_OPTIONS);
		expect(result.ship_to.state_province).toBe("London");
	});

	it("throws when the order has no shipping address", () => {
		const order = makeOrder({ shippingAddress: null });
		expect(() => mapSaleorOrderToShipstation(order, MAP_OPTIONS)).toThrow(/no shipping address/);
	});

	it("defaults to 1 ounce for unsupported weight units rather than failing", () => {
		const order = makeOrder({ weight: { value: 1, unit: "TONNE" } });
		const result = mapSaleorOrderToShipstation(order, MAP_OPTIONS);
		expect(result.packages[0]?.weight).toEqual({ value: 1, unit: "ounce" });
	});

	it("passes customerNote as notes_from_buyer", () => {
		const order = makeOrder({ customerNote: "  please leave at back door  " });
		const result = mapSaleorOrderToShipstation(order, MAP_OPTIONS);
		expect(result.notes_from_buyer).toBe("please leave at back door");
	});

	it("omits notes_from_buyer when customerNote is empty or whitespace", () => {
		expect(mapSaleorOrderToShipstation(makeOrder({ customerNote: null }), MAP_OPTIONS).notes_from_buyer).toBeUndefined();
		expect(mapSaleorOrderToShipstation(makeOrder({ customerNote: "   " }), MAP_OPTIONS).notes_from_buyer).toBeUndefined();
	});

	it("defaults to 1 ounce when the order has no weight at all", () => {
		const order = makeOrder({ weight: null });
		const result = mapSaleorOrderToShipstation(order, MAP_OPTIONS);
		expect(result.packages[0]?.weight).toEqual({ value: 1, unit: "ounce" });
	});
});
