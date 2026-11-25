// Everything goes to stderr: stdout belongs to the MCP stdio transport in shim mode.
export function log(msg: string): void {
  process.stderr.write(`[tabpilot ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}
