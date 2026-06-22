import { Client, cacheExchange, fetchExchange } from "urql";

export function createSaleorClient({
	saleorApiUrl,
	token,
}: {
	saleorApiUrl: string;
	token: string;
}): Client {
	return new Client({
		url: saleorApiUrl,
		exchanges: [cacheExchange, fetchExchange],
		fetchOptions: () => ({
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
		}),
	});
}
