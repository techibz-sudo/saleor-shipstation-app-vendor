import { SaleorAsyncWebhook } from "@saleor/app-sdk/handlers/next";
import gql from "graphql-tag";

import { env } from "@/env";
import { saleorApp } from "@/saleor-app";
import { createLogger } from "@/lib/logger";
import { claimWebhookEvent, releaseWebhookEvent } from "@/lib/idempotency";
import { shortenSaleorOrderId } from "@/lib/saleor/order-id";
import { shipstationClient, ShipstationApiError } from "@/lib/shipstation/client";
import {
	mapSaleorOrderToShipstation,
	type SaleorOrderForShipstation,
} from "@/lib/shipstation/map-saleor-order";

const logger = createLogger("webhook:order-fully-paid");

const SUBSCRIPTION = gql`
	fragment OrderFullyPaidPayload on OrderFullyPaid {
		order {
			id
			number
			created
			customerNote
			userEmail
			user {
				email
			}
			shippingMethodName
			weight {
				value
				unit
			}
			total {
				gross {
					amount
					currency
				}
			}
			shippingPrice {
				gross {
					amount
				}
			}
			billingAddress {
				firstName
				lastName
				companyName
				streetAddress1
				streetAddress2
				city
				countryArea
				postalCode
				country {
					code
				}
				phone
			}
			shippingAddress {
				firstName
				lastName
				companyName
				streetAddress1
				streetAddress2
				city
				countryArea
				postalCode
				country {
					code
				}
				phone
			}
			lines {
				id
				productSku
				productName
				variantName
				quantity
				unitPrice {
					gross {
						amount
					}
				}
				thumbnail {
					url
				}
			}
		}
	}

	subscription OrderFullyPaid {
		event {
			...OrderFullyPaidPayload
		}
	}
`;

interface OrderFullyPaidPayload {
	order: SaleorOrderForShipstation | null;
}

export const orderFullyPaidWebhook = new SaleorAsyncWebhook<OrderFullyPaidPayload>({
	name: "InfinityBio ShipStation — Order Fully Paid",
	webhookPath: "api/webhooks/saleor/order-fully-paid",
	event: "ORDER_FULLY_PAID",
	apl: saleorApp.apl,
	query: SUBSCRIPTION,
});

export default orderFullyPaidWebhook.createHandler(async (req, res, ctx) => {
	const order = ctx.payload.order;
	if (!order) {
		logger.warn("ORDER_FULLY_PAID webhook received without an order payload");
		return res.status(200).json({ skipped: "no_order_payload" });
	}

	const claimKey = `order-fully-paid:${order.id}`;
	if (!(await claimWebhookEvent(claimKey))) {
		logger.info("Skipping duplicate ORDER_FULLY_PAID delivery", { saleorOrderId: order.id });
		return res.status(200).json({ ok: true, deduplicated: true });
	}

	logger.info("ORDER_FULLY_PAID received", { saleorOrderId: order.id, number: order.number });
	const warehouseId = env.SHIPSTATION_WAREHOUSE_ID;
	if (!warehouseId) {
		await releaseWebhookEvent(claimKey);
		logger.error("SHIPSTATION_WAREHOUSE_ID not set — shipment creation is disabled", {
			saleorOrderId: order.id,
		});
		return res
			.status(500)
			.json({ ok: false, reason: "SHIPSTATION_WAREHOUSE_ID is not configured" });
	}

	try {
		const externalId = shortenSaleorOrderId(order.id);
		const existing = await shipstationClient.getShipmentByExternalId(externalId);
		if (existing) {
			logger.info("ShipStation shipment already exists", {
				saleorOrderId: order.id,
				shipstationShipmentId: existing.shipment_id,
			});
			return res.status(200).json({
				ok: true,
				deduplicated: true,
				shipstationShipmentId: existing.shipment_id,
			});
		}

		const result = await shipstationClient.createShipment(
			mapSaleorOrderToShipstation(order, { warehouseId }),
		);
		logger.info("ShipStation v2 shipment created", {
			saleorOrderId: order.id,
			shipstationShipmentId: result.shipment_id,
		});
		return res.status(200).json({ ok: true, shipstationShipmentId: result.shipment_id });
	} catch (error) {
		if (error instanceof ShipstationApiError) {
			logger.error("ShipStation API rejected the paid order", {
				saleorOrderId: order.id,
				status: error.status,
				reason: error.message,
			});
			const permanent = error.status >= 400 && error.status < 500;
			if (!permanent) await releaseWebhookEvent(claimKey);
			return res.status(permanent ? 200 : 502).json({
				ok: false,
				reason: error.message,
				ackedDespiteFailure: permanent,
			});
		}
		await releaseWebhookEvent(claimKey);
		logger.error("Unhandled error in ORDER_FULLY_PAID handler", {
			saleorOrderId: order.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return res.status(500).json({ ok: false });
	}
});

export const config = { api: { bodyParser: false } };
