import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const target = new URL(process.env.VAULT_HTTP_TARGET ?? "http://127.0.0.1:18080");
const port = Number(process.env.VAULT_HTTPS_PORT ?? "18443");
const certificate = fs.readFileSync(
  process.env.VAULT_TLS_PEM ?? new URL("../../apps/web/dev-server.shared.pem", import.meta.url),
);

const server = https.createServer({ key: certificate, cert: certificate }, (request, response) => {
  const upstream = http.request(
    new URL(request.url ?? "/", target),
    { method: request.method, headers: { ...request.headers, host: target.host } },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", (error) => response.writeHead(502).end(error.message));
  request.pipe(upstream);
});

server.listen(port, "127.0.0.1", () => console.log(`Vault TLS proxy listening on ${port}`));
