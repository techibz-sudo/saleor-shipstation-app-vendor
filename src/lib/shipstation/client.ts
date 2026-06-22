import { createLogger } from "@/lib/logger";
import { requireShipstationApiKey } from "@/env";
import {
	shipstationCreateShipmentsRequestSchema,
	shipstationCreateShipmentsResponseSchema,
	shipstationErrorSchema,
	shipstationLabelSchema,
	shipstationLabelsListSchema,
	shipstationShipmentResponseSchema,
	type ShipstationLabel,
	type ShipstationShipmentInput,
	type ShipstationShipmentResponse,
} from "@/lib/shipstation/types";

const SHIPSTATION_API_URL = "https://api.shipstation.com/v2";
const REQUEST_TIMEOUT_MS = 15_000;

const logger = createLogger("shipstation:client");

interface QueryInput {
	method?: "GET" | "POST" | "PUT" | "DELETE";
	body?: unknown;
}

async function request<T>(
	pathOrUrl: string,
	{ method = "GET", body }: QueryInput = {},
): Promise<T> {
	const apiKey = requireShipstationApiKey();

	const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${SHIPSTATION_API_URL}${pathOrUrl}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			method,
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"api-key": apiKey,
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});

		const text = await response.text();
		const json: unknown = text ? safeJsonParse(text) : null;

		if (!response.ok) {
			const parsed = shipstationErrorSchema.safeParse(json);
			const message = parsed.success && parsed.data.errors?.length
				? parsed.data.errors.map((e) => `${e.error_code ?? e.error_type ?? "error"}: ${e.message}`).join("; ")
				: `HTTP ${response.status} ${response.statusText}`;
			logger.warn("ShipStation API error", { url, status: response.status, message });
			throw new ShipstationApiError(message, response.status, json);
		}

		return json as T;
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new ShipstationApiError(
				`ShipStation request timed out after ${REQUEST_TIMEOUT_MS}ms`,
				504,
			);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

export class ShipstationApiError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly raw?: unknown,
	) {
		super(message);
		this.name = "ShipstationApiError";
	}
}

export const shipstationClient = {
	async createShipment(input: ShipstationShipmentInput): Promise<ShipstationShipmentResponse> {
		const validated = shipstationCreateShipmentsRequestSchema.parse({ shipments: [input] });
		logger.info("Creating ShipStation v2 shipment", {
			external_shipment_id: validated.shipments[0]?.external_shipment_id,
		});
		const raw = await request<unknown>("/shipments", {
			method: "POST",
			body: validated,
		});
		const parsed = shipstationCreateShipmentsResponseSchema.safeParse(raw);
		if (!parsed.success) {
			throw new ShipstationApiError(
				"Unrecognized ShipStation create-shipment response shape",
				502,
				raw,
			);
		}
		const first = parsed.data.shipments?.[0];
		if (first) return first;
		// Some responses return a single object — coerce if shipment_id is present.
		if (parsed.data.shipment_id !== undefined) {
			return { shipment_id: parsed.data.shipment_id };
		}
		throw new ShipstationApiError(
			"ShipStation create-shipment returned no shipment_id",
			502,
			raw,
		);
	},

	// `label_created_v2`'s webhook `resource_url` points at `/labels?batch_id=…`,
	// which returns a labels collection (`{ labels: [...] }`) — NOT a shipment. A
	// batch can contain more than one label, so we return the whole array and let the
	// caller resolve each label's external_shipment_id + tracking_number.
	async getLabelsByUrl(resourceUrl: string): Promise<ShipstationLabel[]> {
		logger.debug("Fetching ShipStation labels by resource_url", { resourceUrl });
		const raw = await request<unknown>(resourceUrl);

		const list = shipstationLabelsListSchema.safeParse(raw);
		if (list.success && list.data.labels) return list.data.labels;

		// Defensive: some deliveries may hand back a single bare label object.
		const single = shipstationLabelSchema.safeParse(raw);
		if (single.success) return [single.data];

		throw new ShipstationApiError(
			"Unrecognized ShipStation labels payload shape",
			502,
			raw,
		);
	},

	// Returns null on 404 so callers can distinguish "never created" from "real error".
	// Used by the cancellation flow — if the shipment doesn't exist in ShipStation,
	// there's nothing to cancel and the webhook can be safely acked.
	async getShipmentByExternalId(externalShipmentId: string): Promise<ShipstationShipmentResponse | null> {
		try {
			const raw = await request<unknown>(
				`/shipments/external_shipment_id/${encodeURIComponent(externalShipmentId)}`,
			);
			const parsed = shipstationShipmentResponseSchema.safeParse(raw);
			if (parsed.success) return parsed.data;
			throw new ShipstationApiError(
				"Unrecognized ShipStation shipment-by-external-id payload shape",
				502,
				raw,
			);
		} catch (error) {
			if (error instanceof ShipstationApiError && error.status === 404) return null;
			throw error;
		}
	},

	async getLabelByExternalShipmentId(externalShipmentId: string): Promise<ShipstationLabel | null> {
		try {
			const raw = await request<unknown>(
				`/labels/external_shipment_id/${encodeURIComponent(externalShipmentId)}`,
			);
			const parsed = shipstationLabelSchema.safeParse(raw);
			if (parsed.success) return parsed.data;
			throw new ShipstationApiError(
				"Unrecognized ShipStation label-by-external-id payload shape",
				502,
				raw,
			);
		} catch (error) {
			if (error instanceof ShipstationApiError && error.status === 404) return null;
			throw error;
		}
	},

	async voidLabel(labelId: string | number): Promise<void> {
		logger.info("Voiding ShipStation label", { labelId });
		await request<unknown>(`/labels/${encodeURIComponent(String(labelId))}/void`, {
			method: "PUT",
		});
	},

	async cancelShipment(shipmentId: string | number): Promise<void> {
		logger.info("Cancelling ShipStation shipment", { shipmentId });
		await request<unknown>(`/shipments/${encodeURIComponent(String(shipmentId))}/cancel`, {
			method: "PUT",
		});
	},
};
