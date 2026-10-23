import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

export async function runVisualReview(port) {
  const output = '/tmp/toruni-visual-review';
  await mkdir(output, { recursive: true });
  const chrome = spawn('/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--remote-debugging-port=9327', '--user-data-dir=/tmp/toruni-visual-profile', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errorOutput = '';
  chrome.stderr.on('data', data => { errorOutput += data.toString(); });
  let socket;
  try {
    let target;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const pages = await (await fetch('http://127.0.0.1:9327/json')).json();
        target = pages.find(page => page.type === 'page');
        if (target) break;
      } catch { /* Wait for the browser's CDP socket. */ }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!target) throw new Error(`Chromium did not start: ${errorOutput.slice(0, 600)}`);
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const pending = new Map();
    socket.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        message.error ? reject(new Error(message.error.message)) : resolve(message.result);
      }
    };
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    const evaluate = async expression => { const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.text); return response.result.value; };
    await call('Page.enable');
    const evidence = [];
    for (const width of [1440, 390]) {
      await call('Emulation.setDeviceMetricsOverride', { width, height: width === 390 ? 844 : 1100, deviceScaleFactor: 1, mobile: width === 390 });
      for (const route of ['/', '/arena?mode=spectate', '/results/00000000-0000-0000-0000-000000000000']) {
        await call('Page.navigate', { url: `http://127.0.0.1:${port}${route}` });
        await new Promise(resolve => setTimeout(resolve, 3200));
        const viewport = await evaluate('document.querySelector("meta[name=viewport]")?.content');
        if (!viewport?.includes('width=device-width')) throw new Error('Viewport declaration is missing.');
        const cors = await evaluate('fetch("https://api-v2-testnet.strikefinance.org/v2/time").then(r => r.status).catch(() => "blocked")');
        evidence.push({ route, width, publicStrikeBrowserCors: cors });
        const label = route === '/' ? 'lobby' : route.startsWith('/arena') ? 'arena' : 'results-not-found';
        const capture = async name => {
          const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
          await writeFile(`${output}/${name}-${width}.png`, Buffer.from(shot.data, 'base64'));
        };
        await capture(label);
        evidence.push({ route, width, viewport, horizontalOverflow: await evaluate('document.documentElement.scrollWidth > innerWidth'),
          heading: await evaluate('document.querySelector("h1")?.textContent'),
          font: await evaluate('getComputedStyle(document.body).fontFamily'),
          tokens: await evaluate('({background:getComputedStyle(document.body).backgroundColor,text:getComputedStyle(document.body).color,headingSize:getComputedStyle(document.querySelector("h1")).fontSize,headingWeight:getComputedStyle(document.querySelector("h1")).fontWeight,headingLineHeight:getComputedStyle(document.querySelector("h1")).lineHeight,panelRadius:document.querySelector(".panel")?getComputedStyle(document.querySelector(".panel")).borderRadius:null})') });
        if (width === 390 && route.startsWith('/arena')) {
          for (const tab of ['Market', 'Standings', 'Quotes']) {
            await evaluate(`[...document.querySelectorAll('.mobile-tab')].find(b => b.textContent.trim().toLowerCase() === '${tab.toLowerCase()}')?.click()`);
            await new Promise(resolve => setTimeout(resolve, 100));
            const selected = await evaluate(`document.querySelector('.mobile-tab[aria-pressed="true"]')?.textContent?.trim()`);
            if (selected?.toLowerCase() !== tab.toLowerCase()) throw new Error('Mobile tab did not activate: '+tab);
            await capture('arena-'+tab.toLowerCase());
            evidence.push({ screen:'arena-'+tab.toLowerCase(), width, selected, horizontalOverflow:await evaluate('document.documentElement.scrollWidth > innerWidth') });
          }
        }
        if (route === '/') {
          for (const [name, expression] of [
            ['rules', '[...document.querySelectorAll("button")].find(b => b.textContent.includes("Scoring rules"))?.click()'],
            ['risk', '[...document.querySelectorAll("button")].find(b => b.textContent.includes("Margin and positions"))?.click()'],
            ['wallet', '[...document.querySelectorAll("button")].find(b => b.textContent.includes("Connect wallet"))?.click()'],
            ['orders', 'document.querySelector("[aria-label=\\"Open order details\\"]")?.click()'],
          ]) {
            await evaluate(expression);
            await new Promise(resolve => setTimeout(resolve, 150));
            if (!await evaluate('!!document.querySelector("dialog[open]")')) throw new Error(name+' dialog did not open');
            await capture(name);
            await call('Input.dispatchKeyEvent', { type:'keyDown', key:'Tab', code:'Tab', windowsVirtualKeyCode:9 });
            await call('Input.dispatchKeyEvent', { type:'keyUp', key:'Tab', code:'Tab', windowsVirtualKeyCode:9 });
            if (!await evaluate('document.querySelector("dialog[open]")?.contains(document.activeElement)')) throw new Error('Focus left '+name+' dialog');
            evidence.push({ screen:name, width, focusAfterTab:await evaluate('document.activeElement?.tagName'), focusWithinDialog:await evaluate('document.querySelector("dialog[open]")?.contains(document.activeElement)') });
            evidence.push({ screen:name, width, dialogOpen: await evaluate('!!document.querySelector("dialog[open]")') });
            await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            await new Promise(resolve => setTimeout(resolve, 100));
            if (await evaluate('!!document.querySelector("dialog[open]")')) throw new Error('Escape did not close '+name);
          }
        }
      }
    }
    await writeFile(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));
    console.info('Toruni visual captures:', output, JSON.stringify(evidence));
  } finally { socket?.close(); chrome.kill(); }
}
