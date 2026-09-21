import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function envInt(name, fallback, { min = 1, max = 1_000_000 } = {}) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function trustedProxyIp(req) {
  const expected = process.env.API_PROXY_SECRET;
  if (!expected) return null;

  const supplied = req.get?.("x-retinax-proxy-secret") || req.headers?.["x-retinax-proxy-secret"];
  if (!safeEqual(supplied, expected)) return null;

  const raw = String(
    req.get?.("x-retinax-client-ip") || req.headers?.["x-retinax-client-ip"] || ""
  ).trim();
  return isIP(raw) ? raw : null;
}

export function clientIpKey(req) {
  const address =
    trustedProxyIp(req) ||
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    "unknown";
  return `ip:${address}`;
}

export function emailKey(req) {
  const email = String(req.body?.email || "").trim().toLowerCase().slice(0, 320);
  return `email:${email || "missing"}`;
}

export function userKey(req) {
  return req.doctorId ? `user:${req.doctorId}` : clientIpKey(req);
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sendRateLimit(res, { name, message, retryAfterSeconds, code = "RATE_LIMITED" }) {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  return res.status(429).json({
    error: message,
    code,
    scope: name,
    retryAfterSeconds,
  });
}

/**
 * Small in-process fixed-window limiter.
 *
 * RetinaX currently runs as one Node process beside one SQLite database, so a
 * local store is enough for the present deployment and avoids another service.
 * If the API is later replicated across several processes/hosts, replace this
 * store with Redis (or another shared atomic store) while keeping the same
 * middleware call sites.
 */
export function createRateLimiter({
  name,
  windowMs,
  limit,
  key = clientIpKey,
  skip = () => false,
  message = "Too many requests. Try again later.",
  maxKeys = 10_000,
}) {
  const duration = positiveInt(windowMs, 60_000);
  const ceiling = positiveInt(limit, 60);
  const capacity = positiveInt(maxKeys, 10_000);
  const buckets = new Map();

  function prune(now) {
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(bucketKey);
    }
  }

  function keyFor(req) {
    return String(key(req) || "anonymous");
  }

  const middleware = (req, res, next) => {
    if (skip(req)) return next();

    const now = Date.now();
    const bucketKey = keyFor(req);
    let bucket = buckets.get(bucketKey);

    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && buckets.size >= capacity) {
        prune(now);
        if (buckets.size >= capacity) {
          // Bound memory even if an attacker deliberately sprays identifiers.
          // Per-identifier limiters are paired with an IP/user limiter, so
          // evicting the oldest identifier does not remove all protection.
          const oldest = buckets.keys().next().value;
          if (oldest !== undefined) buckets.delete(oldest);
        }
      }
      bucket = { count: 0, resetAt: now + duration };
      buckets.set(bucketKey, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, ceiling - bucket.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

    res.setHeader("RateLimit-Limit", String(ceiling));
    res.setHeader("RateLimit-Remaining", String(remaining));
    res.setHeader("RateLimit-Reset", String(retryAfterSeconds));

    if (bucket.count > ceiling) {
      return sendRateLimit(res, {
        name,
        message,
        retryAfterSeconds,
      });
    }
    next();
  };

  middleware.reset = (req) => buckets.delete(keyFor(req));
  middleware.clear = () => buckets.clear();
  return middleware;
}


/**
 * Estimate model input tokens from the parsed JSON body.
 *
 * This is deliberately an estimate, not Qwen's tokenizer. Counting UTF-8 bytes
 * at 3 bytes/token is conservative for English and multilingual text and, more
 * importantly, is cheap enough to run before any model call. JSON keys and
 * structure are included, so stuffing unused fields into a request is not free.
 */
export function estimateJsonTokens(value, bytesPerToken = 3) {
  let json;
  try {
    json = JSON.stringify(value ?? {});
  } catch {
    json = "";
  }
  const bytes = Buffer.byteLength(json, "utf8");
  return Math.max(1, Math.ceil(bytes / positiveInt(bytesPerToken, 3)));
}

/**
 * Weighted fixed-window budget.
 *
 * A normal request limiter charges every request as "1". This limiter charges
 * a caller by the estimated token cost of the request instead, so many small
 * prompts and a few large prompts consume the same finite GPU budget.
 *
 * Failed requests are refunded on finish. They still consume the ordinary
 * request-count limiter, which prevents someone from using invalid payloads as
 * a free parsing/validation DoS.
 */
export function createBudgetLimiter({
  name,
  windowMs,
  budget,
  cost,
  maxCost = null,
  key = userKey,
  message = "Chat token budget reached. Try again later.",
  maxCostMessage = "This chat input is too large.",
  headerPrefix = "TokenBudget",
  maxKeys = 10_000,
  clock = Date.now,
}) {
  const duration = positiveInt(windowMs, 10 * 60 * 1000);
  const ceiling = positiveInt(budget, 10_000);
  const capacity = positiveInt(maxKeys, 10_000);
  const perRequestMax = maxCost == null ? null : positiveInt(maxCost, ceiling);
  const buckets = new Map();

  function prune(now) {
    for (const [bucketKey, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(bucketKey);
    }
  }

  function keyFor(req) {
    return String(key(req) || "anonymous");
  }

  const middleware = (req, res, next) => {
    const now = Number(clock());
    const bucketKey = keyFor(req);
    const requestCost = Math.max(1, Math.ceil(Number(cost(req)) || 1));

    if (perRequestMax != null && requestCost > perRequestMax) {
      res.setHeader(`${headerPrefix}-Cost`, String(requestCost));
      res.setHeader(`${headerPrefix}-Max-Request`, String(perRequestMax));
      return res.status(413).json({
        error: maxCostMessage,
        code: "CHAT_INPUT_BUDGET_EXCEEDED",
        scope: name,
        estimatedTokens: requestCost,
        maxEstimatedTokens: perRequestMax,
      });
    }

    let bucket = buckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && buckets.size >= capacity) {
        prune(now);
        if (buckets.size >= capacity) {
          const oldest = buckets.keys().next().value;
          if (oldest !== undefined) buckets.delete(oldest);
        }
      }
      bucket = { used: 0, resetAt: now + duration };
      buckets.set(bucketKey, bucket);
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    const remainingBefore = Math.max(0, ceiling - bucket.used);

    res.setHeader(`${headerPrefix}-Limit`, String(ceiling));
    res.setHeader(`${headerPrefix}-Remaining`, String(remainingBefore));
    res.setHeader(`${headerPrefix}-Cost`, String(requestCost));
    res.setHeader(`${headerPrefix}-Reset`, String(retryAfterSeconds));

    if (bucket.used + requestCost > ceiling) {
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        error: message,
        code: "TOKEN_BUDGET_EXCEEDED",
        scope: name,
        retryAfterSeconds,
        estimatedTokens: requestCost,
        tokenBudget: ceiling,
        tokenRemaining: remainingBefore,
      });
    }

    bucket.used += requestCost;
    res.setHeader(`${headerPrefix}-Remaining`, String(Math.max(0, ceiling - bucket.used)));

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      // Validation errors, missing cases, model outages, and later 429s should
      // not spend model-token budget because no successful answer was served.
      if (res.statusCode >= 400 && buckets.get(bucketKey) === bucket) {
        bucket.used = Math.max(0, bucket.used - requestCost);
      }
    };
    res.once("finish", settle);
    res.once("close", settle);

    next();
  };

  middleware.reset = (req) => buckets.delete(keyFor(req));
  middleware.clear = () => buckets.clear();
  return middleware;
}

/**
 * Limits simultaneous long-lived work, not request frequency.
 *
 * This matters for streamed chatbot replies and GPU jobs: ten requests started
 * in the same second can all sit below a per-minute limiter while still pinning
 * the model. A concurrency cap closes that gap.
 */
export function createConcurrencyLimiter({
  name,
  limit,
  key = userKey,
  message = "Too many requests are already running. Try again in a moment.",
}) {
  const ceiling = positiveInt(limit, 1);
  const active = new Map();

  const middleware = (req, res, next) => {
    const bucketKey = String(key(req) || "anonymous");
    const current = active.get(bucketKey) || 0;

    if (current >= ceiling) {
      return sendRateLimit(res, {
        name,
        message,
        retryAfterSeconds: 1,
        code: "TOO_MANY_CONCURRENT_REQUESTS",
      });
    }

    active.set(bucketKey, current + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (active.get(bucketKey) || 1) - 1;
      if (left <= 0) active.delete(bucketKey);
      else active.set(bucketKey, left);
    };

    res.once("finish", release);
    res.once("close", release);
    next();
  };

  middleware.clear = () => active.clear();
  return middleware;
}
