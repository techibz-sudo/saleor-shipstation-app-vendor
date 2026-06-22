import { z } from "zod";

const envSchema = z
	.object({
		APP_API_BASE_URL: z.string().url().optional(),
		APP_IFRAME_BASE_URL: z.string().url().optional(),
		// Restricts which Saleor instance may install this app. Empty = allow any (only safe in dev).
		SALEOR_API_URL: z.string().url().optional(),
		NEXT_PUBLIC_SALEOR_API_URL: z.string().url().optional(),
		// `file` for local dev, `env` for Vercel and any serverless host.
		APL: z.enum(["file", "env"]).default("file"),
		APL_FILE_PATH: z.string().optional(),
		// Required when APL=env (or on Vercel). Get from Saleor Dashboard → Apps → app → Tokens.
		SALEOR_APP_TOKEN: z.string().min(1).optional(),
		SALEOR_APP_ID: z.string().min(1).optional(),
		// ShipStation v2 uses a single API key — no separate secret.
		SHIPSTATION_API_KEY: z.string().min(1).optional(),
		// Warehouse to bind new shipments to (provides the ship_from address).
		// Fetch with: curl -H "api-key: $KEY" https://api.shipstation.com/v2/warehouses
		// Required for the v2 /shipments POST — without it (and without an explicit
		// ship_from) ShipStation returns 400 field_value_required.
		SHIPSTATION_WAREHOUSE_ID: z.string().min(1).optional(),
		// Shared secret ShipStation must include as a custom webhook header.
		// We configure both ends to use the same value; the app rejects mismatches.
		SHIPSTATION_WEBHOOK_TOKEN: z.string().min(16).optional(),
		// Header name ShipStation should put the token in (configured into the v2 webhook
		// at creation time via the `headers` array). Default keeps things obvious in logs.
		SHIPSTATION_WEBHOOK_HEADER: z.string().default("x-webhook-token"),
		LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
	})
	.superRefine((data, ctx) => {
		if (data.APL === "env" && !data.SALEOR_APP_TOKEN) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "SALEOR_APP_TOKEN is required when APL=env.",
				path: ["SALEOR_APP_TOKEN"],
			});
		}
	});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
	// eslint-disable-next-line no-console
	console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
	throw new Error("Invalid environment variables; refusing to start.");
}

export const env = parsed.data;

export function requireShipstationApiKey(): string {
	if (!env.SHIPSTATION_API_KEY) {
		throw new Error("SHIPSTATION_API_KEY must be set before calling the ShipStation API.");
	}
	return env.SHIPSTATION_API_KEY;
}

export function requireShipnotifyToken() {
	if (!env.SHIPSTATION_WEBHOOK_TOKEN) {
		throw new Error(
			"SHIPSTATION_WEBHOOK_TOKEN must be set to accept inbound ShipStation webhooks.",
		);
	}
	return env.SHIPSTATION_WEBHOOK_TOKEN;
}

export function requireSaleorApiUrl(): string {
	const url = env.SALEOR_API_URL ?? env.NEXT_PUBLIC_SALEOR_API_URL;
	if (!url) {
		throw new Error(
			"SALEOR_API_URL (or NEXT_PUBLIC_SALEOR_API_URL) must be set so we can look up the installed Saleor's auth token.",
		);
	}
	return url;
}
