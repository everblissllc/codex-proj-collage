import test from "node:test";
import assert from "node:assert/strict";
import { runAmazonCreatorsDirectPilot } from "../pilot/amazon-creators-direct-runner.js";

const env = {
  AMAZON_CREATORS_CLIENT_ID: "test-client",
  AMAZON_CREATORS_CLIENT_SECRET: "test-secret",
  AMAZON_CREATORS_MARKETPLACE: "www.amazon.com",
  AMAZON_CREATORS_PARTNER_TAG: "test-partner-20"
};

const token = () => new Response(JSON.stringify({ access_token: "test-token", token_type: "bearer", expires_in: 3600 }), {
  status: 200,
  headers: { "content-type": "application/json" }
});

const item = {
  asin: "B08HNBHSQV",
  itemInfo: { title: { displayValue: "Test product" } },
  images: { primary: { large: { url: "https://images.example.test/product.jpg" } } },
  offersV2: { listings: [{ price: { money: { amount: 24.99, currency: "USD" } } }] }
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" }
});

function fetchSequence(...responses: Response[]): typeof fetch {
  return (async () => {
    const response = responses.shift();
    assert.ok(response, "unexpected extra request");
    return response;
  }) as typeof fetch;
}

test("HTTP 200 item response without errors classifies Creators auth success", async () => {
  const report = await runAmazonCreatorsDirectPilot(env, fetchSequence(token(), json({ itemsResult: { items: [item] } })));
  assert.equal(report.classification, "CREATORS_AUTH_SUCCESS");
  assert.equal(report.getItems?.productDataReturned, true);
  assert.equal(report.getItems?.amazonApiErrorCode, undefined);
});

test("403 AccessDeniedException remains access denied", async () => {
  const report = await runAmazonCreatorsDirectPilot(env, fetchSequence(token(), json({
    errors: [{ type: "AccessDeniedException", code: "AccessDeniedException" }]
  }, 403)));
  assert.equal(report.classification, "CREATORS_ACCESS_DENIED");
  assert.equal(report.getItems?.amazonApiErrorCode, "AccessDeniedException");
});

test("explicit Amazon error remains an API error", async () => {
  const report = await runAmazonCreatorsDirectPilot(env, fetchSequence(token(), json({
    errors: [{ type: "InvalidRequestException", code: "InvalidRequest" }]
  }, 400)));
  assert.equal(report.classification, "CREATORS_API_ERROR");
  assert.equal(report.getItems?.amazonApiErrorCode, "InvalidRequest");
});

test("malformed successful response remains invalid", async () => {
  const report = await runAmazonCreatorsDirectPilot(env, fetchSequence(token(), new Response("not-json", { status: 200 })));
  assert.equal(report.classification, "CREATORS_RESPONSE_INVALID");
});

test("OAuth failure remains token failure and does not call GetItems", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return json({ error: "invalid_client" }, 401);
  }) as typeof fetch;
  const report = await runAmazonCreatorsDirectPilot(env, fetcher);
  assert.equal(report.classification, "CREATORS_TOKEN_FAILED");
  assert.equal(calls, 1);
});
