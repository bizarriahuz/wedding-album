// Made of Memories site motion (GSAP). One opening moment per page, flowers laid down like pressed flowers,
// a few small scroll moments, smooth FAQ answers and a gentle tilt on desktop.
// Nothing ever waits on an animation, and reduced-motion visitors get none.
(() => {
  const html = document.documentElement;
  const finish = () => html.classList.remove('motion');
  if (!window.gsap || matchMedia('(prefers-reduced-motion: reduce)').matches) return finish();
  if (window.SplitText) gsap.registerPlugin(SplitText);
  // play something once, the first time it comes into view (the browser's own observer: light and always up to date)
  const onView = (els, play, margin = '0px') => {
    const io = new IntersectionObserver((entries) => {
      const seen = entries.filter((e) => e.isIntersecting).map((e) => e.target);
      seen.forEach((el) => io.unobserve(el));
      if (seen.length) play(seen);
    }, { rootMargin: margin });
    (typeof els === 'string' ? document.querySelectorAll(els) : els).forEach((el) => io.observe(el));
  };
  html.classList.add('gsap-on');
  const rnd = gsap.utils.random;
  const EASE = 'power3.out';

  // 1. Opening: the lace mark settles, the page title writes itself in, the intro follows
  const tl = gsap.timeline({ defaults: { ease: EASE }, onComplete: () => tl.kill() });
  const mark = document.querySelector('.top .brand');
  const title = document.querySelector('.hero h1, .sec-title h1');
  const after = document.querySelectorAll('.hero .lede, .hero .italic-line, .hero .pill, .hero .btn, .sec-title .sub-caps');
  if (mark) tl.from(mark, { autoAlpha: 0, y: -10, scale: .97, duration: .7 }, 0);
  const start = () => {
    if (title && window.SplitText) {
      const split = SplitText.create(title, { type: 'words,chars', aria: 'auto' });
      tl.from(split.chars, { autoAlpha: 0, yPercent: 55, rotate: 4, duration: .7, stagger: .035 }, .15);
    } else if (title) tl.from(title, { autoAlpha: 0, y: 16, duration: .7 }, .15);
    if (after.length) tl.from(after, { autoAlpha: 0, y: 10, duration: .6, stagger: .08 }, '-=.35');
    finish();
  };
  // wait for the fonts (max 1 s) so letters are split in their final shapes
  Promise.race([document.fonts ? document.fonts.ready : Promise.resolve(), new Promise((r) => setTimeout(r, 1000))]).then(start);

  // 2. Pressed flowers: each one floats down, turns and settles into its place
  const lay = (els) => gsap.fromTo(els,
    { '--in-y': () => `${rnd(-70, -36)}px`, '--in-r': () => `${rnd(-26, 26)}deg`, '--in-s': 1.08, autoAlpha: 0 },
    { '--in-y': '0px', '--in-r': '0deg', '--in-s': 1, autoAlpha: 1, duration: () => rnd(.8, 1.2), ease: 'power2.out', stagger: .07, overwrite: true });
  gsap.set('.st:not(.st-x), .phones .phone', { autoAlpha: 0 }); // hidden until they're reached, so nothing flashes first
  onView('.st:not(.st-x)', lay);
  // the margin flowers are added after the page loads; pick them up too
  addEventListener('load', () => setTimeout(() => { gsap.set('.st-x', { autoAlpha: 0 }); onView('.st-x', lay); }, 60));

  // 3. Packages come to rest one after another; the Signature card's tape presses on last
  const plans = document.querySelectorAll('.plan');
  if (plans.length) {
    gsap.set(plans, { autoAlpha: 0, y: 34 });
    onView(plans, (els) => gsap.to(els, { autoAlpha: 1, y: 0, duration: .9, ease: EASE, stagger: .14, delay: tl.isActive() ? .35 : 0,
      onComplete: () => gsap.set(els, { clearProps: 'transform' }) }), '0px 0px -40px 0px');
    const featured = document.querySelector('.plan.featured');
    if (featured) {
      gsap.set(featured, { '--tape-s': 1.5, '--tape-o': 0 });
      onView([featured], () => gsap.to(featured, { '--tape-s': 1, '--tape-o': 1, duration: .55, delay: 1, ease: 'back.out(2.2)' }), '0px 0px -20% 0px');
    }
  }
  // Experience: the phone screenshots slide up as you reach them
  onView('.phones .phone', (els) => gsap.fromTo(els, { autoAlpha: 0, y: 60 }, { autoAlpha: 1, y: 0, duration: 1, ease: EASE, stagger: .15, clearProps: 'transform' }), '0px 0px -10% 0px');

  // 4. FAQ answers open and close smoothly
  document.querySelectorAll('.faq details').forEach((d) => {
    const s = d.querySelector('summary'), p = d.querySelector('summary ~ *');
    if (!s || !p) return;
    s.addEventListener('click', (e) => {
      e.preventDefault();
      gsap.killTweensOf(p);
      if (!d.open) {
        d.open = true;
        gsap.fromTo(p, { height: 0, autoAlpha: 0, overflow: 'hidden' }, { height: 'auto', autoAlpha: 1, duration: .45, ease: 'power2.out', clearProps: 'height,overflow' });
      } else {
        gsap.to(p, { height: 0, autoAlpha: 0, overflow: 'hidden', duration: .32, ease: 'power2.in',
          onComplete: () => { d.open = false; gsap.set(p, { clearProps: 'height,overflow,opacity,visibility' }); } });
      }
    });
  });

  // 5. Desktop only: package cards lift and tilt a little toward the mouse
  if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
    plans.forEach((card) => {
      const rx = gsap.quickTo(card, 'rotationX', { duration: .5, ease: 'power3' });
      const ry = gsap.quickTo(card, 'rotationY', { duration: .5, ease: 'power3' });
      const ty = gsap.quickTo(card, 'y', { duration: .5, ease: 'power3' });
      gsap.set(card, { transformPerspective: 900 });
      card.addEventListener('pointermove', (e) => {
        const r = card.getBoundingClientRect();
        ry(((e.clientX - r.left) / r.width - .5) * 6);
        rx(-((e.clientY - r.top) / r.height - .5) * 6);
        ty(-5);
      });
      card.addEventListener('pointerleave', () => { rx(0); ry(0); ty(0); });
    });
  }
})();
