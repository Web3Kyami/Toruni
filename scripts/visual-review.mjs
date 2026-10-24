import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

export async function runVisualReview(port) {
  const output = '/tmp/toruni-visual-review';
  const applicationOrigin = `http://localhost:${port}`;
  await mkdir(output, { recursive: true });
  const debuggingPort = 10000 + process.pid % 20000;
  const chrome = spawn('/root/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    `--remote-debugging-port=${debuggingPort}`, `--user-data-dir=/tmp/toruni-visual-${process.pid}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errorOutput = '';
  chrome.stderr.on('data', data => { errorOutput += data.toString(); });
  let socket;
  try {
    let target;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const pages = await (await fetch(`http://127.0.0.1:${debuggingPort}/json`)).json();
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
      const timeout = setTimeout(() => {pending.delete(requestId);reject(new Error("CDP timed out: "+method));},15000);
      pending.set(requestId, { resolve: value => {clearTimeout(timeout);resolve(value);}, reject: error => {clearTimeout(timeout);reject(error);} });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    const evaluate = async expression => { const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (response.exceptionDetails) throw new Error(response.exceptionDetails.text); return response.result.value; };
    const auditVisibleText = () => evaluate(`(() => {
      const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.sr-only,[aria-hidden="true"]');
      const hasText = el => [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      const below14 = [...document.querySelectorAll('body *')].filter(el => visible(el) && hasText(el) && parseFloat(getComputedStyle(el).fontSize) < 14)
        .map(el => ({tag:el.tagName,text:el.textContent.trim().slice(0,60),font:getComputedStyle(el).fontSize}));
      for (const input of document.querySelectorAll('input[placeholder]')) {
        if (visible(input) && parseFloat(getComputedStyle(input,'::placeholder').fontSize) < 14) below14.push({tag:'INPUT::placeholder',text:input.placeholder,font:getComputedStyle(input,'::placeholder').fontSize});
      }
      const badge = document.querySelector('.network-badge')?.innerText ?? '';
      const otherEnvironmentLabels = document.body.innerText.replace(badge,'').match(/\\b(testnet|mainnet|devnet|sandbox)\\b/gi) ?? [];
      const feeCaveats = document.body.innerText.match(/Strike(?:’|'s)? trading fees may apply|Toruni adds no fee/gi) ?? [];
      const disabledQuoteHelper = Boolean(document.querySelector('.quote-disabled-reason'));
      const basisPointLabels = document.body.innerText.match(/\b(?:bps|basis points)\b/gi) ?? [];
      const mockWalletLabels = document.body.innerText.match(/\b(?:viewer wallet|wallet [ab]|review wallet|test wallet)\b/gi) ?? [];
      const connectActions = [...document.querySelectorAll('.topbar > .button--connect,.mobile-order-bar button:last-child')].filter(visible).length;
      return {visibleTextCount:[...document.querySelectorAll('body *')].filter(el => visible(el) && hasText(el)).length,below14,otherEnvironmentLabels,feeCaveats,disabledQuoteHelper,basisPointLabels,mockWalletLabels,connectActions};
    })()`);
    await call('Page.enable');
    const evidence = [];
    const requestedWidths = process.env.TORUNI_VISUAL_WIDTHS?.split(',').map(Number).filter(width => Number.isInteger(width) && width > 0);
    const widths = requestedWidths?.length ? requestedWidths : [360, 390, 1440];
    for (const width of widths) {
      await call('Emulation.setDeviceMetricsOverride', { width, height: width === 360 ? 640 : width === 390 ? 844 : 1000, deviceScaleFactor: 1, mobile: width < 768 });
      for (const route of ['/', '/arena?mode=spectate', '/results/00000000-0000-0000-0000-000000000000']) {
        console.info('Visual review route:',width,route);
        await call('Page.navigate', { url: `${applicationOrigin}${route}` });
        await new Promise(resolve => setTimeout(resolve, 3200));
        const viewport = await evaluate('document.querySelector("meta[name=viewport]")?.content');
        if (!viewport?.includes('width=device-width')) throw new Error('Viewport declaration is missing.');
        const cors = await evaluate('fetch("https://api-v2-testnet.strikefinance.org/v2/time", {signal:AbortSignal.timeout(5000)}).then(r => r.status).catch(() => "blocked")');
        evidence.push({ route, width, publicStrikeBrowserCors: cors });
        const copyAudit = await auditVisibleText();
        if (copyAudit.below14.length) throw new Error('Visible text under 14px: '+JSON.stringify(copyAudit.below14));
        if (copyAudit.otherEnvironmentLabels.length) throw new Error('Repeated environment labels: '+JSON.stringify(copyAudit.otherEnvironmentLabels));
        if (copyAudit.feeCaveats.length || copyAudit.disabledQuoteHelper || copyAudit.basisPointLabels.length || copyAudit.mockWalletLabels.length || copyAudit.connectActions !== 1) throw new Error('Unwanted helper, test-only copy, or duplicate/missing connection action is visible: '+JSON.stringify(copyAudit));
        evidence.push({ route, width, copyAudit });
        const label = route === '/' ? 'lobby' : route.startsWith('/arena') ? 'arena' : 'results-not-found';
        const capture = async name => {
          const shot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !["how", "rules", "wallet", "join", "risk", "orders"].includes(name) });
          await writeFile(`${output}/${name}-${width}.png`, Buffer.from(shot.data, 'base64'));
        };
        await capture(label);
        if (route === '/') {
          for (const symbol of ['ETH-USD', 'SOL-USD']) {
            const selected = await evaluate(`(() => {const select=document.querySelector('#arena-market'); if(!select)return null; select.value='${symbol}'; select.dispatchEvent(new Event('change',{bubbles:true})); return select.value;})()`);
            if (selected !== symbol) throw new Error('Market selector did not activate '+symbol);
            await new Promise(resolve => setTimeout(resolve, 400));
            await capture(`market-${symbol.toLowerCase().split('-')[0]}`);
          }
          if (width < 768) await evaluate(`[...document.querySelectorAll('.mobile-tab')].find(b=>b.textContent.trim().toLowerCase()==='standings')?.click()`);
          await evaluate(`(() => {const select=document.querySelector('#arena-market'); select.value='BTC-USD'; select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
          await new Promise(resolve => setTimeout(resolve, 1200));
          const activityState = await evaluate(`(() => {const scroller=document.querySelector('.activity-scroll');const rows=[...document.querySelectorAll('.activity-list li')];const rect=scroller?.getBoundingClientRect();const visibleRows=rect?rows.filter(row=>{const r=row.getBoundingClientRect();return r.bottom>rect.top&&r.top<rect.bottom}).length:0;return {rows:rows.length,visibleRows,clientHeight:scroller?.clientHeight??null,scrollHeight:scroller?.scrollHeight??null,maxHeight:scroller?getComputedStyle(scroller).maxHeight:null,overflowY:scroller?getComputedStyle(scroller).overflowY:null}})()`);
          await capture('market-btc-activity');
          if (activityState.rows && (activityState.rows > 4 ? activityState.visibleRows !== 4 || activityState.scrollHeight <= activityState.clientHeight : activityState.visibleRows !== activityState.rows)) throw new Error('BTC activity viewport does not show up to four real entries with scrolling: '+JSON.stringify(activityState));
          evidence.push({screen:'market-btc-activity',width,activityState});
          if (width < 768) await evaluate(`[...document.querySelectorAll('.mobile-tab')].find(b=>b.textContent.trim().toLowerCase()==='quotes')?.click()`);
          const marketChecks = await evaluate(`(() => {
            const trend=document.querySelector('.market-trend');
            const review=document.querySelector('.quote-button');
            const label=document.querySelector('.market-toolbar label');
            const value=document.querySelector('.market-toolbar select');
            const transient=document.querySelectorAll('.feed-banner').length;
            const activity=document.querySelector('.activity-scroll');
            const quoteLabel=document.querySelector('.quote-fields label');
            const quoteValue=document.querySelector('.input-shell input');
            return {trend:Boolean(trend), labelSize:label&&getComputedStyle(label).fontSize, selectorSize:value&&getComputedStyle(value).fontSize,
              reviewText:review?.textContent.trim(),reviewLineRects:review?(()=>{const text=[...review.childNodes].find(node=>node.nodeType===Node.TEXT_NODE&&node.textContent.trim());if(!text)return null;const range=document.createRange();range.selectNodeContents(text);return range.getClientRects().length})():null,
              quoteLabelSize:quoteLabel&&getComputedStyle(quoteLabel).fontSize,quoteValueSize:quoteValue&&getComputedStyle(quoteValue).fontSize,
              transientFeedBanner:transient,activityScroll:activity?{height:activity.getBoundingClientRect().height,maxHeight:getComputedStyle(activity).maxHeight,overflowY:getComputedStyle(activity).overflowY}:null};
          })()`);
          if (!marketChecks.trend || marketChecks.labelSize !== '14px' || marketChecks.selectorSize !== '16px' || marketChecks.quoteLabelSize !== '14px' || marketChecks.quoteValueSize !== '16px' || marketChecks.transientFeedBanner || (marketChecks.reviewLineRects && marketChecks.reviewLineRects > 1) || (marketChecks.activityScroll && (marketChecks.activityScroll.maxHeight !== '320px' || marketChecks.activityScroll.overflowY !== 'auto'))) throw new Error('Market presentation checks failed: '+JSON.stringify(marketChecks));
          evidence.push({screen:'market-selection-and-trend',width,...marketChecks});
          if (width === 1440) {
            const initial = await evaluate(`(() => {const active=document.querySelector('.hero-heading-slide.is-active');const r=active?.getBoundingClientRect();return {text:active?.innerText.trim(),bounds:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null}})()`);
            await new Promise(resolve => setTimeout(resolve, 8200));
            const advanced = await evaluate(`(() => {const active=document.querySelector('.hero-heading-slide.is-active');const r=active?.getBoundingClientRect();return {text:active?.innerText.trim(),bounds:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null}})()`);
            if (!initial.text || advanced.text === initial.text || JSON.stringify(advanced.bounds) !== JSON.stringify(initial.bounds)) throw new Error('Hero headline did not advance while preserving its layout bounds.');
            await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
            await new Promise(resolve => setTimeout(resolve, 100));
            const reducedStart = await evaluate(`(() => {const active=document.querySelector('.hero-heading-slide.is-active');return {text:active?.innerText.trim(),animation:getComputedStyle(active).animationName}})()`);
            await new Promise(resolve => setTimeout(resolve, 8200));
            const reducedEnd = await evaluate(`(() => {const active=document.querySelector('.hero-heading-slide.is-active');return {text:active?.innerText.trim(),animation:getComputedStyle(active).animationName}})()`);
            if (reducedStart.text !== reducedEnd.text || reducedStart.animation !== 'none' || reducedEnd.animation !== 'none') throw new Error('Reduced-motion preference did not keep the headline still: '+JSON.stringify({reducedStart,reducedEnd}));
            evidence.push({screen:'hero-motion',width,initial,advanced,reducedStart,reducedEnd});
            await call('Emulation.setEmulatedMedia', { features: [] });
          }
          const quoteAction = await evaluate(`(() => {
            const button = [...document.querySelectorAll('.quote-button')].find(item => item.textContent.includes('Review buy'));
            const helper = document.querySelector('.quote-disabled-reason');
            if (!button) return {buttonFound:false,buttonEnabled:false,helperVisible:Boolean(helper)};
            button.click();
            return {buttonFound:true,buttonEnabled:!button.disabled,helperVisible:Boolean(helper)};
          })()`);
          if (!quoteAction.buttonFound || !quoteAction.buttonEnabled || quoteAction.helperVisible) throw new Error('Offer review should be actionable without a pre-click explanation: '+JSON.stringify(quoteAction));
          let nextStep = null;
          for (let wait = 0; wait < 30; wait++) {
            nextStep = await evaluate(`({notice:document.querySelector('.quote-notice')?.textContent?.trim()??null,dialog:document.querySelector('#dialog-title')?.textContent??null,walletModal:Boolean(document.querySelector('[data-rk] [role=dialog]'))})`);
            if (nextStep.notice || nextStep.dialog || nextStep.walletModal) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          if (!nextStep.notice && !nextStep.dialog && !nextStep.walletModal) throw new Error('Offer review did not open the next action or show a current blocker.');
          await new Promise(resolve => setTimeout(resolve, 650));
          await capture('review-next-step');
          evidence.push({screen:'blocked-offer-review',width,...quoteAction,nextStep});
          await call('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
          await call('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
          await new Promise(resolve => setTimeout(resolve, 100));
        }
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
            ['how', '[...document.querySelectorAll("button")].find(b => /How it works|How to play/.test(b.textContent) && b.getClientRects().length)?.click()'],
            ['rules', '[...document.querySelectorAll("button")].find(b => /Scoring rules|Rules & scoring/.test(b.textContent) && b.getClientRects().length)?.click()'],
            ['risk', '[...document.querySelectorAll("button")].find(b => b.textContent.includes("Margin and positions"))?.click()'],
            ['join', '[...document.querySelectorAll("button")].find(b => /Start challenge|Join challenge/.test(b.textContent) && b.getClientRects().length)?.click()'],
            ['wallet', '[...document.querySelectorAll(".mobile-order-bar button:last-child,.topbar .button--connect")].find(b => b.getClientRects().length)'],
            ['orders', '[...document.querySelectorAll("button")].find(b => b.textContent.includes("Order details"))?.click()'],
          ]) {
            const rect = await evaluate(`(() => {const button=${expression.replace('?.click()', '')}; if(!button) return null;button.scrollIntoView({block:'center',behavior:'instant'});const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
            if (!rect) throw new Error('Missing '+name+' action');
            const actionEnabled = await evaluate(`(() => {const button=${expression.replace('?.click()', '')};return !button.disabled;})()`);
            if (name === 'join' && !actionEnabled) { evidence.push({screen:name,width,skipped:'Join is disabled by current round or wallet prerequisites.'}); continue; }
            await call('Input.dispatchMouseEvent', {type:'mousePressed',...rect,button:'left',clickCount:1});
            await call('Input.dispatchMouseEvent', {type:'mouseReleased',...rect,button:'left',clickCount:1});
            await new Promise(resolve => setTimeout(resolve, 650));
            if (!await evaluate('!!document.querySelector("[role=dialog]")')) throw new Error(name+' dialog did not open');
            await capture(name);
            const usesWalletPicker = name === 'join' || name === 'wallet';
            const box = await evaluate(`(() => {const d=${usesWalletPicker ? "document.querySelector('[data-rk] [role=document]')" : "document.querySelector('.modal')"};if(!d)return null;const r=d.getBoundingClientRect(),style=getComputedStyle(d),overlay=document.querySelector('[data-rk] [role=dialog]');const surfaceBackgrounds=[...document.querySelectorAll('[data-rk] *')].map(el=>getComputedStyle(el).backgroundColor).filter(color=>color==='rgb(26, 27, 31)');return {height:r.height,width:r.width,top:r.top,bottom:r.bottom,viewport:innerHeight,viewportWidth:innerWidth,fontLoaded:document.fonts.check('500 16px "Plus Jakarta Sans"'),pickerBackground:style.backgroundColor,surfaceBackgrounds,modalThemeVar:style.getPropertyValue('--rk-colors-modalBackground').trim(),overlayBackground:overlay?getComputedStyle(overlay).backgroundColor:null,overlayOpacity:overlay?getComputedStyle(overlay).opacity:null}})()`);
            if (usesWalletPicker && box && (!box.surfaceBackgrounds.length || !box.modalThemeVar || !box.overlayBackground || box.overlayOpacity !== '1')) throw new Error('Wallet picker surface or overlay is missing its static theme styling: '+JSON.stringify(box));
            if (name === 'wallet' && !box) {
              evidence.push({screen:name,width,skipped:'Wallet picker is unavailable in this unconnected browser.'});
              await call('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
              await call('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
              continue;
            }
            const minimumHeight = usesWalletPicker ? 160 : 240;
            if(!box || box.height < minimumHeight || box.width > box.viewportWidth+1 || box.top < 0 || box.bottom > box.viewport+1) throw new Error('Collapsed or clipped '+name+' sheet: '+JSON.stringify(box));
            const dialogCopyAudit = await auditVisibleText();
            if (dialogCopyAudit.below14.length) throw new Error(name+' dialog has visible text under 14px: '+JSON.stringify(dialogCopyAudit.below14));
            if (dialogCopyAudit.otherEnvironmentLabels.length) throw new Error(name+' dialog repeats environment labels: '+JSON.stringify(dialogCopyAudit.otherEnvironmentLabels));
            evidence.push({screen:name,viewportWidth:width,...box,copyAudit:dialogCopyAudit});
            await call('Input.dispatchKeyEvent', { type:'keyDown', key:'Tab', code:'Tab', windowsVirtualKeyCode:9 });
            await call('Input.dispatchKeyEvent', { type:'keyUp', key:'Tab', code:'Tab', windowsVirtualKeyCode:9 });
            if (!await evaluate('document.querySelector("[role=dialog]")?.contains(document.activeElement)')) throw new Error('Focus left '+name+' dialog');
            evidence.push({ screen:name, width, focusAfterTab:await evaluate('document.activeElement?.tagName'), focusWithinDialog:await evaluate('document.querySelector("[role=dialog]")?.contains(document.activeElement)') });
            evidence.push({ screen:name, width, dialogOpen: await evaluate('!!document.querySelector("[role=dialog]")') });
            await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
            await new Promise(resolve => setTimeout(resolve, 100));
            if (await evaluate('!!document.querySelector("[role=dialog]")')) throw new Error('Escape did not close '+name);
          }
        }
        await writeFile(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));
      }
    }
    await writeFile(`${output}/evidence.json`, JSON.stringify(evidence, null, 2));
    console.info('Toruni visual captures:', output, JSON.stringify(evidence));
  } finally { socket?.close(); chrome.kill(); }
}
