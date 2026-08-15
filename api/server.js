/**
 * api/server.js — نقطه‌ی ورود Vercel Function
 *
 * طبق الگوی رسمی Vercel برای «Node.js server frameworks» (رجوع به
 * https://vercel.com/docs/functions/websockets#node.js-server-frameworks):
 * یک http.Server معمولی export می‌کنیم؛ Vercel خودش این export رو به‌عنوان
 * Function اجرا می‌کنه و درخواست‌های WebSocket رو هم بهش می‌ده.
 *
 * دو مسیر کاملاً جدا داریم:
 *   ۱) درخواست‌های عادی HTTP → به router پورت‌شده از Cloudflare (src/index.js) سپرده می‌شن.
 *   ۲) درخواست‌های Upgrade به /ws → مستقیم به wsrelay.js (رله‌ی VLESS) سپرده می‌شن،
 *      هرگز از مسیر router عادی رد نمی‌شن.
 */
import http from "node:http";
import { WebSocketServer } from "ws";
import app from "../src/index.js";
import { runSession, clientIpFromNodeRequest } from "../src/wsrelay.js";
import { nodeRequestToWebRequest, sendWebResponse } from "../src/webadapter.js";

const WS_PATH = "/ws";

const server = http.createServer(async (req, res) => {
  try {
    const webRequest = await nodeRequestToWebRequest(req);
    const ctx = { waitUntil: (p) => { Promise.resolve(p).catch(() => {}); } };
    const response = await app.fetch(webRequest, process.env, ctx);
    await sendWebResponse(res, response);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ detail: err && err.message ? err.message : "internal error" }));
  }
});

// perMessageDeflate خاموشه: ترافیک VLESS از قبل رمزنگاری‌شده (تصادفی/بی‌الگو)
// است، پس فشرده‌سازی نه‌تنها چیزی رو کوچیک‌تر نمی‌کنه، بلکه هم CPU هر پیام
// رو مصرف می‌کنه (که روی Vercel یعنی هزینه‌ی بیشتر) و هم تأخیر اضافه می‌کنه.
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on("upgrade", (req, socket, head) => {
  const path = (req.url || "").split("?")[0];
  if (path !== WS_PATH) {
    socket.destroy();
    return;
  }
  socket.setNoDelay(true); // خاموش کردن الگوریتم Nagle: بسته‌های کوچیک رو فوری بفرست، منتظر بافر شدن نمون
  wss.handleUpgrade(req, socket, head, (ws) => {
    const clientIp = clientIpFromNodeRequest(req);
    runSession(ws, clientIp).catch(() => {
      try {
        ws.close(1011, "internal error");
      } catch {
        /* ignore */
      }
    });
  });
});

export default server;
