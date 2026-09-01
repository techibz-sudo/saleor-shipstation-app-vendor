const required = (name) => {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
};

const saleorApiUrl = required("SALEOR_API_URL");
const token = required("SALEOR_APP_TOKEN");
const appId = required("SALEOR_APP_ID");
const appBaseUrl = required("APP_API_BASE_URL").replace(/\/$/, "");

const request = async (query, variables) => {
	const response = await fetch(saleorApiUrl, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ query, variables }),
	});
	const result = await response.json();
	if (!response.ok || result.errors?.length) {
		throw new Error(JSON.stringify(result.errors || result, null, 2));
	}
	return result.data;
};

const manifestResponse = await fetch(`${appBaseUrl}/api/manifest`);
if (!manifestResponse.ok) {
	throw new Error(`Manifest returned HTTP ${manifestResponse.status}`);
}
const manifest = await manifestResponse.json();

const data = await request(
	`query InstalledAppWebhooks($id: ID!) {
		app(id: $id) {
			id
			name
			webhooks { id name targetUrl isActive asyncEvents { eventType } }
		}
	}`,
	{ id: appId },
);

if (!data.app) throw new Error(`Saleor app ${appId} was not found`);

const updateMutation = `mutation UpdateWebhook($id: ID!, $input: WebhookUpdateInput!) {
	webhookUpdate(id: $id, input: $input) {
		webhook { id name targetUrl isActive asyncEvents { eventType } }
		errors { field code message }
	}
}`;

for (const desired of manifest.webhooks) {
	const desiredEvent = desired.asyncEvents?.[0];
	const eventTypes = (webhook) => webhook.asyncEvents.map((event) => event.eventType);
	const existing = data.app.webhooks.find((webhook) =>
		desiredEvent === "ORDER_FULLY_PAID"
			? eventTypes(webhook).includes("ORDER_FULLY_PAID") ||
				eventTypes(webhook).includes("ORDER_CREATED") ||
				webhook.name.includes("Order Created")
			: eventTypes(webhook).includes(desiredEvent),
	);

	if (!existing) {
		throw new Error(`No existing webhook found for ${desiredEvent}; refusing to create a duplicate`);
	}

	const updated = await request(updateMutation, {
		id: existing.id,
		input: {
			name: desired.name,
			targetUrl: desired.targetUrl,
			isActive: desired.isActive,
			asyncEvents: desired.asyncEvents,
			query: desired.query,
		},
	});
	const errors = updated.webhookUpdate.errors;
	if (errors.length) throw new Error(JSON.stringify(errors, null, 2));
	console.log(
		`Updated ${updated.webhookUpdate.webhook.name} -> ${updated.webhookUpdate.webhook.targetUrl}`,
	);
}

console.log("Saleor webhooks are synchronized with the deployed manifest.");
