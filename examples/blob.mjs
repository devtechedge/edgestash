// Stock @vercel/blob code. Only VERCEL_BLOB_API_URL and BLOB_READ_WRITE_TOKEN differ from production.
import { copy, del, head, list, put } from "@vercel/blob";

const { url, pathname } = await put("examples/hello.txt", "Hello from edgestash", { access: "public", addRandomSuffix: true });
console.log("put     ", url);
console.log("head    ", (await head(url)).size, "bytes");
console.log("download", await (await fetch(url)).text());
const c = await copy(url, "examples/copy.txt", { access: "public", allowOverwrite: true });
console.log("list    ", (await list({ prefix: "examples/" })).blobs.map((b) => b.pathname));
await del([url, c.url]);
console.log("deleted ", pathname, c.pathname);
