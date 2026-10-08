const http = require('http');
const WebSocket = require('ws');

// 1. 获取页面列表
http.get('http://127.0.0.1:9222/json', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const pages = JSON.parse(data);
    const page = pages.find(p => p.type === 'page' && p.url.includes('index.html'));
    if (!page) {
      console.log('No page found. Pages:', pages.map(p => p.url));
      process.exit(1);
    }
    console.log('Found page:', page.url);

    // 2. 连接 WebSocket
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let msgId = 1;

    function send(method, params) {
      return new Promise((resolve) => {
        const id = msgId++;
        ws.send(JSON.stringify({ id, method, params }));
        ws.on('message', function handler(msg) {
          const resp = JSON.parse(msg);
          if (resp.id === id) {
            ws.removeListener('message', handler);
            resolve(resp);
          }
        });
      });
    }

    ws.on('open', async () => {
      // 注入测试 HTML：模拟 image_analyze 的 pending 和 complete 状态
      const testJS = `
        (function() {
          // 创建测试容器
          const testDiv = document.createElement('div');
          testDiv.id = 'cdp-test-media';
          testDiv.style.cssText = 'position:fixed;top:10px;right:10px;width:400px;z-index:99999;background:#1a1a2e;padding:16px;border-radius:8px;';
          testDiv.innerHTML = \`
            <div class="tool-call-group tool-media-group">
              <div class="tool-group-header"><span class="tool-group-current">分析图片</span></div>
              <div class="tool-media-timeline"></div>
              <div class="tool-group-list">
                <div class="tool-call-card tool-media-card">
                  <div class="tool-card-detail tool-media-stage-detail">
                    <div class="tool-media-stage is-pending" data-media-kind="vision">
                      <div class="tool-media-visual">
                        <img class="tool-media-source" src="https://picsum.photos/400/200" alt="" data-media-source="1">
                        <canvas class="tool-media-prism-canvas" aria-hidden="true"></canvas>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          \`;
          document.body.appendChild(testDiv);

          // 等待渲染
          return new Promise(resolve => {
            setTimeout(() => {
              const visual = testDiv.querySelector('.tool-media-visual');
              const stage = testDiv.querySelector('.tool-media-stage');
              const card = testDiv.querySelector('.tool-call-card');
              const detail = testDiv.querySelector('.tool-card-detail');
              const source = testDiv.querySelector('.tool-media-source');
              const canvas = testDiv.querySelector('.tool-media-prism-canvas');
              const group = testDiv.querySelector('.tool-media-group');
              const list = testDiv.querySelector('.tool-group-list');
              const header = testDiv.querySelector('.tool-group-header');

              const cs = el => el ? {
                width: getComputedStyle(el).width,
                height: getComputedStyle(el).height,
                margin: getComputedStyle(el).margin,
                padding: getComputedStyle(el).padding,
                aspectRatio: getComputedStyle(el).aspectRatio,
                display: getComputedStyle(el).display,
                position: getComputedStyle(el).position,
                overflow: getComputedStyle(el).overflow,
                offsetHeight: el.offsetHeight,
                offsetWidth: el.offsetWidth,
                clientHeight: el.clientHeight,
                clientWidth: el.clientWidth,
              } : null;

              resolve(JSON.stringify({
                group: cs(group),
                header: cs(header),
                list: cs(list),
                card: cs(card),
                detail: cs(detail),
                stage: cs(stage),
                visual: cs(visual),
                source: cs(source),
                canvas: cs(canvas),
              }, null, 2));
            }, 2000);
          });
        })()
      `;

      const result = await send('Runtime.evaluate', {
        expression: testJS,
        awaitPromise: true,
        returnByValue: true,
      });
      console.log('Result:', result.result?.value || result.error);
      ws.close();
      process.exit(0);
    });

    ws.on('error', (err) => {
      console.error('WS error:', err.message);
      process.exit(1);
    });
  });
}).on('error', (err) => {
  console.error('HTTP error:', err.message);
  process.exit(1);
});
