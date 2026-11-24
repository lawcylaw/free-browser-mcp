import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { exec, execSync } from "child_process";
import fs from "fs";

process.env.DISPLAY = ":99";
const PORT = Number(process.env.DESKTOP_MCP_PORT || 8002);
const API_KEY = process.env.MCP_API_KEY || "";

function createDesktopMcpServer() {
  const server = new McpServer({
    name: "headful-linux-desktop-mcp",
    version: "1.0.0",
  });

  server.tool(
    "desktop_screenshot",
    "Capture the current Headful Linux virtual desktop screen (1280x800 PNG).",
    {},
    async () => {
      const imgPath = "/tmp/desktop_screen.png";
      execSync(`DISPLAY=:99 scrot -o ${imgPath}`);
      const base64 = fs.readFileSync(imgPath).toString("base64");
      return {
        content: [{ type: "image", data: base64, mimeType: "image/png" }],
      };
    }
  );

  server.tool(
    "mouse_action",
    "Control OS-level mouse movement, clicks, drag, and scroll on the Linux desktop.",
    {
      action: z.enum([
        "move",
        "left_click",
        "right_click",
        "double_click",
        "scroll_up",
        "scroll_down",
      ]),
      x: z.number().optional().describe("X coordinate (0-1280)"),
      y: z.number().optional().describe("Y coordinate (0-800)"),
    },
    async ({ action, x, y }) => {
      if (x !== undefined && y !== undefined) {
        execSync(`DISPLAY=:99 xdotool mousemove ${Math.round(x)} ${Math.round(y)}`);
      }
      switch (action) {
        case "left_click":
          execSync("DISPLAY=:99 xdotool click 1");
          break;
        case "right_click":
          execSync("DISPLAY=:99 xdotool click 3");
          break;
        case "double_click":
          execSync("DISPLAY=:99 xdotool click --repeat 2 1");
          break;
        case "scroll_up":
          execSync("DISPLAY=:99 xdotool click --repeat 5 4");
          break;
        case "scroll_down":
          execSync("DISPLAY=:99 xdotool click --repeat 5 5");
          break;
      }
      return {
        content: [
          {
            type: "text",
            text: `Executed mouse action: ${action} (${x ?? "-"}, ${y ?? "-"})`,
          },
        ],
      };
    }
  );

  server.tool(
    "keyboard_action",
    "Type text or press key combinations (e.g., Return, BackSpace, ctrl+c, alt+Tab) on the Linux desktop.",
    {
      mode: z.enum(["type", "key"]),
      value: z.string().describe("Text string to type or xdotool key sequence"),
    },
    async ({ mode, value }) => {
      if (mode === "type") {
        const escaped = value.replace(/'/g, "'\\''");
        execSync(`DISPLAY=:99 xdotool type --delay 25 '${escaped}'`);
      } else {
        execSync(`DISPLAY=:99 xdotool key ${value}`);
      }
      return {
        content: [
          {
            type: "text",
            text: `Executed keyboard action [${mode}]: ${value}`,
          },
        ],
      };
    }
  );

  server.tool(
    "bash_exec",
    "Execute a bash command inside the Headful Linux desktop environment (DISPLAY=:99).",
    {
      command: z.string().describe("Shell command to execute"),
    },
    async ({ command }) => {
      return new Promise((resolve) => {
        exec(
          command,
          { env: { ...process.env, DISPLAY: ":99" }, timeout: 20000 },
          (err, stdout, stderr) => {
            const output = [stdout, stderr, err ? `Error: ${err.message}` : ""]
              .filter(Boolean)
              .join("\n");
            resolve({
              content: [
                {
                  type: "text",
                  text: output || "Command completed with no output.",
                },
              ],
            });
          }
        );
      });
    }
  );

  return server;
}

const app = express();
app.use(express.json());

if (API_KEY) {
  app.use("/desktop/mcp", (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });
}

app.post("/desktop/mcp", async (req, res) => {
  const server = createDesktopMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[desktop-mcp] Listening on 127.0.0.1:${PORT}/desktop/mcp`);
});
