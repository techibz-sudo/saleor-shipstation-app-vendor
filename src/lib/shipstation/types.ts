import { z } from "zod";

/**
 * ShipStation API v2 schemas (https://docs.shipstation.com/openapi/).
 *
 * Differences from v1 to be aware of:
 *   - Base URL `api.shipstation.com/v2/` (not `ssapi.shipstation.com`)
 *   - Auth via single `api-key` header (no separate API secret)
 *   - "Orders" model replaced by "Shipments" + optional auto-created Sales Orders
 *   - Address fields renamed: `streetAddress1` → `address_line1`, `city` → `city_locality`, etc.
 *   - Weight units: `pound | ounce | gram | kilogram` (not `pounds | ounces | grams`)
 */

export const shipstationErrorSchema = z.object({
	request_id: z.string().optional(),
	errors: z
		.array(
			z.object({
				error_source: z.string().optional(),
				error_type: z.string().optional(),
				error_code: z.string().optional(),
				message: z.string(),
				field_name: z.string().optional(),
				field_value: z.string().optional(),
			}),
		)
		.optional(),
});

export const shipstationWeightSchema = z.object({
	value: z.number(),
	unit: z.enum(["pound", "ounce", "gram", "kilogram"]),
});

export const shipstationDimensionsSchema = z.object({
	unit: z.enum(["inch", "centimeter"]),
	length: z.number(),
	width: z.number(),
	height: z.number(),
});

export const shipstationMoneySchema = z.object({
	currency: z.string(),
	amount: z.number(),
});

export const shipstationAddressSchema = z.object({
	name: z.string(),
	phone: z.string().nullable().optional(),
	email: z.string().nullable().optional(),
	company_name: z.string().nullable().optional(),
	address_line1: z.string(),
	address_line2: z.string().nullable().optional(),
	address_line3: z.string().nullable().optional(),
	city_locality: z.string(),
	state_province: z.string(),
	postal_code: z.string(),
	country_code: z.string(), // ISO-2
	address_residential_indicator: z.boolean().nullable().optional(),
});

export const shipstationPackageSchema = z.object({
	weight: shipstationWeightSchema,
	dimensions: shipstationDimensionsSchema.optional(),
	insured_value: shipstationMoneySchema.optional(),
});

export const shipstationItemOptionSchema = z.object({
	name: z.string(),
	value: z.string(),
});

export const shipstationItemSchema = z.object({
	name: z.string(),
	quantity: z.number().int().nonnegative(),
	sku: z.string().nullable().optional(),
	unit_price: z.number().nullable().optional(),
	image_url: z.string().nullable().optional(),
	weight: shipstationWeightSchema.optional(),
	external_order_id: z.string().nullable().optional(),
	external_order_item_id: z.string().nullable().optional(),
	options: z.array(shipstationItemOptionSchema).optional(),
});

export const shipstationShipmentInputSchema = z.object({
	external_shipment_id: z.string().max(50),
	external_order_id: z.string().max(50).optional(),
	order_number: z.string().optional(),
	ship_date: z.string().optional(),
	create_sales_order: z.boolean().optional(),
	store_id: z.string().optional(),
	// Either warehouse_id OR ship_from must be present — ShipStation v2 enforces it
	// (400 field_value_required otherwise).
	warehouse_id: z.string().optional(),
	shipment_status: z.enum(["pending", "processing", "label_purchased", "cancelled"]),
	amount_paid: shipstationMoneySchema.optional(),
	shipping_paid: shipstationMoneySchema.optional(),
	tax_paid: shipstationMoneySchema.optional(),
	ship_to: shipstationAddressSchema,
	ship_from: shipstationAddressSchema.optional(),
	packages: z.array(shipstationPackageSchema).min(1),
	items: z.array(shipstationItemSchema).optional(),
	notes_from_buyer: z.string().nullable().optional(),
	internal_notes: z.string().nullable().optional(),
	tags: z.array(z.string()).optional(),
});

export const shipstationCreateShipmentsRequestSchema = z.object({
	shipments: z.array(shipstationShipmentInputSchema).min(1),
});

export const shipstationShipmentResponseSchema = z.object({
	shipment_id: z.union([z.string(), z.number()]),
	external_shipment_id: z.string().nullable().optional(),
	shipment_status: z.string().optional(),
	tracking_number: z.string().nullable().optional(),
	carrier_id: z.union([z.string(), z.number()]).nullable().optional(),
	order_number: z.string().nullable().optional(),
});

export const shipstationCreateShipmentsResponseSchema = z.object({
	shipments: z.array(shipstationShipmentResponseSchema).optional(),
	// Some success responses come back as a single shipment object
	shipment_id: z.union([z.string(), z.number()]).optional(),
});

// Subset of label fields we care about. ShipStation returns many more, but we only
// need ids + tracking + voided flag for the void/cancel and tracking-writeback flows.
export const shipstationLabelSchema = z.object({
	label_id: z.union([z.string(), z.number()]),
	shipment_id: z.union([z.string(), z.number()]).nullable().optional(),
	external_shipment_id: z.string().nullable().optional(),
	status: z.string().optional(),
	voided: z.boolean().optional(),
	tracking_number: z.string().nullable().optional(),
	carrier_id: z.union([z.string(), z.number()]).nullable().optional(),
	carrier_code: z.string().nullable().optional(),
	ship_date: z.string().nullable().optional(),
});

/**
 * `label_created_v2`'s `resource_url` points at `/v2/labels?batch_id=…`, which
 * returns this paginated labels collection — NOT a shipment. A batch can contain
 * more than one label, so callers must handle the full array.
 */
export const shipstationLabelsListSchema = z.object({
	labels: z.array(shipstationLabelSchema).optional(),
});

export type ShipstationShipmentInput = z.infer<typeof shipstationShipmentInputSchema>;
export type ShipstationShipmentResponse = z.infer<typeof shipstationShipmentResponseSchema>;
export type ShipstationCreateShipmentsResponse = z.infer<typeof shipstationCreateShipmentsResponseSchema>;
export type ShipstationLabel = z.infer<typeof shipstationLabelSchema>;

/**
 * Webhook event envelopes. ShipStation v2 events relevant to us:
 *   - `label_created_v2` — fires when a label is purchased; payload includes the tracking number
 *   - `track_event_v2` — carrier-level tracking updates
 *   - `fulfillment_shipped_v2` — shipment marked as shipped in ShipStation
 *
 * The payload schemas below are best-effort; v2 webhook payloads are not fully
 * documented and may include more fields. We validate only the fields we depend on.
 */
export const shipstationLabelCreatedPayloadSchema = z.object({
	resource_url: z.string().url().optional(),
	resource_type: z.string().optional(),
	data: z
		.object({
			label_id: z.union([z.string(), z.number()]).optional(),
			shipment_id: z.union([z.string(), z.number()]).optional(),
			external_shipment_id: z.string().nullable().optional(),
			tracking_number: z.string().nullable().optional(),
			carrier_id: z.union([z.string(), z.number()]).nullable().optional(),
			carrier_code: z.string().nullable().optional(),
			service_code: z.string().nullable().optional(),
			ship_date: z.string().nullable().optional(),
			voided: z.boolean().optional(),
		})
		.optional(),
});

export type ShipstationLabelCreatedPayload = z.infer<typeof shipstationLabelCreatedPayloadSchema>;

export interface ResolvedShipmentTracking {
	saleorOrderId: string;
	trackingNumber: string;
	carrierCode: string | null;
	shipDate: string | null;
	// ShipStation shipment id for this label — used as the dedup key so a batch with
	// multiple labels is processed once per label.
	shipmentId: string | null;
}
