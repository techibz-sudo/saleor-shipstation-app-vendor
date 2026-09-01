import gql from "graphql-tag";
import type { Client } from "urql";
import { createLogger } from "@/lib/logger";

const logger = createLogger("saleor:mutations");

const ORDER_CONFIRMATION_STATE_QUERY = gql`
	query OrderConfirmationState($id: ID!) {
		order(id: $id) {
			id
			status
			userEmail
		}
	}
`;

const ORDER_EMAIL_UPDATE_MUTATION = gql`
	mutation OrderEmailUpdate($id: ID!, $input: OrderUpdateInput!) {
		orderUpdate(id: $id, input: $input) {
			order {
				id
				userEmail
			}
			errors {
				field
				code
				message
			}
		}
	}
`;

const ORDER_CONFIRM_MUTATION = gql`
	mutation ConfirmPaidOrder($id: ID!) {
		orderConfirm(id: $id) {
			order {
				id
				status
			}
			errors {
				field
				code
				message
			}
		}
	}
`;

export async function confirmFullyPaidOrder(
	client: Client,
	args: {
		orderId: string;
		customerEmail?: string | null;
		suppressNativeEmail?: boolean;
		notificationSinkEmail?: string;
	},
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const loaded = await client
		.query<{
			order: { id: string; status: string; userEmail: string | null } | null;
		}>(ORDER_CONFIRMATION_STATE_QUERY, { id: args.orderId })
		.toPromise();
	if (loaded.error || !loaded.data?.order) {
		return { ok: false, reason: loaded.error?.message ?? "Saleor order not found" };
	}
	const originalEmail = args.customerEmail || loaded.data.order.userEmail;
	const updateEmail = async (userEmail: string) => {
		const result = await client
			.mutation<{
				orderUpdate: {
					order: { id: string } | null;
					errors: Array<{ code: string; message: string | null }>;
				};
			}>(ORDER_EMAIL_UPDATE_MUTATION, { id: args.orderId, input: { userEmail } })
			.toPromise();
		const errors = result.data?.orderUpdate.errors ?? [];
		return (
			result.error?.message || errors.map((error) => error.message || error.code).join("; ") || null
		);
	};
	if (loaded.data.order.status !== "UNCONFIRMED") {
		if (
			args.suppressNativeEmail &&
			originalEmail &&
			loaded.data.order.userEmail !== originalEmail
		) {
			const restoreError = await updateEmail(originalEmail);
			if (restoreError)
				return { ok: false, reason: `Unable to restore customer email: ${restoreError}` };
		}
		return { ok: true };
	}

	if (args.suppressNativeEmail && originalEmail) {
		const error = await updateEmail(
			args.notificationSinkEmail || "manual-payments@infinitybiolabs.com",
		);
		if (error)
			return { ok: false, reason: `Unable to suppress duplicate confirmation email: ${error}` };
	}

	const confirmed = await client
		.mutation<{
			orderConfirm: {
				order: { id: string } | null;
				errors: Array<{ code: string; message: string | null }>;
			};
		}>(ORDER_CONFIRM_MUTATION, { id: args.orderId })
		.toPromise();
	const confirmationErrors = confirmed.data?.orderConfirm.errors ?? [];
	const confirmationError =
		confirmed.error?.message ||
		confirmationErrors.map((error) => error.message || error.code).join("; ") ||
		(!confirmed.data?.orderConfirm.order ? "Saleor returned no confirmed order" : null);

	if (args.suppressNativeEmail && originalEmail) {
		const restoreError = await updateEmail(originalEmail);
		if (restoreError)
			return { ok: false, reason: `Unable to restore customer email: ${restoreError}` };
	}
	if (confirmationError) return { ok: false, reason: confirmationError };
	return { ok: true };
}

/**
 * Looks up the latest fulfillment for an order and creates one if none exists, so we
 * can attach tracking. Saleor's order.fulfillments field is empty until we (or the
 * Dashboard) create the fulfillment.
 *
 * Strategy:
 *   1. Read order.fulfillments — if non-empty, take the most-recent one.
 *   2. Otherwise, create a new fulfillment from the order's lines using `orderFulfill`.
 *   3. Attach tracking via `orderFulfillmentUpdateTracking`.
 *
 * Phase 1 keeps this minimal — partial fulfillments and multi-package shipments are TODOs.
 */
const ORDER_BY_ID_QUERY = gql`
	query OrderForTracking($id: ID!) {
		order(id: $id) {
			id
			number
			fulfillments {
				id
				status
				created
			}
			lines {
				id
				quantity
				quantityFulfilled
				allocations {
					quantity
					warehouse {
						id
					}
				}
			}
		}
	}
`;

const ORDER_FULFILL_MUTATION = gql`
	mutation OrderFulfill($order: ID!, $input: OrderFulfillInput!) {
		orderFulfill(order: $order, input: $input) {
			fulfillments {
				id
			}
			errors {
				field
				code
				message
			}
		}
	}
`;

const FULFILLMENT_UPDATE_TRACKING_MUTATION = gql`
	mutation FulfillmentUpdateTracking($id: ID!, $input: FulfillmentUpdateTrackingInput!) {
		orderFulfillmentUpdateTracking(id: $id, input: $input) {
			fulfillment {
				id
				trackingNumber
			}
			errors {
				field
				code
				message
			}
		}
	}
`;

interface OrderQueryResult {
	order: {
		id: string;
		number: string;
		fulfillments: Array<{ id: string; status: string; created: string }>;
		lines: Array<{
			id: string;
			quantity: number;
			quantityFulfilled: number;
			allocations: Array<{
				quantity: number;
				warehouse: { id: string };
			}>;
		}>;
	} | null;
}

interface FulfillmentMutationResult {
	orderFulfill: {
		fulfillments: Array<{ id: string }>;
		errors: Array<{ field: string | null; code: string; message: string | null }>;
	};
}

interface TrackingUpdateResult {
	orderFulfillmentUpdateTracking: {
		fulfillment: { id: string; trackingNumber: string } | null;
		errors: Array<{ field: string | null; code: string; message: string | null }>;
	};
}

interface WriteTrackingArgs {
	saleorOrderId: string;
	trackingNumber: string;
	notifyCustomer: boolean;
}

/**
 * Writes tracking back to a Saleor order. Creates a fulfillment if one doesn't exist
 * (covering the full set of unfulfilled lines).
 */
export async function writeTrackingToSaleorOrder(
	client: Client,
	{ saleorOrderId, trackingNumber, notifyCustomer }: WriteTrackingArgs,
): Promise<{ ok: true; fulfillmentId: string } | { ok: false; reason: string }> {
	const orderResult = await client
		.query<OrderQueryResult>(ORDER_BY_ID_QUERY, { id: saleorOrderId })
		.toPromise();

	if (orderResult.error || !orderResult.data?.order) {
		const reason = orderResult.error?.message ?? "Saleor order not found";
		logger.warn("Failed to load Saleor order", { saleorOrderId, reason });
		return { ok: false, reason };
	}

	const order = orderResult.data.order;
	let fulfillmentId = order.fulfillments.at(-1)?.id ?? null;

	if (!fulfillmentId) {
		const unfulfilledLines: Array<{
			orderLineId: string;
			stocks: Array<{ quantity: number; warehouse: string }>;
		}> = [];

		for (const line of order.lines) {
			const remaining = line.quantity - line.quantityFulfilled;
			if (remaining <= 0) continue;

			// Saleor requires a warehouse id per stock entry. Pull it from the line's
			// existing allocations — that's the warehouse stock was already reserved from.
			const warehouseId = line.allocations[0]?.warehouse.id;
			if (!warehouseId) {
				return {
					ok: false,
					reason: `Order line ${line.id} has no stock allocations; cannot determine which warehouse to fulfill from. Confirm the order has stock reserved before triggering fulfillment.`,
				};
			}

			unfulfilledLines.push({
				orderLineId: line.id,
				stocks: [{ quantity: remaining, warehouse: warehouseId }],
			});
		}

		if (unfulfilledLines.length === 0) {
			return { ok: false, reason: "Order has no unfulfilled lines and no existing fulfillment." };
		}

		logger.info("No fulfillment on order — creating one to attach tracking", {
			saleorOrderId,
			lineCount: unfulfilledLines.length,
		});

		const fulfillResult = await client
			.mutation<FulfillmentMutationResult>(ORDER_FULFILL_MUTATION, {
				order: saleorOrderId,
				input: {
					notifyCustomer: false,
					lines: unfulfilledLines,
				},
			})
			.toPromise();

		if (fulfillResult.error) {
			return { ok: false, reason: `orderFulfill: ${fulfillResult.error.message}` };
		}
		const errors = fulfillResult.data?.orderFulfill.errors ?? [];
		if (errors.length > 0) {
			return {
				ok: false,
				reason: `orderFulfill returned errors: ${errors.map((e) => `${e.code}/${e.field}: ${e.message}`).join("; ")}`,
			};
		}
		fulfillmentId = fulfillResult.data?.orderFulfill.fulfillments[0]?.id ?? null;
		if (!fulfillmentId) {
			return { ok: false, reason: "orderFulfill succeeded but returned no fulfillment id." };
		}
	}

	const trackingResult = await client
		.mutation<TrackingUpdateResult>(FULFILLMENT_UPDATE_TRACKING_MUTATION, {
			id: fulfillmentId,
			input: {
				trackingNumber,
				notifyCustomer,
			},
		})
		.toPromise();

	if (trackingResult.error) {
		return { ok: false, reason: `tracking update: ${trackingResult.error.message}` };
	}
	const errors = trackingResult.data?.orderFulfillmentUpdateTracking.errors ?? [];
	if (errors.length > 0) {
		return {
			ok: false,
			reason: `tracking update returned errors: ${errors.map((e) => `${e.code}/${e.field}: ${e.message}`).join("; ")}`,
		};
	}

	logger.info("Tracking written to Saleor order", { saleorOrderId, fulfillmentId, trackingNumber });
	return { ok: true, fulfillmentId };
}
