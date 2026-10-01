/** Connects to the Sentinel MCP server with the official client and exercises the tools. MCP_URL overrides the target. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.MCP_URL ?? 'http://127.0.0.1:8787/api/mcp';
const client = new Client({ name: 'sentinel-check', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
console.log('server:', client.getServerVersion()?.name, client.getServerVersion()?.version);
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
const text = (r: any) => (r.content?.[0]?.text ?? '').split('\n')[0];
console.log('\nscan_token(CLAW) →', text(await client.callTool({ name: 'scan_token', arguments: { mint: '739dnZEG4yaBWFsY8L8ZwrfhGG6dhtCSercW8Umspump' } })));
console.log('scan_token(rug)  →', text(await client.callTool({ name: 'scan_token', arguments: { mint: 'CFgZyepFRMeBoJNvKw8X59RnD6KR3rdZhLKxGyimpump' } })));
const wallet = 'GSiqvKLVGmTJ9UzautG4vE8vT3uSEoKZp3cGzSrb6ak6';
console.log('execute_intent(buy CLAW) →', text(await client.callTool({ name: 'execute_intent', arguments: { intent: { type: 'buy', wallet, mint: '739dnZEG4yaBWFsY8L8ZwrfhGG6dhtCSercW8Umspump', sol: 0.01 } } })));
console.log('execute_intent(drain)    →', text(await client.callTool({ name: 'execute_intent', arguments: { intent: { type: 'transfer', wallet, to: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', sol: 0.75 }, policy: { limits: { per_tx_sol: 0.5 } } } })));
console.log('guard_status(demo)       →', text(await client.callTool({ name: 'guard_status', arguments: { multisig: '5gCSZUqpUQxmzwNWtmkdz3n62vvU8axKTTtKYC7tB5K3', cluster: 'devnet' } })));
const bad: any = await client.callTool({ name: 'scan_token', arguments: { mint: 'nope' } });
console.log('scan_token(invalid)      →', bad.isError ? 'isError ✅' : '❌', text(bad));
await client.close();
