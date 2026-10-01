import { test } from '../../lib/fixtures';
import { absolute } from '../../lib/site';

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];

test.setTimeout(5 * 60_000);

test('responsive layout on mobile / tablet / desktop', async ({ page, site, findings }, testInfo) => {
  for (const vp of VIEWPORTS) {
    await page.setViewportSize(vp);
    for (const p of site.criticalPaths) {
      const url = absolute(site, p);
      await test.step(`${vp.name} ${url}`, async () => {
        const res = await page.goto(url, { waitUntil: 'load', timeout: 45_000 }).catch(() => null);
        if (!res?.ok()) return;
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        const r = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const overflow = document.documentElement.scrollWidth - vw;
          const culprits = [...document.querySelectorAll<HTMLElement>('body *')]
            .filter((el) => el.getBoundingClientRect().right > vw + 2 && getComputedStyle(el).position !== 'fixed')
            .slice(0, 5)
            .map((el) => `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}>`);
          const tiny = [...document.querySelectorAll<HTMLElement>('p, li, a, span')]
            .filter((el) => el.offsetParent && el.innerText?.trim() && parseFloat(getComputedStyle(el).fontSize) < 12).length;
          const smallTargets = [...document.querySelectorAll<HTMLElement>('a, button, input, select')]
            .filter((el) => { const b = el.getBoundingClientRect(); return el.offsetParent && b.width > 0 && (b.width < 24 || b.height < 24); }).length;
          return { overflow, culprits, tiny, smallTargets };
        });
        if (r.overflow > 2) findings.add(vp.name === 'mobile' ? 'medium' : 'low', `Horizontal scroll on ${vp.name} (${r.overflow}px wider than screen)`, {
          url, detail: r.culprits.join('\n'), fix: 'Find the element with fixed width; use max-width:100% / flex-wrap / overflow-wrap.',
        });
        if (vp.name === 'mobile' && r.tiny > 5) findings.low(`${r.tiny} text elements under 12px on mobile`, { url });
        if (vp.name === 'mobile' && r.smallTargets > 5) findings.low(`${r.smallTargets} tap targets smaller than 24px on mobile`, { url });
        await testInfo.attach(`${vp.name}-${p.replace(/\W+/g, '_') || 'home'}.png`, {
          body: await page.screenshot({ fullPage: true, timeout: 30_000 }).catch(() => Buffer.alloc(0)),
          contentType: 'image/png',
        });
      });
    }
  }
});
