import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";

const base = process.env.TORUNI_REVIEW_URL ?? "http://127.0.0.1:5175";
const output = process.env.TORUNI_REVIEW_OUTPUT ?? "/tmp/toruni-leaderboard-evidence";
const chromium = process.env.CHROMIUM_PATH ?? "/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome";
const debuggingPort = 20000 + process.pid % 20000;
await mkdir(output, { recursive: true });
const chrome = spawn(chromium, [
  "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
  `--remote-debugging-port=${debuggingPort}`, `--user-data-dir=/tmp/toruni-leaderboard-${process.pid}`, "about:blank",
], { stdio: "ignore" });
let socket;
try {
  let target;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${debuggingPort}/json`)).json()).find(page => page.type === "page");
      if (target) break;
    } catch { /* Chromium is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!target) throw new Error("Chromium did not start.");
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  let failNextLeaderboardRequest = false;
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === "Fetch.requestPaused") {
      const params = message.params;
      const fail = failNextLeaderboardRequest && params.request.url.includes("/api/leaderboard");
      if (fail) failNextLeaderboardRequest = false;
      const response = fail ? {
        id: ++id, method:"Fetch.fulfillRequest", params:{requestId:params.requestId,responseCode:503,
          responseHeaders:[{name:"Content-Type",value:"application/json"}],body:Buffer.from('{"error":"unavailable"}').toString("base64")},
      } : { id: ++id, method:"Fetch.continueRequest", params:{requestId:params.requestId} };
      socket.send(JSON.stringify(response));
      return;
    }
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timed out: ${method}`)); }, 15_000);
    pending.set(requestId, { resolve: result => { clearTimeout(timeout); resolve(result); }, reject: error => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async expression => {
    let result;
    try { result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); }
    catch (error) { throw new Error(`Evaluation failed (${expression.slice(0,120)}): ${error.message}`); }
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async expression => {
    for (let n = 0; n < 40; n++) {
      const value = await evaluate(expression);
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for ${expression}`);
  };
  await call("Page.enable");
  const evidence = [];
  for (const [width, height] of [[360,640],[390,844],[1440,1000]]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 768 });
    if (width === 360) {
      await call("Fetch.enable", { patterns:[{urlPattern:"*api/leaderboard*",requestStage:"Request"}] });
      failNextLeaderboardRequest = true;
    }
    await call("Page.navigate", { url: `${base}/leaderboard?symbol=BTC-USD&period=all` });
    await waitFor("document.querySelector('h1')?.textContent === 'Leaderboard'");
    let errorRecovery = null;
    if (width === 360) {
      await waitFor("document.querySelector('.leaderboard-empty h2')?.textContent === 'Rankings unavailable'");
      const retryVisible = await evaluate("document.querySelector('.leaderboard-empty button')?.textContent.trim() === 'Try again'");
      if (!retryVisible) throw new Error("A leaderboard fetch failure did not offer a retry.");
      await call("Fetch.disable");
      await evaluate("document.querySelector('.leaderboard-empty button')?.click()");
      await waitFor("Boolean(document.querySelector('.leaderboard-table tbody tr'))");
      errorRecovery = { injectedStatus:503, errorCopy:"Rankings unavailable", retryVisible, recoveredRows:await evaluate("document.querySelectorAll('.leaderboard-table tbody tr').length") };
      evidence.push({ screen:"isolated leaderboard fetch failure and retry", width, ...errorRecovery });
    } else {
      await waitFor("Boolean(document.querySelector('.leaderboard-table tbody tr') || document.querySelector('.leaderboard-empty h2'))");
    }
    const loaded = await evaluate(`(() => {
      const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.sr-only,[aria-hidden="true"]');
      const textNodes = [...document.querySelectorAll('body *')].filter(el => visible(el) && [...el.childNodes].some(n => n.nodeType===Node.TEXT_NODE && n.textContent.trim()));
      const smallText = textNodes.filter(el => parseFloat(getComputedStyle(el).fontSize)<14).map(el=>({text:el.textContent.trim().slice(0,50),size:getComputedStyle(el).fontSize}));
      return {title:document.querySelector('h1')?.textContent, viewport:document.querySelector('meta[name=viewport]')?.content,
        width:innerWidth, documentWidth:document.documentElement.scrollWidth, horizontalOverflow:document.documentElement.scrollWidth>innerWidth,
        nav:[...document.querySelectorAll('.site-navigation a')].map(a=>a.textContent.trim()), rows:document.querySelectorAll('.leaderboard-table tbody tr').length,
        maker:document.querySelector('.leaderboard-maker')?.textContent.trim()??null, makerAliasLooksRaw:/^(0x|[a-f0-9]{32,})/i.test(document.querySelector('.leaderboard-maker')?.textContent??''),
        empty:document.querySelector('.leaderboard-empty h2')?.textContent??null, smallText,
        font:getComputedStyle(document.body).fontFamily, panelRadius:getComputedStyle(document.querySelector('.leaderboard-panel')).borderRadius,
        market:document.querySelector('[aria-label="Leaderboard market"]')?.value, period:document.querySelector('[aria-pressed="true"]')?.textContent.trim()};
    })()`);
    if (!loaded.viewport?.includes("width=device-width")) throw new Error(`Missing device viewport at ${width}px.`);
    if (loaded.horizontalOverflow) throw new Error(`Horizontal overflow at ${width}px: ${JSON.stringify(loaded)}`);
    if (loaded.smallText.length) throw new Error(`Visible text below 14px at ${width}px: ${JSON.stringify(loaded.smallText)}`);
    if (loaded.makerAliasLooksRaw) throw new Error("Raw account identifier appears in maker display.");
    if (!loaded.nav.includes("Leaderboard") || !loaded.nav.includes("Arena")) throw new Error(`Missing app shell navigation: ${JSON.stringify(loaded.nav)}`);
    const capture = async suffix => {
      const shot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      await writeFile(`${output}/leaderboard-${suffix}-${width}.png`, Buffer.from(shot.data, "base64"));
    };
    await capture("btc-all-time");
    evidence.push({ screen: "BTC all time", ...loaded });
    await call("Input.dispatchKeyEvent", { type:"keyDown", key:"Tab", code:"Tab", windowsVirtualKeyCode:9 });
    await call("Input.dispatchKeyEvent", { type:"keyUp", key:"Tab", code:"Tab", windowsVirtualKeyCode:9 });
    const focus = await evaluate("(() => {const el=document.activeElement,s=getComputedStyle(el),r=el.getBoundingClientRect();return {tag:el.tagName,label:(el.innerText||el.getAttribute('aria-label')||'').trim().slice(0,40),outline:s.outlineStyle,outlineWidth:s.outlineWidth,visible:r.width>0&&r.height>0}})()");
    if (!focus.visible || focus.outline === "none" || parseFloat(focus.outlineWidth) < 1) throw new Error(`Keyboard focus is not visible at ${width}px: ${JSON.stringify(focus)}`);
    evidence.push({ screen:"keyboard focus", width, ...focus });

    if (loaded.rows) {
      const initial = await evaluate("(async()=>{const board=await fetch('/api/leaderboard?symbol=BTC-USD&period=all').then(r=>r.json());const row=document.querySelector('.leaderboard-table tbody tr');return {symbol:new URLSearchParams(location.search).get('symbol'),period:new URLSearchParams(location.search).get('period'),href:document.querySelector('.leaderboard-result')?.getAttribute('href'),makerId:board.entries?.[0]?.makerId,visibleMaker:row?.querySelector('.leaderboard-maker')?.textContent.trim()}})()");
      await evaluate("document.querySelector('.leaderboard-result')?.click()");
      await waitFor("location.pathname.startsWith('/results/')");
      const resultPath = await evaluate("location.pathname");
      const resultIdentity = await evaluate("(async()=>{const roundId=location.pathname.split('/').pop();const r=await fetch(`/api/rounds/${roundId}/results`);const data=await r.json();return {status:r.status,makerIds:data.participants?.map(p=>p.makerId).filter(Boolean)??[],visibleMaker:[...document.querySelectorAll('.result-score .panel-kicker')].map(el=>el.textContent.trim())}})()");
      const makerConsistent = resultIdentity.status === 200 && resultIdentity.makerIds.includes(initial.makerId)
        && resultIdentity.visibleMaker.includes(`MAKER ${initial.makerId.slice(0,8).toUpperCase()}`);
      if (!makerConsistent) throw new Error(`Leaderboard maker alias did not match the real round report: ${JSON.stringify({leaderboardMaker:initial.makerId,resultIdentity})}`);
      const roundClickWasSameOrigin = initial.href?.startsWith("/results/");
      const history = await call("Page.getNavigationHistory");
      const backEntry = history.entries[history.currentIndex - 1];
      if (!backEntry?.url.includes("/leaderboard?symbol=BTC-USD&period=all")) throw new Error(`Leaderboard state is not the browser Back entry: ${backEntry?.url}`);
      await call("Page.navigateToHistoryEntry", { entryId: backEntry.id });
      await waitFor("location.pathname === '/leaderboard'");
      const browserBackReturned = await evaluate("location.pathname === '/leaderboard' && new URLSearchParams(location.search).get('symbol')==='BTC-USD' && new URLSearchParams(location.search).get('period')==='all'");
      if (!browserBackReturned) throw new Error("Browser Back did not restore the selected leaderboard state.");
      evidence.push({ screen:"real best-round navigation", initial, resultPath, resultIdentity, makerConsistent, browserBackReturned, roundClickWasSameOrigin });
      await call("Page.navigate", { url: `${base}/leaderboard?symbol=BTC-USD&period=all` });
      await waitFor("Boolean(document.querySelector('.leaderboard-table tbody tr'))");
    }

    await evaluate(`(() => {const select=document.querySelector('[aria-label="Leaderboard market"]');select.value='ETH-USD';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor("new URLSearchParams(location.search).get('symbol') === 'ETH-USD'");
    await waitFor("Boolean(document.querySelector('.leaderboard-empty h2') || document.querySelector('.leaderboard-table tbody tr'))");
    const marketEmpty = await evaluate("document.querySelector('.leaderboard-empty h2')?.textContent??null");
    if (marketEmpty !== "No completed rounds yet") throw new Error(`Expected a true empty market state, got ${marketEmpty}`);
    await capture("eth-all-time");
    await evaluate("[...document.querySelectorAll('.leaderboard-period button')].find(button=>button.textContent.trim()==='7 days')?.click()");
    await waitFor("new URLSearchParams(location.search).get('period') === '7d'");
    await waitFor("Boolean(document.querySelector('.leaderboard-empty h2') || document.querySelector('.leaderboard-table tbody tr'))");
    const periodEmpty = await evaluate("document.querySelector('.leaderboard-empty h2')?.textContent??null");
    if (periodEmpty !== "No completed rounds yet") throw new Error(`Expected a true seven-day empty state, got ${periodEmpty}`);
    await capture("eth-seven-days");
    evidence.push({ screen:"ETH empty states", marketEmpty, periodEmpty });

    // Verify the shared shell can navigate away and back while remaining in the SPA.
    await evaluate("[...document.querySelectorAll('.site-navigation a')].find(link=>link.textContent.trim()==='Arena')?.click()");
    await waitFor("location.pathname === '/arena'");
    const arenaShell = await evaluate("Boolean(document.querySelector('.site-navigation a[aria-current=page]'))");
    await evaluate("[...document.querySelectorAll('.site-navigation a')].find(link=>link.textContent.trim()==='Leaderboard')?.click()");
    await waitFor("location.pathname === '/leaderboard'");
    const restoredShell = await evaluate("Boolean(document.querySelector('.site-navigation a[aria-current=page]'))");
    evidence.push({ screen:"SPA shell navigation", arenaShell, restoredShell, url:await evaluate("location.pathname+location.search") });
    await writeFile(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));
  }
  process.stdout.write(`${output}\n${JSON.stringify(evidence)}\n`);
} finally {
  socket?.close();
  chrome.kill();
}
