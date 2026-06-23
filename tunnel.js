const localtunnel = require("localtunnel");
const fs = require("fs");
const urlFile = __dirname + "/.tunnel_url.txt";

(async () => {
  try {
    const tunnel = await localtunnel({ port: 24000 });
    const url = tunnel.url;
    
    // Write to file for other processes to read
    fs.writeFileSync(urlFile, url, "utf8");
    
    console.log("");
    console.log("========================================");
    console.log("  Tunnel URL: " + url);
    console.log("  Webhook:    " + url + "/api/feishu/event");
    console.log("========================================");
    console.log("");

    tunnel.on("close", () => {
      console.log("Tunnel closed");
      try { fs.unlinkSync(urlFile); } catch(e) {}
      process.exit(1);
    });
  } catch (e) {
    console.error("Tunnel failed:", e.message);
    try { fs.writeFileSync(urlFile, "ERROR: " + e.message, "utf8"); } catch(e2) {}
    process.exit(1);
  }
})();
