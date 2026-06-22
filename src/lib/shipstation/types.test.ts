import { describe, expect, it } from "vitest";

import { shipstationLabelsListSchema } from "./types";

describe("shipstationLabelsListSchema", () => {
	// Trimmed from a real `label_created_v2` resource_url response
	// (GET /v2/labels?batch_id=…). Extra fields ShipStation includes are ignored.
	const realLabelsResponse = {
		labels: [
			{
				label_id: "se-155958768",
				status: "completed",
				shipment_id: "se-322496573",
				external_shipment_id: "2454c17d-e5dd-4b08-a925-dd761ae3e161",
				external_order_id: "T3JkZXI6MQ==",
				ship_date: "2026-06-02T07:00:00Z",
				tracking_number: "9400150206217717764146",
				is_return_label: false,
				batch_id: "se-54449962",
				carrier_id: "se-5466662",
				service_code: "usps_ground_advantage",
				carrier_code: "usps",
				voided: false,
			},
		],
		total: 1,
		page: 1,
		pages: 1,
		links: {},
	};

	it("parses a labels collection and exposes the fields we sync to Saleor", () => {
		const parsed = shipstationLabelsListSchema.safeParse(realLabelsResponse);
		expect(parsed.success).toBe(true);
		const label = parsed.success ? parsed.data.labels?.[0] : undefined;
		expect(label?.external_shipment_id).toBe("2454c17d-e5dd-4b08-a925-dd761ae3e161");
		expect(label?.tracking_number).toBe("9400150206217717764146");
		expect(label?.carrier_code).toBe("usps");
		expect(label?.voided).toBe(false);
	});

	it("parses a batch with multiple labels (so none are silently dropped)", () => {
		const parsed = shipstationLabelsListSchema.safeParse({
			...realLabelsResponse,
			labels: [
				realLabelsResponse.labels[0],
				{
					...realLabelsResponse.labels[0],
					label_id: "se-155958769",
					shipment_id: "se-322496574",
					external_shipment_id: "9339cd37-e730-4467-835e-ea02f27e3001",
					tracking_number: "9400150206217717764147",
				},
			],
		});
		expect(parsed.success && parsed.data.labels?.length).toBe(2);
	});

	it("does not extract labels from a shipments-shaped response (caller falls through)", () => {
		const parsed = shipstationLabelsListSchema.safeParse({ shipments: [{ shipment_id: "se-1" }] });
		// `labels` is optional, so it parses, but yields nothing for the caller to use.
		expect(parsed.success).toBe(true);
		expect(parsed.success && parsed.data.labels).toBeUndefined();
	});
});
