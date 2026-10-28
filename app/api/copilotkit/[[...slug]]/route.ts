// CopilotKit's runtime: the browser talks to this route, and it forwards each
// run to the Python agent server over AG-UI. Set up as in CopilotKit's FastAPI
// docs; the only addition is the login check.
import { HttpAgent } from "@ag-ui/client";
import { CopilotRuntime, createCopilotRuntimeHandler, InMemoryAgentRunner } from "@copilotkit/runtime/v2";
import { getUser } from "@/lib/dal";

const runtime = new CopilotRuntime({
	agents: {
		// The name must match agentId on the page and the agent name in main.py.
		assistant: new HttpAgent({ url: process.env.AGENT_URL ?? "http://127.0.0.1:8123/agent" }),
	},
	runner: new InMemoryAgentRunner(),
});

const handler = createCopilotRuntimeHandler({ runtime, basePath: "/api/copilotkit" });

// Route handlers are public endpoints: without this, anyone could spend your
// Gemini quota through the agent.
async function authorized(request: Request) {
	if (!(await getUser())) return new Response("Unauthorized", { status: 401 });
	return handler(request);
}

export const GET = authorized;
export const POST = authorized;
