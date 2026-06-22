import { SaleorAsyncWebhook } from "@saleor/app-sdk/handlers/next";
import gql from "graphql-tag";

import { env } from "@/env";
import { saleorApp } from "@/saleor-app";
import { createLogger } from "@/lib/logger";
import { shipstationClient, ShipstationApiError } from "@/lib/shipstation/client";
import {
	mapSaleorOrderToShipstation,
	type SaleorOrderForShipstation,
} from "@/lib/shipstation/map-saleor-order";

const logger = createLogger("webhook:order-created");

/**
 * Subscription payload Saleor sends with each ORDER_CREATED event. The fields here
 * mirror the SaleorOrderForShipstation interface so the mapper can consume the
 * payload directly without an extra type cast on the consumer side.
 */
const SUBSCRIPTION = gql`
	fragment OrderCreatedPayload on OrderCreated {
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

	subscription OrderCreated {
		event {
			...OrderCreatedPayload
		}
	}
`;

interface OrderCreatedPayload {
	order: SaleorOrderForShipstation | null;
}

export const orderCreatedWebhook = new SaleorAsyncWebhook<OrderCreatedPayload>({
	name: "InfinityBio ShipStation — Order Created",
	webhookPath: "api/webhooks/saleor/order-created",
	event: "ORDER_CREATED",
	apl: saleorApp.apl,
	query: SUBSCRIPTION,
});

export default orderCreatedWebhook.createHandler(async (req, res, ctx) => {
	const order = ctx.payload.order;

	if (!order) {
		logger.warn("ORDER_CREATED webhook received without an order payload");
		return res.status(200).json({ skipped: "no_order_payload" });
	}

	logger.info("ORDER_CREATED received", { saleorOrderId: order.id, number: order.number });

	const warehouseId = env.SHIPSTATION_WAREHOUSE_ID;
	if (!warehouseId) {
		logger.error(
			"SHIPSTATION_WAREHOUSE_ID not set — cannot create shipment without warehouse_id or ship_from",
			{ saleorOrderId: order.id },
		);
		return res.status(500).json({
			ok: false,
			reason: "SHIPSTATION_WAREHOUSE_ID env var is not configured. Fetch the id with `curl -H 'api-key: $KEY' https://api.shipstation.com/v2/warehouses` and set it in Vercel.",
		});
	}

	try {
		const shipstationShipment = mapSaleorOrderToShipstation(order, { warehouseId });
		const result = await shipstationClient.createShipment(shipstationShipment);
		logger.info("ShipStation v2 shipment created", {
			saleorOrderId: order.id,
			shipstationShipmentId: result.shipment_id,
		});
		return res.status(200).json({
			ok: true,
			shipstationShipmentId: result.shipment_id,
		});
	} catch (error) {
		if (error instanceof ShipstationApiError) {
			logger.error("ShipStation API rejected the order", {
				saleorOrderId: order.id,
				status: error.status,
				reason: error.message,
			});
			// 4xx from ShipStation = our payload is bad — ack the webhook so Saleor stops retrying.
			// 5xx = transient — return 5xx so Saleor retries per its webhook retry policy.
			const ack = error.status >= 400 && error.status < 500;
			return res.status(ack ? 200 : 502).json({
				ok: false,
				reason: error.message,
				ackedDespiteFailure: ack,
			});
		}
		logger.error("Unhandled error in ORDER_CREATED handler", {
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
