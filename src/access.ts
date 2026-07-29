import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";

export type AccessJwtOptions = { teamDomain: string; audience: string };
export type AccessJwtVerifier = (token: string, options: AccessJwtOptions) => Promise<void>;

export async function verifyAccessJwt(token: string, options: AccessJwtOptions): Promise<void> {
	const certificates = createRemoteJWKSet(
		new URL(`${options.teamDomain}/cdn-cgi/access/certs`),
	);
	await jwtVerify(token, certificates, {
		issuer: options.teamDomain,
		audience: options.audience,
	});
}

export function accessMiddleware(
	verify: AccessJwtVerifier = verifyAccessJwt,
): MiddlewareHandler<{
	Bindings: { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string };
}> {
	return async (c, next) => {
		const teamDomain = c.env.ACCESS_TEAM_DOMAIN?.replace(/\/+$/, "") ?? "";
		const audience = c.env.ACCESS_AUD ?? "";
		const token = c.req.header("Cf-Access-Jwt-Assertion");

		if (!teamDomain || !audience || !token) {
			return c.text("Access denied", 403);
		}

		try {
			await verify(token, { teamDomain, audience });
		} catch {
			return c.text("Access denied", 403);
		}

		await next();
	};
}
