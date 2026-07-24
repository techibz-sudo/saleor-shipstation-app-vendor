/**
 * Saleor's Fulfillment model stores ONLY a tracking_number string — there is no
 * carrier field, so the customer email can't name the provider. The email
 * templates render the value as a clickable link when it is a URL, so we write a
 * carrier-specific tracking URL instead of the bare number whenever we recognize
 * ShipStation's carrier_code. Unknown carriers fall back to the bare number.
 */
const CARRIER_URL_TEMPLATES: Array<{ match: RegExp; url: (n: string) => string }> = [
	// stamps_com is ShipStation's built-in USPS integration.
	{
		match: /usps|stamps_com/,
		url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
	},
	{ match: /ups/, url: (n) => `https://www.ups.com/track?tracknum=${n}` },
	{ match: /fedex/, url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}` },
	{
		match: /dhl/,
		url: (n) => `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${n}`,
	},
];

export function carrierTrackingUrl(
	carrierCode: string | null | undefined,
	trackingNumber: string,
): string | null {
	if (!carrierCode) return null;
	const code = carrierCode.toLowerCase();
	const entry = CARRIER_URL_TEMPLATES.find((c) => c.match.test(code));
	return entry ? entry.url(encodeURIComponent(trackingNumber)) : null;
}
