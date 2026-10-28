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
const MODEL = "gemini-3.5-flash-lite";

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
		retry: { maxRetries: 1 },
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
	const user = await getUser();
	if (!user) return new Response("Unauthorized", { status: 401 });
	const threadId = threadIdFor(user.id);

	// After a reload, useChat rejoins a reply that is still streaming.
	const runId = new URL(request.url).searchParams.get("runId");
	if (runId) {
		const runs = chatPersistence.stores.runs;
		const run = await runs?.get(runId);
		if (run?.threadId !== threadId) return new Response("Not found", { status: 404 });

		// The log lives in this process's memory, so a server restart loses it while
		// the database still says "running". A live run logs within ~50ms; an empty
		// log on a run older than 5s is dead. Mark it failed so the page stops rejoining.
		const log = memoryStream(request);
		if ((await log.snapshot()).length === 0 && Date.now() - run.startedAt > 5000) {
			await runs?.update(runId, {
				status: "failed",
				finishedAt: Date.now(),
				error: { message: "The server restarted before the reply finished." },
			});
			return new Response("Not found", { status: 404 });
		}
		return resumeServerSentEventsResponse({ adapter: log });
	}

	// On mount, useChat loads the chat.
	return reconstructChat(chatPersistence, request, { authorize: (id) => id === threadId });
}
