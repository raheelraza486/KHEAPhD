function windowLimiter(windowMs: number, maximum: number) {
  const requests = new Map<string, number[]>();
  return (key: string, now = Date.now()): number => {
    const recent = (requests.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
    if (recent.length >= maximum) {
      requests.set(key, recent);
      return Math.ceil((recent[0] + windowMs - now) / 1_000);
    }
    recent.push(now);
    requests.set(key, recent);
    return 0;
  };
}

/** Protect the shared model quota without grouping users behind one IP address. */
export function createDiscoveryRateLimiter(windowMs = 60_000, maximum = 10) {
  return windowLimiter(windowMs, maximum);
}

export const checkDiscoveryRateLimit = createDiscoveryRateLimiter();

