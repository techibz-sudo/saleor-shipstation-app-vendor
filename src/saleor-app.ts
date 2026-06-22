import type { APL } from "@saleor/app-sdk/APL";
import { EnvAPL } from "@saleor/app-sdk/APL/env";
import { FileAPL } from "@saleor/app-sdk/APL/file";
import { SaleorApp } from "@saleor/app-sdk/saleor-app";

import { env } from "@/env";

function buildApl(): APL {
	if (process.env.VERCEL === "1" || env.APL === "env") {
		return new EnvAPL({
			env: {
				token: process.env.SALEOR_APP_TOKEN ?? "",
				appId: process.env.SALEOR_APP_ID ?? "",
				saleorApiUrl: process.env.SALEOR_API_URL ?? "",
			},
		});
	}

	return new FileAPL({
		fileName: env.APL_FILE_PATH,
	});
}

export const saleorApp = new SaleorApp({
	apl: buildApl(),
});
