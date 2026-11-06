import net from "node:net";
const sock = process.argv[2];
const c = net.createConnection(sock);
c.on("data", d => { console.log("RAW", JSON.stringify(String(d)).slice(0, 400)); });
c.on("error", e => console.log("ERR", e.message));
c.on("connect", () => {
  c.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "rollcall", version: "0" } } }) + "\n");
});
setTimeout(() => process.exit(0), 3000);
