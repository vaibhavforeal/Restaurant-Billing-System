import { createServer } from "node:http";

// A stand-in for https://openrouter.ai/api/v1 on 127.0.0.1:4161, so the AI assistant can be driven end to end with no
// key and no cost. Scripted: an Ask question first gets a sales_by_day lookup, then an answer; any message mentioning
// "limit" gets a 429. Every request body is kept for GET /__qa/requests; POST /__qa/offline drops all later connections.
const requests: unknown[] = [];
let chats = 0;
let offline = false;
const send = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*" });
  res.end(JSON.stringify(body));
};
const reply = (content: string | null, extra: object = {}) => ({ model: "google/gemma-4-31b-it:free", choices: [{ message: { content, ...extra } }], usage: { prompt_tokens: 120, completion_tokens: 30 } });

createServer((req, res) => {
  if (offline && !req.url?.startsWith("/__qa")) { req.socket.destroy(); return; }
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (req.url === "/__qa/requests") return send(res, 200, { requests });
    if (req.url === "/__qa/offline") { offline = true; return send(res, 200, { offline }); }
    if (req.url === "/api/v1/models") return send(res, 200, { data: [
      { id: "google/gemma-4-31b-it:free", name: "Gemma 4 31B", context_length: 262144, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools", "max_tokens"] },
      { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra", context_length: 1000000, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
      { id: "openai/gpt-paid", name: "Paid model", context_length: 128000, pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: ["tools"] },
    ] });
    if (req.url === "/api/v1/key") return send(res, 200, { data: { free_model_daily_requests: { used: chats, limit: 50, remaining: 50 - chats } } });
    if (req.url !== "/api/v1/chat/completions") return send(res, 404, { error: { message: "not found" } });
    const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string | null }>; tools?: unknown[] };
    requests.push(body);
    chats++;
    const system = body.messages[0]?.content ?? "";
    const last = body.messages.at(-1)!;
    if (body.messages.some((m) => m.role === "user" && /limit/i.test(m.content ?? ""))) return send(res, 429, { error: { message: "Rate limit exceeded: free-models-per-day", code: 429 } });
    if (/connection test/.test(system)) return send(res, 200, reply("OK"));
    if (/end-of-day summary/.test(system)) return send(res, 200, reply("• Sales were steady at the counter.\n• Paneer tikka sold most."));
    if (/menu descriptions/.test(system)) return send(res, 200, reply("Smoky paneer cubes, marinated in spiced yoghurt and charred in the tandoor."));
    // A question mentioning "slow" waits 20 s (longer than the app's normal 15 s request timeout) before answering.
    if (body.messages.some((m) => m.role === "user" && /slow/i.test(m.content ?? ""))) { setTimeout(() => send(res, 200, reply("A slow but complete answer.")), 20_000); return; }
    if (body.tools && last.role === "user") return send(res, 200, reply(null, { tool_calls: [{ id: "call-1", type: "function", function: { name: "sales_by_day", arguments: "{}" } }] }));
    return send(res, 200, reply("Sales held steady this week; Paneer tikka was the best seller (fake answer)."));
  });
}).listen(4161, "127.0.0.1", () => console.log("Fake OpenRouter: http://127.0.0.1:4161/api/v1"));
