const localtunnel = require("localtunnel");
<<<<<<< HEAD
const fs = require("fs");
const urlFile = __dirname + "/.tunnel_url.txt";
=======
>>>>>>> 5bab2b20c4eba566b73440404ff4cd65a160ee6a

(async () => {
  try {
    const tunnel = await localtunnel({ port: 24000 });
<<<<<<< HEAD
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
=======
    console.log("");
    console.log("========================================");
    console.log("  Tunnel URL: " + tunnel.url);
    console.log("  Webhook:    " + tunnel.url + "/api/feishu/event");
    console.log("========================================");
    console.log("");
    console.log("配置飞书开发者后台:");
    console.log("  1. 打开 https://open.feishu.cn/app");
    console.log("  2. 选择应用 -> 事件与回调");
    console.log("  3. 添加事件: im.message.receive_v1");
    console.log("  4. 回调地址填写: " + tunnel.url + "/api/feishu/event");
    console.log("");

    tunnel.on("close", () => {
      console.log("Tunnel closed");
>>>>>>> 5bab2b20c4eba566b73440404ff4cd65a160ee6a
      process.exit(1);
    });
  } catch (e) {
    console.error("Tunnel failed:", e.message);
<<<<<<< HEAD
    try { fs.writeFileSync(urlFile, "ERROR: " + e.message, "utf8"); } catch(e2) {}
=======
>>>>>>> 5bab2b20c4eba566b73440404ff4cd65a160ee6a
    process.exit(1);
  }
})();
