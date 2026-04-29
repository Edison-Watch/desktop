import { BrowserWindow } from "electron";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type { AddressInfo } from "net";

let devAuthServer: ReturnType<typeof createServer> | null = null;
let devAuthCallbackUrl: string | null = null;

/** Returns the localhost OAuth callback URL once the server is listening. */
export function getDevAuthCallbackUrl(): string | null {
  return devAuthCallbackUrl;
}

/**
 * Start a tiny localhost HTTP server that receives OAuth callbacks in dev mode.
 * Forwards `auth:callback` IPC messages to the supplied main window.
 */
export function startDevAuthServer(
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

      const port = (devAuthServer!.address() as AddressInfo).port;
      const fullUrl = `http://127.0.0.1:${port}${reqUrl}`;
      console.log("[DevAuthServer] Received OAuth callback:", fullUrl);

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
    if (window.location.hash && window.location.hash.length > 1) {
      fetch('/auth/callback?from_hash=1&' + window.location.hash.substring(1))
    }
    window.close();
  </script>
</body>
</html>`);
    };

    devAuthServer = createServer(handler);
    devAuthServer.listen(0, "127.0.0.1", () => {
      const port = (devAuthServer!.address() as AddressInfo).port;
      devAuthCallbackUrl = `http://127.0.0.1:${port}/auth/callback`;
      console.log(`[DevAuthServer] Listening at ${devAuthCallbackUrl}`);
      resolve();
    });
    devAuthServer.on("error", (err) => {
      console.error("[DevAuthServer] Failed to start:", err);
      reject(err);
    });
  });
}
