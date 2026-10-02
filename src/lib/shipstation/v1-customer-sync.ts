import { Buffer } from "node:buffer";

import { z } from "zod";

import { requireShipstationV1Credentials } from "@/env";
import { createLogger } from "@/lib/logger";
import { shortenSaleorOrderId } from "@/lib/saleor/order-id";
import { ShipstationApiError } from "@/lib/shipstation/client";
import type { SaleorAddress, SaleorOrderForShipstation } from "@/lib/shipstation/map-saleor-order";

const SHIPSTATION_V1_API_URL = "https://ssapi.shipstation.com";
const REQUEST_TIMEOUT_MS = 15_000;

const logger = createLogger("shipstation:v1-customer-sync");

const v1OrderSummarySchema = z
	.object({
		orderId: z.number(),
		orderNumber: z.string(),
		orderKey: z.string().nullable().optional(),
		orderStatus: z.string().optional(),
		customerUsername: z.string().nullable().optional(),
	})
	.passthrough();

const v1OrdersResponseSchema = z
	.object({
		orders: z.array(v1OrderSummarySchema),
	})
	.passthrough();

const v1OrderResponseSchema = z
	.object({
		orderId: z.number(),
		orderNumber: z.string(),
		orderKey: z.string(),
		customerId: z.number().nullable().optional(),
		customerUsername: z.string().nullable().optional(),
	})
	.passthrough();

interface V1RequestOptions {
	method?: "GET" | "POST" | "DELETE";
	body?: unknown;
}

export interface ShipstationV1OrderInput {
	orderNumber: string;
	orderKey: string;
	orderDate: string;
	orderStatus: "awaiting_shipment";
	customerUsername: string;
	customerEmail: string;
	billTo: ShipstationV1Address;
	shipTo: ShipstationV1Address;
	items: ShipstationV1OrderItem[];
	amountPaid: number;
	shippingAmount: number;
	customerNotes?: string;
	internalNotes: string;
	requestedShippingService?: string;
	weight: {
		value: number;
		units: "grams" | "ounces" | "pounds";
	};
	advancedOptions: {
		customField1: string;
		source: string;
	};
}

interface ShipstationV1Address {
	name: string;
	company?: string;
	street1: string;
	street2?: string;
	city: string;
	state?: string;
	postalCode: string;
	country: string;
	phone?: string;
	residential: boolean;
}

interface ShipstationV1OrderItem {
	lineItemKey: string;
	sku?: string;
	name: string;
	quantity: number;
	unitPrice: number;
	imageUrl?: string;
	options?: Array<{
		name: string;
		value: string;
	}>;
}

export interface CustomerSyncResult {
	orderId: number;
	updated: boolean;
	customerId?: number | null;
}

function parseJson(text: string): unknown {
	if (!text) {
		return null;
	}

	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function getErrorMessage(payload: unknown, status: number): string {
	if (typeof payload === "string" && payload.trim()) {
		return payload;
	}

	if (payload && typeof payload === "object") {
		const record = payload as Record<string, unknown>;
		const message =
			record.Message ?? record.message ?? record.ExceptionMessage ?? record.exceptionMessage;

		if (typeof message === "string" && message.trim()) {
			return message;
		}
	}

	return `ShipStation V1 returned HTTP ${status}`;
}

async function requestV1(
	path: string,
	{ method = "GET", body }: V1RequestOptions = {},
): Promise<unknown> {
	const { apiKey, apiSecret } = requireShipstationV1Credentials();
	const authorization = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(`${SHIPSTATION_V1_API_URL}${path}`, {
			method,
			headers: {
				Accept: "application/json",
				Authorization: `Basic ${authorization}`,
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: controller.signal,
		});

		const payload = parseJson(await response.text());

		if (!response.ok) {
			throw new ShipstationApiError(
				getErrorMessage(payload, response.status),
				response.status,
				payload,
			);
		}

		return payload;
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new ShipstationApiError(
				`ShipStation V1 request timed out after ${REQUEST_TIMEOUT_MS}ms`,
				504,
			);
		}

		throw error;
	} finally {
		clearTimeout(timer);
	}
}

function normalizeEmail(order: SaleorOrderForShipstation): string | null {
	const email = order.userEmail ?? order.user?.email ?? null;
	const normalized = email?.trim().toLowerCase();

	return normalized || null;
}

function mapAddress(address: SaleorAddress): ShipstationV1Address {
	const name = [address.firstName, address.lastName].filter(Boolean).join(" ").trim();

	return {
		name: name || "Recipient",
		company: address.companyName || undefined,
		street1: address.streetAddress1,
		street2: address.streetAddress2 || undefined,
		city: address.city,
		state: address.countryArea || undefined,
		postalCode: address.postalCode,
		country: address.country.code,
		phone: address.phone || undefined,
		residential: true,
	};
}

function mapWeight(weight: SaleorOrderForShipstation["weight"]): ShipstationV1OrderInput["weight"] {
	if (!weight) {
		return { value: 1, units: "ounces" };
	}

	switch (weight.unit) {
		case "G":
			return { value: weight.value, units: "grams" };
		case "KG":
			return { value: weight.value * 1_000, units: "grams" };
		case "LB":
			return { value: weight.value, units: "pounds" };
		case "OZ":
			return { value: weight.value, units: "ounces" };
		case "TONNE":
			logger.warn("Unsupported Saleor weight unit for V1; defaulting to 1 ounce");
			return { value: 1, units: "ounces" };
	}
}

export function mapSaleorOrderToShipstationV1(
	order: SaleorOrderForShipstation,
): ShipstationV1OrderInput {
	if (!order.shippingAddress) {
		throw new Error(`Order ${order.number} has no shipping address; cannot sync its customer.`);
	}

	const customerEmail = normalizeEmail(order);
	if (!customerEmail) {
		throw new Error(
			`Order ${order.number} has no customer email; cannot create a ShipStation customer.`,
		);
	}

	const orderKey = shortenSaleorOrderId(order.id);
	const billingAddress = order.billingAddress ?? order.shippingAddress;

	return {
		orderNumber: order.number,
		orderKey,
		orderDate: order.created,
		orderStatus: "awaiting_shipment",
		customerUsername: customerEmail,
		customerEmail,
		billTo: mapAddress(billingAddress),
		shipTo: mapAddress(order.shippingAddress),
		items: order.lines.map((line) => ({
			lineItemKey: line.id,
			sku: line.productSku || undefined,
			name: line.variantName ? `${line.productName} — ${line.variantName}` : line.productName,
			quantity: line.quantity,
			unitPrice: line.unitPrice.gross.amount,
			imageUrl: line.thumbnail?.url || undefined,
			options: line.variantName ? [{ name: "Variant", value: line.variantName }] : undefined,
		})),
		amountPaid: order.total.gross.amount,
		shippingAmount: order.shippingPrice?.gross.amount ?? 0,
		customerNotes: order.customerNote?.trim() || undefined,
		internalNotes: `Saleor order ${order.number} (${order.id})`,
		requestedShippingService: order.shippingMethodName || undefined,
		weight: mapWeight(order.weight),
		advancedOptions: {
			customField1: `saleor:${order.id}`,
			source: "Saleor",
		},
	};
}

/**
 * Creates or updates a ShipStation V1 order using the Saleor order ID as
 * ShipStation's idempotency key. V1-created orders populate Customer records.
 */
export async function syncSaleorCustomerToShipstationV1(
	order: SaleorOrderForShipstation,
): Promise<CustomerSyncResult> {
	const input = mapSaleorOrderToShipstationV1(order);

	const createPayload = await requestV1("/orders/createorder", {
		method: "POST",
		body: input,
	});
	const created = v1OrderResponseSchema.safeParse(createPayload);

	if (!created.success) {
		throw new ShipstationApiError(
			"Unrecognized ShipStation V1 create-or-update response",
			502,
			createPayload,
		);
	}

	logger.info("Created or updated ShipStation V1 order and customer record", {
		orderId: created.data.orderId,
		orderNumber: created.data.orderNumber,
	});

	return {
		orderId: created.data.orderId,
		updated: true,
		customerId: created.data.customerId,
	};
}

export async function findSaleorOrderInShipstationV1(
	saleorOrderId: string,
	orderNumber: string,
): Promise<z.infer<typeof v1OrderSummarySchema> | null> {
	const orderKey = shortenSaleorOrderId(saleorOrderId);
	const params = new URLSearchParams({
		orderNumber,
		pageSize: "100",
	});

	const listPayload = await requestV1(`/orders?${params.toString()}`);
	const list = v1OrdersResponseSchema.safeParse(listPayload);

	if (!list.success) {
		throw new ShipstationApiError(
			"Unrecognized ShipStation V1 order-list response",
			502,
			listPayload,
		);
	}

	return list.data.orders.find((candidate) => candidate.orderKey === orderKey) ?? null;
}

export async function deleteShipstationV1Order(orderId: number): Promise<void> {
	await requestV1(`/orders/${orderId}`, {
		method: "DELETE",
	});
}
