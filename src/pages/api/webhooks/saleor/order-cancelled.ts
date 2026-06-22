import { SaleorAsyncWebhook } from "@saleor/app-sdk/handlers/next";
import gql from "graphql-tag";

import { saleorApp } from "@/saleor-app";
import { createLogger } from "@/lib/logger";
import { claimWebhookEvent } from "@/lib/idempotency";
import { shortenSaleorOrderId } from "@/lib/saleor/order-id";
import { shipstationClient, ShipstationApiError } from "@/lib/shipstation/client";

const logger = createLogger("webhook:order-cancelled");

const SUBSCRIPTION = gql`
	subscription OrderCancelled {
		event {
			... on OrderCancelled {
				order {
					id
					number
				}
			}
		}
	}
`;

interface OrderCancelledPayload {
	order: { id: string; number: string } | null;
}

export const orderCancelledWebhook = new SaleorAsyncWebhook<OrderCancelledPayload>({
	name: "InfinityBio ShipStation — Order Cancelled",
	webhookPath: "api/webhooks/saleor/order-cancelled",
	event: "ORDER_CANCELLED",
	apl: saleorApp.apl,
	query: SUBSCRIPTION,
});

// Shipment statuses where cancellation is still possible. Past these (in_transit,
// delivered, etc.) ShipStation can't help and the carrier already has the package.
const CANCELLABLE_STATUSES = new Set(["pending", "processing", "label_purchased", "ready_to_ship"]);
const LABEL_VOID_REQUIRED_STATUSES = new Set(["label_purchased", "ready_to_ship"]);

export default orderCancelledWebhook.createHandler(async (req, res, ctx) => {
	const order = ctx.payload.order;
	if (!order) {
		logger.warn("ORDER_CANCELLED webhook received without an order payload");
		return res.status(200).json({ skipped: "no_order_payload" });
	}

	const shortOrderId = shortenSaleorOrderId(order.id);

	// Dedup at the order level — a cancellation should only be processed once,
	// even if Saleor retries the webhook. Naturally safe: re-processing would
	// either be a no-op (already cancelled in ShipStation) or fail confusingly.
	const claimed = await claimWebhookEvent(`order-cancelled:${order.id}`);
	if (!claimed) {
		logger.info("Skipping duplicate ORDER_CANCELLED delivery", { saleorOrderId: order.id });
		return res.status(200).json({ ok: true, deduplicated: true });
	}

	logger.info("ORDER_CANCELLED received", { saleorOrderId: order.id, number: order.number });

	try {
		const shipment = await shipstationClient.getShipmentByExternalId(shortOrderId);
		if (!shipment) {
			logger.info("No ShipStation shipment found — nothing to cancel", { saleorOrderId: order.id });
			return res.status(200).json({ ok: true, skipped: "no_shipment" });
		}

		const status = shipment.shipment_status ?? "unknown";

		if (status === "cancelled") {
			logger.info("ShipStation shipment already cancelled", { saleorOrderId: order.id });
			return res.status(200).json({ ok: true, alreadyCancelled: true });
		}

		if (!CANCELLABLE_STATUSES.has(status)) {
			// Carrier already has the package — surface the conflict to operators via logs
			// rather than failing the webhook.
			logger.warn("Cannot cancel ShipStation shipment in this state", {
				saleorOrderId: order.id,
				shipmentId: shipment.shipment_id,
				status,
			});
			return res.status(200).json({
				ok: false,
				skipped: "shipment_too_far_along",
				status,
			});
		}

		// If a label was purchased, void it before cancelling — ShipStation rejects
		// cancellation otherwise (400 invalid_status).
		if (LABEL_VOID_REQUIRED_STATUSES.has(status)) {
			const label = await shipstationClient.getLabelByExternalShipmentId(shortOrderId);
			if (label && !label.voided) {
				await shipstationClient.voidLabel(label.label_id);
				logger.info("Voided ShipStation label", { saleorOrderId: order.id, labelId: label.label_id });
			}
		}

		await shipstationClient.cancelShipment(shipment.shipment_id);
		logger.info("Cancelled ShipStation shipment", {
			saleorOrderId: order.id,
			shipmentId: shipment.shipment_id,
		});

		return res.status(200).json({
			ok: true,
			shipstationShipmentId: shipment.shipment_id,
		});
	} catch (error) {
		if (error instanceof ShipstationApiError) {
			logger.error("ShipStation API rejected the cancellation", {
				saleorOrderId: order.id,
				status: error.status,
				reason: error.message,
			});
			// 4xx = our request was bad, ack so Saleor stops retrying. 5xx = transient.
			const ack = error.status >= 400 && error.status < 500;
			return res.status(ack ? 200 : 502).json({
				ok: false,
				reason: error.message,
				ackedDespiteFailure: ack,
			});
		}
		logger.error("Unhandled error in ORDER_CANCELLED handler", {
			saleorOrderId: order.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return res.status(500).json({ ok: false });
	}
});

export const config = {
	api: {
		bodyParser: false,
	},
};
