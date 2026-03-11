const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  
  // Monitor network
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('apify') && (url.includes('sign') || url.includes('auth') || url.includes('register') || url.includes('user'))) {
      console.log(`[NET] ${resp.status()} ${resp.request().method()} ${url}`);
      if (resp.status() >= 400) {
        try {
          const body = await resp.text();
          console.log('  Response:', body.substring(0, 300));
        } catch(e) {}
      }
    }
  });
  
  page.on('requestfailed', (req) => {
    console.log('[FAIL]', req.url(), req.failure()?.errorText);
  });
  
  await page.goto('https://console.apify.com/sign-up', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  
  // Fill email
  await page.locator('input[type="email"]').fill('1937590944@qq.com');
  await page.locator('button:has-text("Next")').click();
  await page.waitForTimeout(2000);
  
  // Fill password
  await page.locator('input[type="password"]').fill('ApiFy2026!xPzz#8');
  await page.waitForTimeout(1000);
  
  // Click Sign up
  await page.locator('button:has-text("Sign up")').click();
  console.log('Clicked Sign up');
  
  // Wait and watch network
  await page.waitForTimeout(15000);
  
  console.log('\nFinal URL:', page.url());
  const body = await page.locator('body').textContent();
  console.log('Final body (500):', body.substring(0, 500));
  
  await browser.close();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
