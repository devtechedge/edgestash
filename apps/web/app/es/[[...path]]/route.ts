import { getEdgestash, originFrom } from "@/lib/edgestash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: Request): Promise<Response> {
  const app = await getEdgestash();
  const origin = originFrom(req.headers);
  if (!process.env.EDGESTASH_PUBLIC_URL) app.blob.opts.publicUrl = origin;
  const url = new URL(req.url);
  const target = new URL(url.pathname.replace(/^\/es/, "") + url.search, origin);
  const init: RequestInit & { duplex?: "half" } = { method: req.method, headers: req.headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    init.duplex = "half";
  }
  return app.fetch(new Request(target, init));
}

export { handle as GET, handle as POST, handle as PUT, handle as DELETE, handle as HEAD, handle as OPTIONS, handle as PATCH };
