import assert from "node:assert/strict";
import test from "node:test";

import { CloudflareApi } from "../src/utils/cloudflare-api";

test("CloudflareApi rejects requests without a token", async () => {
	const api = new CloudflareApi({ CLOUDFLARE_ACCOUNT_ID: "account" });
	await assert.rejects(api.requestJson("/accounts"), /CLOUDFLARE_API_TOKEN not configured/);
});

test("CloudflareApi reports upstream HTTP and API errors", async () => {
	const fetcher = async () =>
		new Response(
			JSON.stringify({ success: false, errors: [{ message: "permission denied" }] }),
			{ status: 403, headers: { "content-type": "application/json" } },
		);
	const api = new CloudflareApi({ CLOUDFLARE_API_TOKEN: "token" }, fetcher as typeof fetch);
	await assert.rejects(api.requestJson("/accounts"), /403.*permission denied/);
});

test("CloudflareApi parses successful JSON responses", async () => {
	const fetcher = async () =>
		new Response(JSON.stringify({ success: true, result: [{ id: "one" }] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	const api = new CloudflareApi({ CLOUDFLARE_API_TOKEN: "token" }, fetcher as typeof fetch);
	const result = await api.requestJson<{ success: boolean; result: Array<{ id: string }> }>(
		"/accounts",
	);
	assert.equal(result.result[0]?.id, "one");
});

test("CloudflareApi uses a session account override", () => {
	const api = new CloudflareApi({ CLOUDFLARE_ACCOUNT_ID: "default" });
	assert.equal(api.getAccountId(), "default");
	api.setAccountId("override");
	assert.equal(api.getAccountId(), "override");
});
