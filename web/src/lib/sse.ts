// Reads Server-Sent Events from a POST response (EventSource can't POST).
import type { ChatEvent } from "../types";
import { BASE, authHeaders, errorFrom, onUnauthorized } from "./api";

export async function streamPost(
  path: string,
  body: unknown,
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json", Accept: "text/event-stream" }),
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 401) { onUnauthorized(); throw new Error("Signed out"); }
  if (!res.ok || !res.body) throw await errorFrom(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let cut: number;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const ev = parseBlock(block);
      if (ev) onEvent(ev);
    }
  }
  const last = parseBlock(buf);
  if (last) onEvent(last);
}

// Each event is `data: <json>` where the json carries its own `type`.
function parseBlock(block: string): ChatEvent | null {
  let evName = "";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    const val = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "event") evName = val;
    else if (field === "data") data.push(val);
  }
  if (!data.length) return null;
  try {
    const obj = JSON.parse(data.join("\n"));
    if (obj && typeof obj === "object" && !obj.type && evName) obj.type = evName;
    return obj as ChatEvent;
  } catch {
    return null;
  }
}
