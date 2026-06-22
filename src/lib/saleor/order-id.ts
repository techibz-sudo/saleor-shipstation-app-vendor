/**
 * Saleor exposes order IDs as base64("Order:<uuid>"), which is 56+ characters.
 * ShipStation v2 caps `external_shipment_id` and `external_order_id` at 50 chars,
 * so we send only the inner identifier (UUID or legacy integer) and reconstruct
 * the full Saleor ID when ShipStation's webhook calls back.
 *
 * Round-trip:
 *   "T3JkZXI6OTMzOWNkMzctZTczMC00NDY3LTgzNWUtZWEwMmYyN2UzMDAx"
 *     ↓ shortenSaleorOrderId
 *   "9339cd37-e730-4467-835e-ea02f27e3001"
 *     ↓ expandToSaleorOrderId
 *   "T3JkZXI6OTMzOWNkMzctZTczMC00NDY3LTgzNWUtZWEwMmYyN2UzMDAx"
 */

const SALEOR_ID_PREFIX = "Order:";

export function shortenSaleorOrderId(saleorOrderId: string): string {
	const decoded = safeBase64Decode(saleorOrderId);
	if (decoded && decoded.startsWith(SALEOR_ID_PREFIX)) {
		return decoded.slice(SALEOR_ID_PREFIX.length);
	}
	// Already short, or non-standard format — pass through.
	return saleorOrderId;
}

export function expandToSaleorOrderId(externalShipmentId: string): string {
	// If the caller already gave us a full Saleor ID, leave it alone.
	const decoded = safeBase64Decode(externalShipmentId);
	if (decoded && decoded.startsWith(SALEOR_ID_PREFIX)) {
		return externalShipmentId;
	}
	return Buffer.from(`${SALEOR_ID_PREFIX}${externalShipmentId}`, "utf8").toString("base64");
}

function safeBase64Decode(value: string): string | null {
	// Saleor's base64 IDs use standard alphabet + `=` padding. Reject anything that
	// can't be a base64 string before trying to decode.
	if (!/^[A-Za-z0-9+/]+=*$/.test(value)) return null;
	try {
		const decoded = Buffer.from(value, "base64").toString("utf8");
		// Round-trip check: re-encoding must produce the original. Catches strings that
		// happen to match the alphabet but aren't actually base64-encoded data.
		const reencoded = Buffer.from(decoded, "utf8").toString("base64");
		return reencoded === value ? decoded : null;
	} catch {
		return null;
	}
}
