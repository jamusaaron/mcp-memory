const CF_API = "https://api.cloudflare.com/client/v4";

type CloudflareEnv = {
	CLOUDFLARE_API_TOKEN?: string;
	CLOUDFLARE_ACCOUNT_ID?: string;
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class CloudflareApi {
	private activeAccountId?: string;
	private readonly env: CloudflareEnv;

	constructor(
		env: object,
		private readonly fetcher: Fetcher = fetch,
	) {
		this.env = env as CloudflareEnv;
	}

	isConfigured(): boolean {
		return Boolean(
			this.env.CLOUDFLARE_API_TOKEN &&
				(this.activeAccountId || this.env.CLOUDFLARE_ACCOUNT_ID),
		);
	}

	setAccountId(accountId: string): void {
		this.activeAccountId = accountId;
	}

	getAccountId(): string {
		const accountId = this.activeAccountId || this.env.CLOUDFLARE_ACCOUNT_ID;
		if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID not configured");
		return accountId;
	}

	async requestJson<T>(path: string, method = "GET", body?: unknown): Promise<T> {
		const response = await this.request(path, method, body);
		const raw = await response.text();
		let payload: any;
		try {
			payload = raw ? JSON.parse(raw) : {};
		} catch {
			throw new Error(`Cloudflare API ${response.status} returned invalid JSON`);
		}

		if (!response.ok || payload.success === false) {
			const detail =
				payload.errors
					?.map((error: any) => error.message || error.code)
					.filter(Boolean)
					.join(", ") ||
				payload.messages
					?.map((message: any) => message.message || message.code)
					.filter(Boolean)
					.join(", ") ||
				response.statusText ||
				"request failed";
			throw new Error(`Cloudflare API ${response.status}: ${detail}`);
		}
		return payload as T;
	}

	async requestText(path: string): Promise<string> {
		const response = await this.request(path);
		const text = await response.text();
		if (!response.ok) {
			throw new Error(
				`Cloudflare API ${response.status}: ${
					text || response.statusText || "request failed"
				}`,
			);
		}
		return text;
	}

	private async request(path: string, method = "GET", body?: unknown): Promise<Response> {
		const token = this.env.CLOUDFLARE_API_TOKEN;
		if (!token) throw new Error("CLOUDFLARE_API_TOKEN not configured");

		return await this.fetcher(`${CF_API}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}
}
