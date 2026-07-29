import { createApp } from "./app";
import { runScheduledMaintenance } from "./maintenance";
import { MyMCP } from "./mcp";

const app = createApp(async (userId, request, env, ctx) =>
	MyMCP.mount(`/${userId}/sse`).fetch(request, env, ctx),
);

const worker = {
	fetch: app.fetch,
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(
			(async () => {
				try {
					await runScheduledMaintenance(env);
				} catch (error) {
					console.error("Scheduled maintenance failed:", error);
				}
			})(),
		);
	},
};

export default worker;

export { MyMCP };
