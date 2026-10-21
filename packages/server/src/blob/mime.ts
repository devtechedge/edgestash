const TYPES: Record<string, string> = {
  txt: "text/plain", html: "text/html", htm: "text/html", css: "text/css", csv: "text/csv", md: "text/markdown",
  js: "text/javascript", mjs: "text/javascript", json: "application/json", xml: "application/xml",
  pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", wasm: "application/wasm",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  svg: "image/svg+xml", ico: "image/x-icon", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", woff: "font/woff", woff2: "font/woff2",
};

export function contentTypeFor(pathname: string): string {
  const ext = pathname.split("/").pop()?.split(".").slice(1).pop()?.toLowerCase();
  return (ext && TYPES[ext]) || "application/octet-stream";
}
