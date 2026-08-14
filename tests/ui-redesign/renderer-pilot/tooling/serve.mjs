import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const outputRoot = resolve(import.meta.dirname, "../../../../dist/ui-redesign-renderer-pilot");
const port = Number.parseInt(process.env.RENDERER_PILOT_PORT ?? "6010", 10);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};
const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    const relativePath = url.pathname.endsWith("/")
      ? `${url.pathname.slice(1)}index.html`
      : url.pathname.slice(1);
    const filePath = resolve(outputRoot, relativePath);

    if (!filePath.startsWith(`${outputRoot}${sep}`)) {
      sendError(response, 403, "Forbidden");
      return;
    }

    const file = await stat(filePath);
    if (!file.isFile()) {
      sendError(response, 404, "Not found");
      return;
    }

    response.writeHead(200, {
      "Cache-Control": extname(filePath) === ".html" ? "no-store" : "public, max-age=3600",
      "Content-Security-Policy": csp,
      "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    sendError(response, 404, "Not found");
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Renderer pilot server listening on http://127.0.0.1:${port}\n`);
});

function sendError(response, status, message) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(message);
}
