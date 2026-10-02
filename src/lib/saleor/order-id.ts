/**
 * Saleor exposes order IDs as base64("Order:<uuid>").
 *
 * ShipStation stores the inner Saleor UUID as its order key. The tracking
 * webhook validates that shape before attempting to write tracking to Saleor,
 * so marketplace order numbers are ignored.
 */

const SALEOR_ID_PREFIX = "Order:";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function shortenSaleorOrderId(saleorOrderId: string): string {
	const decoded = safeBase64Decode(saleorOrderId);

	if (decoded && decoded.startsWith(SALEOR_ID_PREFIX)) {
		return decoded.slice(SALEOR_ID_PREFIX.length);
	}

	return saleorOrderId;
}

/**
 * Converts a ShipStation identifier into a complete Saleor GraphQL order ID,
 * but only when it can safely be recognized as belonging to Saleor.
 */
export function parseShipstationSaleorOrderId(value: string): string | null {
	const candidate = value.trim();

	if (!candidate) {
		return null;
	}

	const decoded = safeBase64Decode(candidate);
	if (decoded?.startsWith(SALEOR_ID_PREFIX)) {
		return candidate;
	}

	if (UUID_PATTERN.test(candidate)) {
		return expandToSaleorOrderId(candidate);
	}

	return null;
}

export function expandToSaleorOrderId(externalShipmentId: string): string {
	const decoded = safeBase64Decode(externalShipmentId);

	if (decoded && decoded.startsWith(SALEOR_ID_PREFIX)) {
		return externalShipmentId;
	}

	return Buffer.from(`${SALEOR_ID_PREFIX}${externalShipmentId}`, "utf8").toString("base64");
}

function safeBase64Decode(value: string): string | null {
	if (!/^[A-Za-z0-9+/]+=*$/.test(value)) {
		return null;
	}

	try {
		const decoded = Buffer.from(value, "base64").toString("utf8");
		const reencoded = Buffer.from(decoded, "utf8").toString("base64");

		return reencoded === value ? decoded : null;
	} catch {
		return null;
	}
}
