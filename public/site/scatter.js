// Sections settle in softly as they come into view
(() => {
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const els = document.querySelectorAll('main .plan, main .feature-card, main .icon-row, main .phones, main .faq, main .sec-title');
  if (!els.length) return;
  document.documentElement.classList.add('js-reveal');
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { rootMargin: '0px 0px -8% 0px' });
  els.forEach((el, i) => { el.classList.add('reveal'); el.style.transitionDelay = el.classList.contains('plan') ? `${(i % 3) * 90}ms` : '0ms'; io.observe(el); });
  setTimeout(() => els.forEach((el) => el.classList.add('in')), 2500); // never leave anything hidden
})();
// Scrapbook scatter: every visit the pressed flowers land a little differently
(() => {
  const rnd = (a, b) => a + Math.random() * (b - a);
  const noFlip = /note|stamp|grid-paper|torn-sketch/;
  // 1. jitter the placed stickers: tilt, nudge, size, mirror
  document.querySelectorAll('.st').forEach((el) => {
    const small = matchMedia('(max-width: 760px)').matches;
    el.style.setProperty('--jr', `${rnd(-14, 14).toFixed(1)}deg`);
    el.style.setProperty('--dx', `${rnd(-1, 1) * (small ? 6 : 16)}px`);
    el.style.setProperty('--dy', `${rnd(-1, 1) * (small ? 6 : 14)}px`);
    el.style.setProperty('--s', rnd(0.88, 1.12).toFixed(2));
    if (!noFlip.test(el.src) && Math.random() < 0.4) el.style.setProperty('--fx', '-1');
  });
  // 2. extra flowers scattered down the side margins, where there's room beside the content
  const page = document.querySelector('.page');
  const main = document.querySelector('main');
  if (!page || !main) return;
  const pool = ['cosmos', 'daisy', 'babys-breath', 'hydrangea-pink', 'hydrangea-cream', 'cream-flower', 'fern', 'leaves', 'lavender', 'statice', 'rose', 'pansy', 'yellow-sprig'];
  function scatter() {
    page.querySelectorAll('.st-x').forEach((n) => n.remove());
    const vw = document.documentElement.clientWidth;
    const content = main.getBoundingClientRect();
    const gutter = content.left;                       // free space either side of the content
    if (gutter < 90) return;                           // phones and narrow windows: no room
    const top0 = main.offsetTop + 40, end = page.scrollHeight - 260;
    const bag = [...pool].sort(() => Math.random() - 0.5);
    let y = top0 + rnd(0, 160), side = Math.random() < 0.5 ? 'left' : 'right', i = 0;
    while (y < end) {
      const name = bag[i++ % bag.length];
      const w = Math.min(gutter - 14, rnd(86, 140));
      const img = new Image();
      img.className = 'st st-x';
      img.alt = ''; img.setAttribute('aria-hidden', 'true'); img.decoding = 'async';
      img.src = `/site/sb/${name}.webp`;
      img.style.width = `${w}px`;
      img.style.top = `${y}px`;
      img.style[side] = `${rnd(4, Math.max(6, gutter - w - 10))}px`;
      img.style.setProperty('--r', `${rnd(-24, 24).toFixed(1)}deg`);
      if (Math.random() < 0.5) img.style.setProperty('--fx', '-1');
      page.append(img);
      y += rnd(300, 520);
      if (Math.random() < 0.8) side = side === 'left' ? 'right' : 'left';
    }
  }
  addEventListener('load', scatter);
  let t; addEventListener('resize', () => { clearTimeout(t); t = setTimeout(scatter, 250); });
})();
