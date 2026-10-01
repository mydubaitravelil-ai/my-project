import { test } from '../../lib/fixtures';
import { absolute } from '../../lib/site';

const VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];

test.setTimeout(5 * 60_000);

test('responsive layout on mobile / tablet / desktop', async ({ page, site, findings, log }, testInfo) => {
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
        log.metric(`overflowPx.${vp.name}`, Math.max(0, r.overflow), { unit: 'px', url });
        if (r.overflow > 2) findings.add(vp.name === 'mobile' ? 'medium' : 'low', `Horizontal scroll on ${vp.name} (${r.overflow}px wider than screen)`, {
          url, detail: r.culprits.join('\n'), key: `overflow|${vp.name}|${url}`, fix: 'Find the element with fixed width; use max-width:100% / flex-wrap / overflow-wrap.',
        });
        if (vp.name === 'mobile' && r.tiny > 5) findings.low(`${r.tiny} text elements under 12px on mobile`, { url });
        if (vp.name === 'mobile' && r.smallTargets > 5) findings.low(`${r.smallTargets} tap targets smaller than 24px on mobile`, { url });
        const shot = await page.screenshot({ fullPage: true, timeout: 30_000 }).catch(() => null);
        if (shot) {
          const name = `${vp.name}-${p.replace(/\W+/g, '_').replace(/^_+|_+$/g, '') || 'home'}.png`;
          await testInfo.attach(name, { body: shot, contentType: 'image/png' });
          log.saveArtifact('screenshot', `${site.name}/${name}`, shot, { label: `${vp.name} ${vp.width}×${vp.height}`, url });
        }
      });
    }
  }
});
