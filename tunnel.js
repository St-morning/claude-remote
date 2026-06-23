const localtunnel = require("localtunnel");

(async () => {
  try {
    const tunnel = await localtunnel({ port: 24000 });
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
      process.exit(1);
    });
  } catch (e) {
    console.error("Tunnel failed:", e.message);
    process.exit(1);
  }
})();
