import { describe, expect, it } from "vitest";

import { claimWebhookEvent } from "./idempotency";

describe("claimWebhookEvent", () => {
	it("returns true on first claim, false on duplicate", async () => {
		const key = `test-${Math.random()}`;
		expect(await claimWebhookEvent(key)).toBe(true);
		expect(await claimWebhookEvent(key)).toBe(false);
	});

	it("treats unrelated keys independently", async () => {
		const a = `test-${Math.random()}-a`;
		const b = `test-${Math.random()}-b`;
		expect(await claimWebhookEvent(a)).toBe(true);
		expect(await claimWebhookEvent(b)).toBe(true);
	});
});
