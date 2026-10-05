import type { IncomingMessage, ServerResponse } from "node:http";

import app from "../src/runtime.js";

const ready = app.ready();

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  await ready;
  const url = new URL(request.url ?? "/", "https://auxo.local");
  request.url = url.searchParams.get("path") ?? "/";
  app.routing(request, response);
}
