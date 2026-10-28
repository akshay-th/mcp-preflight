// Fixture MCP server. MODE (argv[2]): ok | noise | crash | hang
import { onLines, tryParse } from '../../src/lines.js';

const mode = process.argv[2] || 'ok';
if (mode === 'crash') {
  console.error('Error: GITHUB_TOKEN is required');
  process.exit(1);
}
if (mode === 'noise') console.log('Server listening on stdio...');
if (mode === 'hang') setInterval(() => {}, 1000);

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
onLines(process.stdin, (line) => {
  if (mode === 'hang') return;
  const msg = tryParse(line);
  if (!msg || msg.id == null) return;
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.2.3' } } });
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          { name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
          { name: 'env', description: `token set: ${Boolean(process.env.FIXTURE_TOKEN)}`, inputSchema: { type: 'object' } },
        ],
      },
    });
  }
});
