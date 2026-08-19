const http = require("http");
const https = require("https");

const listenHost = process.env.RELAY_HOST || "0.0.0.0";
const listenPort = Number(process.env.RELAY_PORT || 18080);
const target = new URL(
  process.env.CLOUDBASE_TARGET ||
    "http://cloud1-d6gv6t2jf3f2c541c-1441069580.ap-shanghai.app.tcloudbase.com/api"
);

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/api") {
    sendJson(res, 404, { ok: false, error: "not found" });
    return;
  }

  const chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const client = target.protocol === "https:" ? https : http;
    const upstream = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method: "POST",
        headers: {
          "Content-Type": req.headers["content-type"] || "application/json",
          "Content-Length": body.length,
        },
      },
      upstreamRes => {
        res.writeHead(upstreamRes.statusCode || 502, {
          "Content-Type": upstreamRes.headers["content-type"] || "application/json",
        });
        upstreamRes.pipe(res);
      }
    );

    upstream.on("error", error => {
      sendJson(res, 502, { ok: false, error: error.message });
    });

    upstream.end(body);
  });
});

server.listen(listenPort, listenHost, () => {
  console.log(`CloudBase relay listening on http://${listenHost}:${listenPort}/api`);
  console.log(`Forwarding to ${target.href}`);
});
