import nodemailer from "nodemailer";

import { env } from "@/env";
import { createLogger } from "@/lib/logger";
import type { SaleorOrderForShipstation } from "@/lib/shipstation/map-saleor-order";

const logger = createLogger("email:manual-payment-confirmed");
const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type ManualPaymentMethod = "cash_app" | "zelle" | "venmo";

const methodLabels: Record<ManualPaymentMethod, string> = {
	cash_app: "Cash App",
	zelle: "Zelle",
	venmo: "Venmo",
};

const esc = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const money = (amount: number, currency: string) =>
	new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);

function addressText(order: SaleorOrderForShipstation): string[] {
	const address = order.shippingAddress;
	if (!address) return [];
	return [
		[address.firstName, address.lastName].filter(Boolean).join(" "),
		address.companyName ?? "",
		address.streetAddress1,
		address.streetAddress2 ?? "",
		[address.city, address.countryArea, address.postalCode].filter(Boolean).join(", "),
		address.country.code,
	].filter(Boolean);
}

export function renderManualPaymentConfirmation(
	order: SaleorOrderForShipstation,
	method: ManualPaymentMethod,
) {
	const currency = order.total.gross.currency;
	const total = money(order.total.gross.amount, currency);
	const shipping = money(order.shippingPrice?.gross.amount ?? 0, currency);
	const lines = order.lines.map((line) => ({
		label: `${line.productName}${line.variantName ? ` (${line.variantName})` : ""} × ${line.quantity}`,
		amount: money((line.undiscountedUnitPrice?.gross.amount ?? line.unitPrice.gross.amount) * line.quantity, currency),
	}));
	const address = addressText(order);
	const methodLabel = methodLabels[method];
	const lineRows = lines
		.map(
			(line) => `<tr><td style="padding:8px 0;color:#3a3a3a;">${esc(line.label)}</td><td align="right" style="padding:8px 0;color:#191919;font-weight:600;">${esc(line.amount)}</td></tr>`,
		)
		.join("");

	const html = `<!doctype html><html><body style="margin:0;background:#f4f2ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#191919;">
	<table role="presentation" width="100%"><tr><td align="center" style="padding:32px 12px;"><table role="presentation" width="600" style="max-width:600px;background:#fff;border:1px solid #e7e3db;border-radius:14px;overflow:hidden;">
	<tr><td style="height:4px;background:#0d9488;"></td></tr>
	<tr><td align="center" style="padding:28px 40px 8px;"><a href="https://www.infinitybiolabs.com"><img src="https://api.infinitybiolabs.com/media/email/logo.png" width="180" alt="Infinity BioLabs" style="display:block;height:auto;"></a></td></tr>
	<tr><td style="padding:18px 40px 36px;">
	<h1 style="margin:0 0 12px;font-size:24px;">Your payment is confirmed</h1>
	<p style="margin:0 0 20px;color:#3a3a3a;line-height:1.6;">Thank you. We received your ${esc(methodLabel)} payment for order <strong>${esc(order.number)}</strong>. Your order is now confirmed and will move to fulfillment.</p>
	<table role="presentation" width="100%" style="margin-bottom:20px;background:#f4f2ee;border:1px solid #e7e3db;border-radius:10px;"><tr><td style="padding:16px 18px;"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#6b6b6b;">Order number</div><div style="font-size:17px;font-weight:700;margin:4px 0 12px;">${esc(order.number)}</div><div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#6b6b6b;">Payment method</div><div style="font-size:16px;font-weight:700;margin-top:4px;">${esc(methodLabel)}</div></td></tr></table>
	<h2 style="margin:0 0 8px;font-size:18px;">Order details</h2>
	<table role="presentation" width="100%" style="font-size:14px;border-bottom:1px solid #e7e3db;">${lineRows}<tr><td style="padding:10px 0;border-top:1px solid #e7e3db;">Shipping</td><td align="right" style="padding:10px 0;border-top:1px solid #e7e3db;">${esc(shipping)}</td></tr><tr><td style="padding:12px 0;font-weight:700;font-size:16px;">Order total</td><td align="right" style="padding:12px 0;font-weight:700;font-size:16px;">${esc(total)}</td></tr></table>
	${address.length ? `<h2 style="margin:24px 0 8px;font-size:18px;">Shipping address</h2><p style="margin:0 0 20px;color:#3a3a3a;line-height:1.55;">${address.map(esc).join("<br>")}</p>` : ""}
	<p style="margin:24px 0 0;color:#6b6b6b;font-size:13px;line-height:1.6;">Questions? Email <a href="mailto:${esc(env.MANUAL_PAYMENT_SUPPORT_EMAIL)}" style="color:#0d9488;">${esc(env.MANUAL_PAYMENT_SUPPORT_EMAIL)}</a>.</p>
	</td></tr></table></td></tr></table></body></html>`;

	const text = [
		"YOUR PAYMENT IS CONFIRMED",
		`We received your ${methodLabel} payment for order ${order.number}.`,
		"",
		"ORDER DETAILS",
		...lines.map((line) => `${line.label}: ${line.amount}`),
		`Shipping: ${shipping}`,
		`Order total: ${total}`,
		...(address.length ? ["", "SHIPPING ADDRESS", ...address] : []),
		"",
		`Questions: ${env.MANUAL_PAYMENT_SUPPORT_EMAIL}`,
	].join("\n");

	return { subject: `Payment confirmed for order ${order.number}`, html, text };
}

export async function sendManualPaymentConfirmation(
	order: SaleorOrderForShipstation,
	method: ManualPaymentMethod,
): Promise<boolean> {
	const to = order.userEmail ?? order.user?.email;
	if (!to) {
		logger.error("Manual-payment order has no customer email", { orderId: order.id });
		return false;
	}
	const message = renderManualPaymentConfirmation(order, method);

	try {
		if (env.EMAIL_SMTP_HOST) {
			const transporter = nodemailer.createTransport({
				host: env.EMAIL_SMTP_HOST,
				port: env.EMAIL_SMTP_PORT,
				secure: env.EMAIL_SMTP_SECURE?.toLowerCase() === "true",
				...(env.EMAIL_SMTP_USER
					? { auth: { user: env.EMAIL_SMTP_USER, pass: env.EMAIL_SMTP_PASSWORD ?? "" } }
					: {}),
			});
			await transporter.sendMail({
				from: env.MANUAL_PAYMENT_FROM_EMAIL,
				to,
				replyTo: env.MANUAL_PAYMENT_SUPPORT_EMAIL,
				...message,
			});
			return true;
		}

		if (!env.RESEND_API_KEY) {
			logger.error("Neither EMAIL_SMTP_HOST nor RESEND_API_KEY is configured");
			return false;
		}
		const response = await fetch(RESEND_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.RESEND_API_KEY}`,
				"Content-Type": "application/json",
				"Idempotency-Key": `manual-payment-confirmed-${order.number}-${order.id.replace(/[^A-Za-z0-9_-]/g, "")}`,
			},
			body: JSON.stringify({
				from: env.MANUAL_PAYMENT_FROM_EMAIL,
				to: [to],
				reply_to: env.MANUAL_PAYMENT_SUPPORT_EMAIL,
				...message,
			}),
		});
		if (!response.ok) {
			logger.error("Resend rejected manual-payment confirmation", {
				orderId: order.id,
				status: response.status,
			});
			return false;
		}
		return true;
	} catch (error) {
		logger.error("Manual-payment confirmation email failed", {
			orderId: order.id,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}
