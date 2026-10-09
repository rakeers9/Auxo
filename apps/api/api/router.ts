import type { IncomingMessage, ServerResponse } from "node:http";

import app from "../src/runtime.js";

const ready = app.ready();

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  await ready;
  const url = new URL(request.url ?? "/", "https://auxo.local");
  const path = url.searchParams.get("path") ?? "/";
  url.searchParams.delete("path");
  request.url = path + (url.searchParams.size ? `?${url.searchParams}` : "");
  app.routing(request, response);
}
