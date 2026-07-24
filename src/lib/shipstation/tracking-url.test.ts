import { describe, expect, it } from "vitest";

import { carrierTrackingUrl } from "./tracking-url";

describe("carrierTrackingUrl", () => {
	it("maps stamps_com (ShipStation's USPS) to a USPS tracking URL", () => {
		expect(carrierTrackingUrl("stamps_com", "9400111899560001234567")).toBe(
			"https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899560001234567",
		);
	});

	it("maps ups regardless of case", () => {
		expect(carrierTrackingUrl("UPS", "1Z999AA10123456784")).toBe(
			"https://www.ups.com/track?tracknum=1Z999AA10123456784",
		);
	});

	it("maps fedex and dhl variants", () => {
		expect(carrierTrackingUrl("fedex_walleted", "123456789012")).toContain("fedex.com");
		expect(carrierTrackingUrl("dhl_express", "1234567890")).toContain("dhl.com");
	});

	it("returns null for unknown or missing carriers so the bare number is kept", () => {
		expect(carrierTrackingUrl("pitney_bowes", "123")).toBeNull();
		expect(carrierTrackingUrl(null, "123")).toBeNull();
	});

	it("url-encodes the tracking number", () => {
		expect(carrierTrackingUrl("usps", "AB 12/34")).toBe(
			"https://tools.usps.com/go/TrackConfirmAction?tLabels=AB%2012%2F34",
		);
	});
});
