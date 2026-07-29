import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
	appAccessMiddleware,
	createSessionToken,
	verifySessionToken,
} from "../src/app-access";

const now = 1_700_000_000;
const config = {
	APP_ACCESS_KEY: "private-access-key",
	COOKIE_ENCRYPTION_KEY: "cookie-signing-key",
};

function protectedApp() {
	const app = new Hono<{ Bindings: typeof config }>();
	app.use("*", appAccessMiddleware(() => now));
	app.get("/protected", (c) => c.text("allowed"));
	return app;
}

test("accepts a session signed with the configured key", async () => {
	const token = await createSessionToken(config.COOKIE_ENCRYPTION_KEY, now + 3600);

	assert.equal(await verifySessionToken(token, config.COOKIE_ENCRYPTION_KEY, now), true);
});

test("rejects missing, expired, and tampered session tokens", async () => {
	const validToken = await createSessionToken(config.COOKIE_ENCRYPTION_KEY, now + 3600);
	const expiredToken = await createSessionToken(config.COOKIE_ENCRYPTION_KEY, now - 1);

	assert.equal(await verifySessionToken("", config.COOKIE_ENCRYPTION_KEY, now), false);
	assert.equal(await verifySessionToken(expiredToken, config.COOKIE_ENCRYPTION_KEY, now), false);
	assert.equal(await verifySessionToken(`${validToken}x`, config.COOKIE_ENCRYPTION_KEY, now), false);
});

test("redirects unauthenticated browser navigation to the Worker login route", async () => {
	const response = await protectedApp().fetch(
		new Request("https://example.test/console?view=recent", {
			headers: { Accept: "text/html" },
		}),
		config,
	);

	assert.equal(response.status, 302);
	assert.equal(response.headers.get("location"), "/auth/login?next=%2Fconsole%3Fview%3Drecent");
});

test("denies unauthenticated API requests before protected handlers", async () => {
	const response = await protectedApp().fetch(
		new Request("https://example.test/protected", { headers: { Accept: "application/json" } }),
		config,
	);

	assert.equal(response.status, 401);
	assert.equal(await response.text(), "Authentication required");
});

test("allows the private Bearer key and a signed session cookie", async () => {
	const app = protectedApp();
	const bearerResponse = await app.fetch(
		new Request("https://example.test/protected", {
			headers: { Authorization: `Bearer ${config.APP_ACCESS_KEY}` },
		}),
		config,
	);
	const token = await createSessionToken(config.COOKIE_ENCRYPTION_KEY, now + 3600);
	const cookieResponse = await app.fetch(
		new Request("https://example.test/protected", {
			headers: { Cookie: `__Host-mcp-memory=${token}` },
		}),
		config,
	);

	assert.equal(bearerResponse.status, 200);
	assert.equal(await bearerResponse.text(), "allowed");
	assert.equal(cookieResponse.status, 200);
	assert.equal(await cookieResponse.text(), "allowed");
});
