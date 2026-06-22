/**
 * In-memory dedup for webhook deliveries. Defense-in-depth — the underlying
 * Saleor and ShipStation operations are already naturally idempotent (cancel
 * checks status, shipnotify finds the existing fulfillment), but a recent-keys
 * cache short-circuits expensive retries when a slow handler causes a duplicate.
 *
 * Limitation: per-process cache only. Vercel may run handlers across multiple
 * lambda instances, so duplicates landing on different instances will both
 * process. Acceptable given the idempotent downstream ops; if duplicate
 * processing ever becomes a real problem, swap this for Vercel KV or Upstash.
 */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const recent = new Map<string, number>();

/**
 * Returns true if this is the first time we've seen the key (caller proceeds),
 * false if it was already claimed within the TTL window (caller should ack as
 * a duplicate without re-processing).
 */
export async function claimWebhookEvent(key: string): Promise<boolean> {
	const now = Date.now();
	const expires = recent.get(key);
	if (expires && expires > now) return false;
	if (recent.size > 10_000) pruneExpired(now);
	recent.set(key, now + TTL_MS);
	return true;
}

/**
 * Releases a previously claimed key so it can be processed again. Call this when the
 * work that followed a successful claim FAILED — otherwise the failed event would be
 * treated as a duplicate (and skipped) when ShipStation retries it.
 */
export async function releaseWebhookEvent(key: string): Promise<void> {
	recent.delete(key);
}

function pruneExpired(now: number) {
	for (const [k, expires] of recent) {
		if (expires <= now) recent.delete(k);
	}
}
