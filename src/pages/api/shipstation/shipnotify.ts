import type { NextApiRequest, NextApiResponse } from "next";
import { timingSafeEqual } from "node:crypto";

import { env, requireSaleorApiUrl, requireShipnotifyToken } from "@/env";
import { saleorApp } from "@/saleor-app";
import { claimWebhookEvent, releaseWebhookEvent } from "@/lib/idempotency";
import { createLogger } from "@/lib/logger";
import { createSaleorClient } from "@/lib/saleor/client";
import { writeTrackingToSaleorOrder } from "@/lib/saleor/mutations";
import { expandToSaleorOrderId } from "@/lib/saleor/order-id";
import { shipstationClient, ShipstationApiError } from "@/lib/shipstation/client";
import {
	shipstationLabelCreatedPayloadSchema,
	type ResolvedShipmentTracking,
} from "@/lib/shipstation/types";

const logger = createLogger("webhook:shipstation-shipnotify");

/**
 * Inbound webhook from ShipStation v2. Auth via a shared-secret header (default
 * `x-webhook-token`) configured into the ShipStation webhook's `headers` array
 * at creation time. The handler verifies the header against
 * SHIPSTATION_WEBHOOK_TOKEN with timingSafeEqual.
 *
 * Configure on ShipStation side:
 *   POST /v2/environment/webhooks
 *   {
 *     "name": "Saleor tracking sync",
 *     "event": "label_created_v2",
 *     "url": "https://<APP_API_BASE_URL>/api/shipstation/shipnotify",
 *     "headers": [{ "key": "x-webhook-token", "value": "<SHIPSTATION_WEBHOOK_TOKEN>" }]
 *   }
 *
 * @see https://docs.shipstation.com/openapi/webhooks
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	if (req.method !== "POST") {
		res.setHeader("Allow", "POST");
		return res.status(405).json({ error: "Method not allowed" });
	}

	if (!isAuthorized(req)) {
		// Fail-closed; don't disclose whether the route exists.
		return res.status(404).json({ error: "Not found" });
	}

	const parseResult = shipstationLabelCreatedPayloadSchema.safeParse(req.body);
	if (!parseResult.success) {
		logger.warn("Rejected malformed ShipStation webhook payload", {
			issues: parseResult.error.flatten().fieldErrors,
		});
		return res.status(400).json({ error: "Malformed webhook payload" });
	}

	try {
		const resolved = await resolveTrackingFromPayload(parseResult.data);
		if (!resolved.ok) {
			return res.status(resolved.status).json({ ok: false, reason: resolved.reason });
		}

		// Look up auth data for the specific Saleor we serve. apl.getAll() is not
		// supported by every APL (UpstashAPL throws), so we always go through get().
		const saleorApiUrl = requireSaleorApiUrl();
		const authData = await saleorApp.apl.get(saleorApiUrl);
		if (!authData) {
			logger.error("No Saleor auth data in APL for the configured SALEOR_API_URL", {
				saleorApiUrl,
			});
			return res.status(500).json({
				error: "Saleor not installed (yet) — no auth data for SALEOR_API_URL.",
			});
		}

		const saleorClient = createSaleorClient({
			saleorApiUrl: authData.saleorApiUrl,
			token: authData.token,
		});

		// A label_created_v2 batch can carry more than one label; write tracking for each.
		const results: Array<Record<string, unknown>> = [];
		let anyFailed = false;

		for (const tracking of resolved.values) {
			// Dedup per ShipStation shipment id. label_created_v2 retries on non-2xx, and
			// our Saleor writeback can take a few seconds — without this, a slow mutation +
			// retry could double-fulfill. We claim BEFORE the writeback (to block a
			// concurrent duplicate) and release on failure so retries can re-process.
			const claimKey = `shipstation-label-created:${tracking.shipmentId ?? tracking.saleorOrderId}`;
			const claimed = await claimWebhookEvent(claimKey);
			if (!claimed) {
				logger.info("Skipping duplicate label_created_v2 delivery", { claimKey });
				results.push({ saleorOrderId: tracking.saleorOrderId, deduplicated: true });
				continue;
			}

			// We shortened the Saleor ID on the outbound push (50-char ShipStation cap);
			// reconstitute the full base64 form before calling Saleor's GraphQL.
			const fullSaleorOrderId = expandToSaleorOrderId(tracking.saleorOrderId);

			const result = await writeTrackingToSaleorOrder(saleorClient, {
				saleorOrderId: fullSaleorOrderId,
				trackingNumber: tracking.trackingNumber,
				notifyCustomer: true,
			});

			if (!result.ok) {
				await releaseWebhookEvent(claimKey);
				anyFailed = true;
				logger.error("Failed to write tracking back to Saleor", {
					saleorOrderId: fullSaleorOrderId,
					reason: result.reason,
				});
				results.push({ saleorOrderId: fullSaleorOrderId, ok: false, reason: result.reason });
				continue;
			}

			results.push({
				saleorOrderId: fullSaleorOrderId,
				ok: true,
				fulfillmentId: result.fulfillmentId,
				trackingNumber: tracking.trackingNumber,
			});
		}

		// Non-2xx makes ShipStation retry the whole delivery. Already-succeeded labels are
		// skipped via dedup (same instance) or are idempotent on Saleor's side (the
		// existing fulfillment just gets the same tracking re-applied).
		if (anyFailed) {
			return res.status(500).json({ ok: false, results });
		}
		return res.status(200).json({ ok: true, results });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.error("Unhandled error in shipnotify handler", {
			message,
			stack: error instanceof Error ? error.stack : undefined,
		});
		return res.status(500).json({
			error: "Internal server error",
			detail: message,
		});
	}
}

type ResolvedTracking =
	| { ok: true; values: ResolvedShipmentTracking[] }
	| { ok: false; status: number; reason: string };

async function resolveTrackingFromPayload(
	payload: ReturnType<typeof shipstationLabelCreatedPayloadSchema.parse>,
): Promise<ResolvedTracking> {
	if (payload.data?.voided) {
		logger.info("Ignoring voided label", { shipmentId: payload.data?.shipment_id });
		return { ok: false, status: 200, reason: "voided" };
	}

	const inlineSaleorOrderId = payload.data?.external_shipment_id ?? null;
	const inlineTrackingNumber = payload.data?.tracking_number ?? null;

	// Fast path: v2 webhooks may include the data inline.
	if (inlineSaleorOrderId && inlineTrackingNumber) {
		return {
			ok: true,
			values: [
				{
					saleorOrderId: inlineSaleorOrderId,
					trackingNumber: inlineTrackingNumber,
					carrierCode: payload.data?.carrier_code ?? null,
					shipDate: payload.data?.ship_date ?? null,
					shipmentId: payload.data?.shipment_id != null ? String(payload.data.shipment_id) : null,
				},
			],
		};
	}

	// Otherwise resolve via resource_url, which for label_created_v2 points at
	// `/labels?batch_id=…` and can return multiple labels.
	if (!payload.resource_url) {
		const reason = !inlineSaleorOrderId ? "missing_external_shipment_id" : "no_tracking_number";
		logger.warn("Webhook payload has no resource_url and incomplete inline data", { reason });
		return { ok: false, status: 200, reason };
	}

	let labels;
	try {
		labels = await shipstationClient.getLabelsByUrl(payload.resource_url);
	} catch (error) {
		if (error instanceof ShipstationApiError) {
			logger.error("Failed to load labels from ShipStation", {
				status: error.status,
				reason: error.message,
				resourceUrl: payload.resource_url,
			});
			return { ok: false, status: 502, reason: "Could not load labels from ShipStation" };
		}
		throw error;
	}

	const values: ResolvedShipmentTracking[] = [];
	for (const label of labels) {
		if (label.voided) continue;
		const saleorOrderId = label.external_shipment_id ?? inlineSaleorOrderId ?? null;
		const trackingNumber = label.tracking_number ?? inlineTrackingNumber ?? null;
		if (!saleorOrderId || !trackingNumber) {
			logger.warn("Skipping label with insufficient data for tracking writeback", {
				labelId: label.label_id,
				hasExternalShipmentId: Boolean(saleorOrderId),
				hasTrackingNumber: Boolean(trackingNumber),
			});
			continue;
		}
		values.push({
			saleorOrderId,
			trackingNumber,
			carrierCode: label.carrier_code ?? null,
			shipDate: label.ship_date ?? null,
			shipmentId: label.shipment_id != null ? String(label.shipment_id) : null,
		});
	}

	if (values.length === 0) {
		logger.warn("resource_url returned no actionable labels", {
			resourceUrl: payload.resource_url,
			labelCount: labels.length,
		});
		return { ok: false, status: 200, reason: "no_actionable_labels" };
	}

	return { ok: true, values };
}

function isAuthorized(req: NextApiRequest): boolean {
	const expected = requireShipnotifyToken();
	const headerName = env.SHIPSTATION_WEBHOOK_HEADER.toLowerCase();
	const provided = readToken(req, headerName);
	if (!provided) return false;
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(provided, "utf8");
	if (a.length !== b.length) {
		timingSafeEqual(a, a);
		return false;
	}
	return timingSafeEqual(a, b);
}

function readToken(req: NextApiRequest, headerName: string): string | null {
	const headerValue = req.headers[headerName];
	if (typeof headerValue === "string" && headerValue.trim()) {
		return headerValue.trim();
	}
	if (Array.isArray(headerValue) && headerValue[0]?.trim()) {
		return headerValue[0].trim();
	}
	// Backwards compatibility: still accept ?token= for manual testing.
	const queryToken = typeof req.query.token === "string" ? req.query.token : null;
	return queryToken?.trim() || null;
}

export const config = {
	api: {
		bodyParser: true,
	},
};
