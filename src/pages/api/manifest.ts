import { createManifestHandler } from "@saleor/app-sdk/handlers/next";
import { AppManifest } from "@saleor/app-sdk/types";

import packageJson from "../../../package.json";
import { orderCancelledWebhook } from "./webhooks/saleor/order-cancelled";
import { orderCreatedWebhook } from "./webhooks/saleor/order-created";

export default createManifestHandler({
	async manifestFactory({ appBaseUrl }) {
		const iframeBaseUrl = process.env.APP_IFRAME_BASE_URL ?? appBaseUrl;
		const apiBaseUrl = process.env.APP_API_BASE_URL ?? appBaseUrl;

		const manifest: AppManifest = {
			name: "InfinityBio ShipStation",
			id: "infinitybio.app.shipstation",
			version: packageJson.version,
			appUrl: iframeBaseUrl,
			tokenTargetUrl: `${apiBaseUrl}/api/register`,
			author: "InfinityBio Labs",
			permissions: ["MANAGE_ORDERS"],
			webhooks: [
				orderCreatedWebhook.getWebhookManifest(apiBaseUrl),
				orderCancelledWebhook.getWebhookManifest(apiBaseUrl),
			],
			extensions: [],
		};

		return manifest;
	},
});
