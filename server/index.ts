import { createServer } from "node:http";
import { handle } from "./app.ts";
import { closeDatabase } from "./database.ts";
import { startRoundWorker } from "./worker.ts";
import { closeEventStreams } from "./events.ts";
const port = Number(process.env.PORT ?? 4174);
const host = process.env.HOST ?? "127.0.0.1";
const worker = startRoundWorker();
const server = createServer((request, response) => {
  void handle(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Request could not be completed." }));
  });
});
server.listen(port, host, () => process.stdout.write(`Toruni listening on http://${host}:${port} (Strike V2 testnet only)\n`));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  closeEventStreams();
  server.close(() => { void worker.stop().finally(() => closeDatabase()).finally(() => process.exit(0)); });
});
