import type { MiddlewareHandler } from "hono";

export const SESSION_COOKIE_NAME = "__Host-mcp-memory";
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export type AppAccessBindings = {
	APP_ACCESS_KEY: string;
	COOKIE_ENCRYPTION_KEY: string;
};

type Now = () => number;

const encoder = new TextEncoder();
const authPaths = new Set(["/auth/login", "/auth/session", "/auth/logout"]);

function base64Url(bytes: ArrayBuffer): string {
	let binary = "";
	for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(value: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return base64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function constantTimeEqual(left: string, right: string): boolean {
	let difference = left.length ^ right.length;
	const width = Math.max(left.length, right.length);
	for (let index = 0; index < width; index += 1) {
		difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
	}
	return difference === 0;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined;
	for (const segment of header.split(";")) {
		const [key, ...value] = segment.trim().split("=");
		if (key === name) return value.join("=");
	}
	return undefined;
}

function browserNavigation(request: Request): boolean {
	return request.headers.get("accept")?.includes("text/html") ?? false;
}

function loginLocation(request: Request): string {
	const url = new URL(request.url);
	return `/auth/login?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`;
}

export async function createSessionToken(secret: string, expiresAt: number): Promise<string> {
	const payload = String(expiresAt);
	return `${payload}.${await sign(payload, secret)}`;
}

export async function verifySessionToken(
	token: string | undefined,
	secret: string,
	now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
	if (!token || !secret) return false;
	const [payload, signature, ...remainder] = token.split(".");
	if (!payload || !signature || remainder.length > 0 || !/^\d+$/.test(payload)) return false;
	const expiresAt = Number(payload);
	if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
	return constantTimeEqual(signature, await sign(payload, secret));
}

export async function verifyAccessKey(candidate: string | undefined, secret: string): Promise<boolean> {
	if (!candidate || !secret) return false;
	const [provided, expected] = await Promise.all([sign(candidate, secret), sign(secret, secret)]);
	return constantTimeEqual(provided, expected);
}

export function createSessionCookie(token: string): string {
	return `${SESSION_COOKIE_NAME}=${token}; Max-Age=${SESSION_MAX_AGE_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

export function clearSessionCookie(): string {
	return `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

export async function requestIsAuthenticated(
	request: Request,
	env: AppAccessBindings,
	now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
	const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
	if (await verifyAccessKey(bearer, env.APP_ACCESS_KEY)) return true;
	return verifySessionToken(
		cookieValue(request.headers.get("cookie") ?? undefined, SESSION_COOKIE_NAME),
		env.COOKIE_ENCRYPTION_KEY,
		now,
	);
}

export function appAccessMiddleware(
	now: Now = () => Math.floor(Date.now() / 1000),
): MiddlewareHandler<{ Bindings: AppAccessBindings }> {
	return async (c, next) => {
		const path = new URL(c.req.url).pathname;
		if (authPaths.has(path)) return next();

		if (await requestIsAuthenticated(c.req.raw, c.env, now())) return next();
		if (browserNavigation(c.req.raw)) return c.redirect(loginLocation(c.req.raw));
		return c.text("Authentication required", 401);
	};
}
