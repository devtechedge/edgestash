import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Edgestash } from "./app.js";

/** Convert a Node request into a Web Request. */
export function toWebRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(new URL(req.url ?? "/", origin), {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined,
    // @ts-expect-error duplex is required by undici for streaming bodies
    duplex: hasBody ? "half" : undefined,
  });
}

export async function writeWebResponse(res: ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(r.status, headers);
  if (r.body) {
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
  }
  res.end();
}

export function serve(app: Edgestash, port = app.config.port, host = app.config.host): Promise<Server> {
  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host ?? `localhost:${port}`}`;
    app.fetch(toWebRequest(req, origin)).then((r) => writeWebResponse(res, r)).catch((e) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    });
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
