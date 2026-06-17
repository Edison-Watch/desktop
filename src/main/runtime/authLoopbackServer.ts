import { BrowserWindow } from "electron";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { AddressInfo } from "net";

let loopbackServer: ReturnType<typeof createServer> | null = null;
let loopbackUrl: string | null = null;

/** Returns the loopback OAuth/SSO callback URL once the server is listening. */
export function getAuthLoopbackUrl(): string | null {
  return loopbackUrl;
}

/**
 * Start a tiny loopback (127.0.0.1) HTTP server that receives OAuth/SSO
 * callbacks. Used in dev AND packaged builds: Chrome blocks gesture-less
 * redirects to custom protocols (edison-watch://), but a plain http://127.0.0.1
 * navigation has no such gate. Forwards `auth:callback` IPC to the main window.
 */
export function startAuthLoopbackServer(
  getMainWindow: () => BrowserWindow | null,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const handler = (req: IncomingMessage, res: ServerResponse): void => {
      const reqUrl = req.url ?? "/";
      if (!reqUrl.startsWith("/auth/callback")) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const port = (loopbackServer!.address() as AddressInfo).port;
      const fullUrl = `http://127.0.0.1:${port}${reqUrl}`;
      console.log("[AuthLoopback] Received OAuth callback:", fullUrl);

      const parsedUrl = new URL(fullUrl);
      const hasCode = parsedUrl.searchParams.has("code");
      const hasToken = parsedUrl.searchParams.has("access_token");

      const win = getMainWindow();
      if ((hasCode || hasToken) && win) {
        win.webContents.send("auth:callback", fullUrl);
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html>
<html>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1C1C1C;color:#C3FFFD">
  <div style="text-align:center">
    <h2>Authentication successful</h2>
    <p>You can close this tab and return to Edison Watch.</p>
  </div>
  <script>
    (async () => {
      // SSO/implicit tokens arrive in the URL fragment, which the browser never
      // sends to the server on the GET. Hand them over via this fetch and AWAIT
      // it before closing - otherwise window.close() aborts the request and the
      // callback (and sign-in) is lost. This was the intermittent "still waiting".
      if (window.location.hash && window.location.hash.length > 1) {
        try {
          await fetch('/auth/callback?from_hash=1&' + window.location.hash.substring(1));
        } catch (e) {}
      }
      window.close();
    })();
  </script>
</body>
</html>`);
    };

    loopbackServer = createServer(handler);
    loopbackServer.listen(0, "127.0.0.1", () => {
      const port = (loopbackServer!.address() as AddressInfo).port;
      loopbackUrl = `http://127.0.0.1:${port}/auth/callback`;
      console.log(`[AuthLoopback] Listening at ${loopbackUrl}`);
      resolve();
    });
    loopbackServer.on("error", (err) => {
      console.error("[AuthLoopback] Failed to start:", err);
      reject(err);
    });
  });
}
