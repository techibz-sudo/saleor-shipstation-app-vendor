import { describe, expect, it } from "vitest";

import { expandToSaleorOrderId, shortenSaleorOrderId } from "./order-id";

describe("Saleor order id round-trip", () => {
	it("shortens a modern UUID-style Saleor order id to fit ShipStation's 50-char cap", () => {
		// "Order:9339cd37-e730-4467-835e-ea02f27e3001" base64-encoded — 56 chars total.
		const fullId = "T3JkZXI6OTMzOWNkMzctZTczMC00NDY3LTgzNWUtZWEwMmYyN2UzMDAx";
		const short = shortenSaleorOrderId(fullId);
		expect(short).toBe("9339cd37-e730-4467-835e-ea02f27e3001");
		expect(short.length).toBeLessThanOrEqual(50);
	});

	it("shortens legacy integer-style Saleor order ids", () => {
		expect(shortenSaleorOrderId("T3JkZXI6MQ==")).toBe("1");
	});

	it("round-trips: shortenSaleorOrderId ∘ expandToSaleorOrderId is identity", () => {
		const fullId = "T3JkZXI6OTMzOWNkMzctZTczMC00NDY3LTgzNWUtZWEwMmYyN2UzMDAx";
		expect(expandToSaleorOrderId(shortenSaleorOrderId(fullId))).toBe(fullId);
	});

	it("expandToSaleorOrderId is idempotent — already-full IDs pass through unchanged", () => {
		const fullId = "T3JkZXI6OTMzOWNkMzctZTczMC00NDY3LTgzNWUtZWEwMmYyN2UzMDAx";
		expect(expandToSaleorOrderId(fullId)).toBe(fullId);
	});

	it("does not mangle a string that happens to match the base64 alphabet but isn't an Order: payload", () => {
		// "deadbeef" decoded from base64 is binary, not "Order:..." — should pass through.
		expect(shortenSaleorOrderId("deadbeef")).toBe("deadbeef");
	});

	it("expand handles raw UUIDs (legacy data) by encoding them as Saleor IDs", () => {
		const uuid = "9339cd37-e730-4467-835e-ea02f27e3001";
		const encoded = expandToSaleorOrderId(uuid);
		// Decode and check
		expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(`Order:${uuid}`);
	});
});
