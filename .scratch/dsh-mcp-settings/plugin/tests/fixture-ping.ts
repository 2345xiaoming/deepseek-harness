/**
 * Minimal stdio MCP server owned by this plugin's tests: tools `ping` (empty
 * input, echoes the `MCP_FIXTURE_KEY` env var) and `drift` (empty input).
 * Distinct tool names from the shared repo fixture let tests observe a
 * generation replacement across an edit.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer(
  { name: 'fixture-ping', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
)

server.registerTool('ping', {
  title: 'Ping Tool',
  description: 'Replies pong and echoes the MCP_FIXTURE_KEY env var.',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: `pong key=${process.env.MCP_FIXTURE_KEY ?? ''}` }],
}))

server.registerTool('drift', {
  title: 'Drift Tool',
  description: 'Replies drift.',
  inputSchema: {},
}, async () => ({
  content: [{ type: 'text', text: 'drift' }],
}))

const transport = new StdioServerTransport()
await server.connect(transport)
