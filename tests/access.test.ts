import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { accessMiddleware, type AccessJwtVerifier } from "../src/access";

const config = {
	ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
	ACCESS_AUD: "expected-audience",
};

function protectedApp(verify: AccessJwtVerifier) {
	const app = new Hono<{ Bindings: typeof config }>();
	app.use("*", accessMiddleware(verify));
	app.get("/protected", (c) => c.text("allowed"));
	return app;
}

test("denies a protected route when Access configuration or assertion is missing", async () => {
	let verifierCalled = false;
	const app = protectedApp(async () => {
		verifierCalled = true;
	});
	const response = await app.fetch(new Request("https://example.test/protected"), {
		ACCESS_TEAM_DOMAIN: "",
		ACCESS_AUD: "",
	});

	assert.equal(response.status, 403);
	assert.equal(await response.text(), "Access denied");
	assert.equal(verifierCalled, false);
});

test("denies a rejected assertion before the protected handler", async () => {
	const app = protectedApp(async () => {
		throw new Error("invalid issuer or audience");
	});
	const response = await app.fetch(
		new Request("https://example.test/protected", {
			headers: { "Cf-Access-Jwt-Assertion": "invalid.jwt.value" },
		}),
		config,
	);

	assert.equal(response.status, 403);
	assert.equal(await response.text(), "Access denied");
});

test("allows a verifier-confirmed assertion with the configured Access values", async () => {
	const seen: Array<{ token: string; teamDomain: string; audience: string }> = [];
	const app = protectedApp(async (token, options) => {
		seen.push({ token, teamDomain: options.teamDomain, audience: options.audience });
	});
	const response = await app.fetch(
		new Request("https://example.test/protected", {
			headers: { "Cf-Access-Jwt-Assertion": "verified.jwt.value" },
		}),
		config,
	);

	assert.equal(response.status, 200);
	assert.equal(await response.text(), "allowed");
	assert.deepEqual(seen, [
		{
			token: "verified.jwt.value",
			teamDomain: config.ACCESS_TEAM_DOMAIN,
			audience: config.ACCESS_AUD,
		},
	]);
});
