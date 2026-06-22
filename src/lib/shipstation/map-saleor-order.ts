import { createLogger } from "@/lib/logger";
import { shortenSaleorOrderId } from "@/lib/saleor/order-id";
import type { ShipstationShipmentInput } from "@/lib/shipstation/types";

const logger = createLogger("shipstation:map");

/** Minimal Saleor order shape used by the order-created webhook. Kept hand-typed
 *  on purpose for Phase 1 — we'll switch to graphql-codegen once the contract stabilises. */
export interface SaleorOrderForShipstation {
	id: string;
	number: string;
	created: string;
	userEmail: string | null;
	user: { email: string | null } | null;
	total: { gross: { amount: number; currency: string } };
	shippingPrice: { gross: { amount: number } } | null;
	weight: { value: number; unit: "G" | "KG" | "LB" | "OZ" | "TONNE" } | null;
	billingAddress: SaleorAddress | null;
	shippingAddress: SaleorAddress | null;
	lines: Array<{
		id: string;
		productSku: string | null;
		productName: string;
		variantName: string | null;
		quantity: number;
		unitPrice: { gross: { amount: number } };
		thumbnail: { url: string } | null;
	}>;
	shippingMethodName?: string | null;
	customerNote?: string | null;
}

export interface SaleorAddress {
	firstName: string;
	lastName: string;
	companyName: string | null;
	streetAddress1: string;
	streetAddress2: string | null;
	city: string;
	countryArea: string | null;
	postalCode: string;
	country: { code: string };
	phone: string | null;
}

function mapAddress(saleorAddress: SaleorAddress, fallbackEmail: string | null) {
	const fullName = [saleorAddress.firstName, saleorAddress.lastName]
		.filter(Boolean)
		.join(" ")
		.trim();
	return {
		name: fullName || "Recipient",
		company_name: saleorAddress.companyName || null,
		address_line1: saleorAddress.streetAddress1,
		address_line2: saleorAddress.streetAddress2 || null,
		city_locality: saleorAddress.city,
		state_province: saleorAddress.countryArea || saleorAddress.city,
		postal_code: saleorAddress.postalCode,
		country_code: saleorAddress.country.code,
		phone: saleorAddress.phone || null,
		email: fallbackEmail,
	};
}

type WeightUnit = "G" | "KG" | "LB" | "OZ" | "TONNE";

const SALEOR_TO_SHIPSTATION_UNIT: Record<
	WeightUnit,
	{ multiplier: number; unit: "gram" | "kilogram" | "pound" | "ounce" } | null
> = {
	G: { multiplier: 1, unit: "gram" },
	KG: { multiplier: 1, unit: "kilogram" },
	LB: { multiplier: 1, unit: "pound" },
	OZ: { multiplier: 1, unit: "ounce" },
	TONNE: null, // unsupported; we don't ship a tonne of peptides
};

function mapWeight(weight: SaleorOrderForShipstation["weight"]) {
	if (!weight) {
		// ShipStation requires a weight on every package; fall back to a token value
		// so the call succeeds, and let the warehouse override before purchasing the label.
		logger.warn("Order has no weight — defaulting to 1 ounce so ShipStation accepts the shipment");
		return { value: 1, unit: "ounce" as const };
	}
	const conversion = SALEOR_TO_SHIPSTATION_UNIT[weight.unit];
	if (!conversion) {
		logger.warn("Unsupported Saleor weight unit; defaulting to 1 ounce", { unit: weight.unit });
		return { value: 1, unit: "ounce" as const };
	}
	return {
		value: weight.value * conversion.multiplier,
		unit: conversion.unit,
	};
}

export interface MapOptions {
	/**
	 * ShipStation warehouse to bind the shipment to (provides the ship_from address).
	 * v2 requires either warehouse_id or an explicit ship_from. Fetch yours with:
	 *   curl -H "api-key: $KEY" https://api.shipstation.com/v2/warehouses
	 */
	warehouseId: string;
}

export function mapSaleorOrderToShipstation(
	order: SaleorOrderForShipstation,
	options: MapOptions,
): ShipstationShipmentInput {
	if (!order.shippingAddress) {
		throw new Error(
			`Order ${order.number} has no shipping address; cannot push to ShipStation.`,
		);
	}

	const customerEmail = order.userEmail ?? order.user?.email ?? null;
	const shipTo = mapAddress(order.shippingAddress, customerEmail);

	// Saleor's base64-encoded order IDs (`Order:<uuid>`) are 56 chars — over ShipStation's
	// 50-char `external_shipment_id` cap. Send the inner UUID instead; we reconstitute
	// the full Saleor ID when ShipStation's webhook calls back.
	const shortOrderId = shortenSaleorOrderId(order.id);

	const items = order.lines.map((line) => ({
		name: line.variantName
			? `${line.productName} — ${line.variantName}`
			: line.productName,
		quantity: line.quantity,
		sku: line.productSku || null,
		unit_price: line.unitPrice.gross.amount,
		image_url: line.thumbnail?.url || null,
		external_order_id: shortOrderId,
		...(line.variantName
			? { options: [{ name: "Variant", value: line.variantName }] }
			: {}),
	}));

	return {
		external_shipment_id: shortOrderId,
		external_order_id: shortOrderId,
		order_number: order.number,
		ship_date: order.created.slice(0, 10),
		create_sales_order: true,
		warehouse_id: options.warehouseId,
		shipment_status: "pending",
		amount_paid: order.total.gross.amount > 0
			? { amount: order.total.gross.amount, currency: order.total.gross.currency }
			: undefined,
		shipping_paid: order.shippingPrice?.gross.amount
			? { amount: order.shippingPrice.gross.amount, currency: order.total.gross.currency }
			: undefined,
		ship_to: shipTo,
		packages: [{ weight: mapWeight(order.weight) }],
		items,
		notes_from_buyer: order.customerNote?.trim() || undefined,
		internal_notes: `Saleor order ${order.number} (${order.id})`,
	};
}
