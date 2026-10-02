import { SaleorAsyncWebhook } from "@saleor/app-sdk/handlers/next";
import gql from "graphql-tag";

import { env, requireSaleorApiUrl } from "@/env";
import { saleorApp } from "@/saleor-app";
import { createLogger } from "@/lib/logger";
import { claimWebhookEvent, releaseWebhookEvent } from "@/lib/idempotency";
import { createSaleorClient } from "@/lib/saleor/client";
import { confirmFullyPaidOrder } from "@/lib/saleor/mutations";
import { sendManualPaymentConfirmation } from "@/lib/email/manual-payment-confirmation";
import { ShipstationApiError } from "@/lib/shipstation/client";
import { syncSaleorCustomerToShipstationV1 } from "@/lib/shipstation/v1-customer-sync";
import type { SaleorOrderForShipstation } from "@/lib/shipstation/map-saleor-order";

const logger = createLogger("webhook:order-fully-paid");

const SUBSCRIPTION = gql`
	fragment OrderFullyPaidPayload on OrderFullyPaid {
		order {
			id
			number
			created
			customerNote
			metadata {
				key
				value
			}
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
				undiscountedUnitPrice {
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

	const method = order.metadata?.find((entry) => entry.key === "manual_payment_method")?.value;
	const isManualPayment = method === "cash_app" || method === "zelle" || method === "venmo";
	const storedCustomerEmail = order.metadata?.find(
		(entry) => entry.key === "manual_payment_customer_email",
	)?.value;
	const customerEmail = storedCustomerEmail || order.userEmail || order.user?.email;
	// Manual orders temporarily use a notification sink as Saleor's order email so
	// its native order/payment messages do not reach the customer. Use the stored
	// customer address for our email and ShipStation, then restore it below so later
	// fulfillment and shipping messages continue normally.
	const customerOrder = isManualPayment ? { ...order, userEmail: customerEmail ?? null } : order;
	const saleorApiUrl = requireSaleorApiUrl();
	const authData = await saleorApp.apl.get(saleorApiUrl);
	if (!authData) {
		await releaseWebhookEvent(claimKey);
		return res.status(500).json({ ok: false, reason: "Saleor app authentication is unavailable" });
	}
	const saleorClient = createSaleorClient({
		saleorApiUrl: authData.saleorApiUrl,
		token: authData.token,
	});
	const confirmation = await confirmFullyPaidOrder(saleorClient, {
		orderId: order.id,
		customerEmail,
		// Manual payments use our branded confirmation below. Card orders keep
		// Saleor's normal confirmation email.
		suppressNativeEmail: isManualPayment,
		notificationSinkEmail: env.MANUAL_PAYMENT_NOTIFICATION_SINK_EMAIL,
	});
	if (!confirmation.ok) {
		await releaseWebhookEvent(claimKey);
		logger.error("Unable to confirm fully paid Saleor order", {
			saleorOrderId: order.id,
			reason: confirmation.reason,
		});
		return res.status(502).json({ ok: false, reason: confirmation.reason });
	}

	if (isManualPayment) {
		const emailClaimKey = `manual-payment-confirmed-email:${order.id}`;
		if (await claimWebhookEvent(emailClaimKey)) {
			const sent = await sendManualPaymentConfirmation(customerOrder, method, customerEmail);
			if (!sent) {
				await releaseWebhookEvent(emailClaimKey);
				await releaseWebhookEvent(claimKey);
				return res.status(502).json({
					ok: false,
					reason: "Manual-payment confirmation email could not be sent",
				});
			}
		}
	}
	try {
		const orderSync = await syncSaleorCustomerToShipstationV1(customerOrder);

		logger.info("ShipStation V1 order and customer synchronized", {
			saleorOrderId: order.id,
			shipstationOrderId: orderSync.orderId,
			customerUpdated: orderSync.updated,
		});

		return res.status(200).json({
			ok: true,
			shipstationOrderId: orderSync.orderId,
			customerUpdated: orderSync.updated,
		});
	} catch (error) {
		if (error instanceof ShipstationApiError) {
			logger.error("ShipStation API rejected the paid order", {
				saleorOrderId: order.id,
				status: error.status,
				reason: error.message,
			});

			const retryableStatus =
				error.status === 401 || error.status === 403 || error.status === 429 || error.status >= 500;
			const permanent = error.status >= 400 && error.status < 500 && !retryableStatus;

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
