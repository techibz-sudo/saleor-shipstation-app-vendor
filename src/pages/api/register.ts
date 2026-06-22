import { createAppRegisterHandler } from "@saleor/app-sdk/handlers/next";

import { saleorApp } from "@/saleor-app";

/**
 * Called by Saleor when the app is installed. Stores the auth token in the APL.
 *
 * Restrict which Saleor instances may install this app by populating allowedSaleorUrls;
 * leave empty to accept any caller (only safe in early single-tenant deploys).
 */
export default createAppRegisterHandler({
	apl: saleorApp.apl,
	allowedSaleorUrls: [
		...(process.env.NEXT_PUBLIC_SALEOR_API_URL ? [process.env.NEXT_PUBLIC_SALEOR_API_URL] : []),
		...(process.env.SALEOR_API_URL ? [process.env.SALEOR_API_URL] : []),
	],
});
