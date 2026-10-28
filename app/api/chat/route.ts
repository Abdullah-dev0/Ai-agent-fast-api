import {
	chat,
	chatParamsFromRequest,
	memoryStream,
	resumeServerSentEventsResponse,
	toServerSentEventsResponse,
} from "@tanstack/ai";
import { geminiText } from "@tanstack/ai-gemini";
import { reconstructChat, withPersistence } from "@tanstack/ai-persistence";
import { getUser } from "@/lib/dal";
import { chatPersistence, threadIdFor } from "@/lib/chat-persistence";

// Google's Gemini API directly. geminiText reads GEMINI_API_KEY (or GOOGLE_API_KEY).
const MODEL = "gemini-3.5-flash";

// Send a message. withPersistence loads the stored thread, merges, and saves it.
export async function POST(request: Request) {
	const user = await getUser();
	if (!user) return new Response("Unauthorized", { status: 401 });

	let params: Awaited<ReturnType<typeof chatParamsFromRequest>>;
	try {
		params = await chatParamsFromRequest(request);
	} catch (err) {
		// It throws a 400 Response on a bad body; Next does not handle thrown Responses.
		if (err instanceof Response) return err;
		throw err;
	}
	// Route handlers are public endpoints: never trust the client's thread id.
	if (params.threadId !== threadIdFor(user.id)) return new Response("Not found", { status: 404 });

	const stream = chat({
		adapter: geminiText(MODEL),
		systemPrompts: ["You are a helpful assistant"],
		messages: params.messages,
		threadId: params.threadId,
		runId: params.runId,
		middleware: [withPersistence(chatPersistence)],
	});
	// The durability log records every chunk before it is sent. With it, a closed
	// tab no longer stops the run: the reply keeps filling the log, and a reloaded
	// page replays it through GET ?runId=. memoryStream keeps the log in this
	// process's memory: fine for one server, not for several or for serverless.
	return toServerSentEventsResponse(stream, {
		durability: { adapter: memoryStream({ runId: params.runId }) },
	});
}

export async function GET(request: Request) {
	// Rejoin: after a reload, useChat calls GET ?runId=...&offset=... to replay a
	// reply that is still streaming. Check the run is in this user's thread first.
	const runId = new URL(request.url).searchParams.get("runId");
	if (runId) {
		const user = await getUser();
		if (!user) return new Response("Unauthorized", { status: 401 });
		const run = await chatPersistence.stores.runs?.get(runId);
		if (run?.threadId !== threadIdFor(user.id)) return new Response("Not found", { status: 404 });
		return resumeServerSentEventsResponse({ adapter: memoryStream(request) });
	}

	// Hydrate on mount: useChat({ persistence: true }) calls GET ?threadId=...
	return reconstructChat(chatPersistence, request, {
		authorize: async (threadId) => {
			const user = await getUser();
			if (!user) return new Response("Unauthorized", { status: 401 });
			return threadId === threadIdFor(user.id);
		},
	});
}
