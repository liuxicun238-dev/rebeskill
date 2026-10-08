const http = require('http');

function post(body, headers = {}) {
  return new Promise((ok, no) => {
    const b = JSON.stringify(body);
    const opts = {
      hostname: '127.0.0.1',
      port: 8000,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(b),
        ...headers
      }
    };
    const r = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', no);
    r.write(b);
    r.end();
  });
}

(async () => {
  try {
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } } });
    console.log('INIT STATUS:', init.status);
    const sid = init.headers['mcp-session-id'];
    console.log('SESSION:', sid);
    
    const h = { 'Mcp-Session-Id': sid, 'MCP-Protocol-Version': '2024-11-05' };
    await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, h);
    
    const tools = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, h);
    console.log('TOOLS STATUS:', tools.status);
    const parsed = JSON.parse(tools.body);
    console.log('TOOL COUNT:', parsed.result.tools.length);
    parsed.result.tools.forEach(t => console.log(' -', t.name));
  } catch (e) {
    console.error('FAIL:', e.message);
    console.error(e.stack);
    process.exitCode = 1;
  }
})();