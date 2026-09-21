import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createRateLimiter,
  createBudgetLimiter,
  createConcurrencyLimiter,
  estimateJsonTokens,
  clientIpKey,
} from "./rate-limit.js";

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.headers = {};
    this.statusCode = 200;
    this.body = null;
  }

  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = String(value);
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  json(body) {
    this.body = body;
    this.emit("finish");
    return this;
  }
}

function request(overrides = {}) {
  return {
    body: {},
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
    get(name) {
      return this.headers[String(name).toLowerCase()];
    },
    ...overrides,
  };
}

test("fixed-window limiter blocks only after the configured allowance", () => {
  const limiter = createRateLimiter({
    name: "test",
    windowMs: 60_000,
    limit: 2,
    key: () => "same",
  });

  for (let i = 0; i < 2; i += 1) {
    const res = new MockResponse();
    let passed = false;
    limiter(request(), res, () => { passed = true; });
    assert.equal(passed, true);
    assert.equal(res.statusCode, 200);
  }

  const blocked = new MockResponse();
  let passed = false;
  limiter(request(), blocked, () => { passed = true; });
  assert.equal(passed, false);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.body.code, "RATE_LIMITED");
  assert.ok(Number(blocked.headers["retry-after"]) >= 1);
});

test("reset clears one request key", () => {
  const req = request();
  const limiter = createRateLimiter({
    name: "reset-test",
    windowMs: 60_000,
    limit: 1,
    key: () => "account",
  });

  limiter(req, new MockResponse(), () => {});
  limiter.reset(req);

  const res = new MockResponse();
  let passed = false;
  limiter(req, res, () => { passed = true; });
  assert.equal(passed, true);
});

test("concurrency limiter releases a slot when the response finishes", () => {
  const limiter = createConcurrencyLimiter({
    name: "concurrency-test",
    limit: 1,
    key: () => "user",
  });

  const first = new MockResponse();
  let firstPassed = false;
  limiter(request(), first, () => { firstPassed = true; });
  assert.equal(firstPassed, true);

  const second = new MockResponse();
  let secondPassed = false;
  limiter(request(), second, () => { secondPassed = true; });
  assert.equal(secondPassed, false);
  assert.equal(second.statusCode, 429);
  assert.equal(second.body.code, "TOO_MANY_CONCURRENT_REQUESTS");

  first.emit("finish");

  const third = new MockResponse();
  let thirdPassed = false;
  limiter(request(), third, () => { thirdPassed = true; });
  assert.equal(thirdPassed, true);
});

test("proxy client IP is trusted only with the shared secret", () => {
  const previous = process.env.API_PROXY_SECRET;
  process.env.API_PROXY_SECRET = "server-secret";

  try {
    const good = request({
      headers: {
        "x-retinax-proxy-secret": "server-secret",
        "x-retinax-client-ip": "203.0.113.20",
      },
      socket: { remoteAddress: "10.0.0.5" },
    });
    assert.equal(clientIpKey(good), "ip:203.0.113.20");

    const spoofed = request({
      headers: {
        "x-retinax-proxy-secret": "wrong",
        "x-retinax-client-ip": "203.0.113.99",
      },
      socket: { remoteAddress: "10.0.0.6" },
    });
    assert.equal(clientIpKey(spoofed), "ip:10.0.0.6");
  } finally {
    if (previous === undefined) delete process.env.API_PROXY_SECRET;
    else process.env.API_PROXY_SECRET = previous;
  }
});


test("JSON token estimator charges more for more UTF-8 data", () => {
  const small = estimateJsonTokens({ message: "hello" });
  const large = estimateJsonTokens({ message: "hello ".repeat(200) });
  const unicode = estimateJsonTokens({ message: "xin chào bác sĩ" });

  assert.ok(small >= 1);
  assert.ok(large > small);
  assert.ok(unicode >= small);
});

test("weighted budget accumulates request cost and blocks overflow", () => {
  const limiter = createBudgetLimiter({
    name: "token-test",
    windowMs: 60_000,
    budget: 10,
    cost: (req) => req.body.cost,
    key: () => "user",
    headerPrefix: "TokenBudget-Test",
  });

  for (const cost of [4, 5]) {
    const res = new MockResponse();
    let passed = false;
    limiter(request({ body: { cost } }), res, () => { passed = true; });
    assert.equal(passed, true);
    res.emit("finish");
  }

  const blocked = new MockResponse();
  let passed = false;
  limiter(request({ body: { cost: 2 } }), blocked, () => { passed = true; });
  assert.equal(passed, false);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.body.code, "TOKEN_BUDGET_EXCEEDED");
  assert.equal(blocked.body.tokenBudget, 10);
  assert.equal(blocked.body.tokenRemaining, 1);
  assert.equal(blocked.headers["tokenbudget-test-cost"], "2");
});

test("failed requests refund weighted token budget", () => {
  const limiter = createBudgetLimiter({
    name: "refund-test",
    windowMs: 60_000,
    budget: 8,
    cost: () => 8,
    key: () => "user",
  });

  const failed = new MockResponse();
  limiter(request(), failed, () => {
    failed.status(400).json({ error: "bad input" });
  });
  assert.equal(failed.statusCode, 400);

  const afterRefund = new MockResponse();
  let passed = false;
  limiter(request(), afterRefund, () => { passed = true; });
  assert.equal(passed, true);
});

test("single request token ceiling returns 413 without spending the window", () => {
  const limiter = createBudgetLimiter({
    name: "max-request-test",
    windowMs: 60_000,
    budget: 10,
    maxCost: 5,
    cost: (req) => req.body.cost,
    key: () => "user",
  });

  const tooLarge = new MockResponse();
  let tooLargePassed = false;
  limiter(request({ body: { cost: 6 } }), tooLarge, () => { tooLargePassed = true; });
  assert.equal(tooLargePassed, false);
  assert.equal(tooLarge.statusCode, 413);
  assert.equal(tooLarge.body.code, "CHAT_INPUT_BUDGET_EXCEEDED");

  const allowed = new MockResponse();
  let allowedPassed = false;
  limiter(request({ body: { cost: 5 } }), allowed, () => { allowedPassed = true; });
  assert.equal(allowedPassed, true);
});

test("weighted budget resets when its time window expires", () => {
  let now = 1_000;
  const limiter = createBudgetLimiter({
    name: "window-test",
    windowMs: 1_000,
    budget: 5,
    cost: () => 5,
    key: () => "user",
    clock: () => now,
  });

  const first = new MockResponse();
  let firstPassed = false;
  limiter(request(), first, () => { firstPassed = true; });
  assert.equal(firstPassed, true);
  first.emit("finish");

  const blocked = new MockResponse();
  limiter(request(), blocked, () => {});
  assert.equal(blocked.statusCode, 429);

  now = 2_001;
  const afterWindow = new MockResponse();
  let afterWindowPassed = false;
  limiter(request(), afterWindow, () => { afterWindowPassed = true; });
  assert.equal(afterWindowPassed, true);
});
