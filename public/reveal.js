// Album cards settle in softly as they scroll into view, like the website
(() => {
  if (!('IntersectionObserver' in window) || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const els = document.querySelectorAll('body.guest .panel.wish, body.guest .gallery-head, body.admin main .card, body.admin .wrap > section.card');
  if (!els.length) return;
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { rootMargin: '0px 0px -6% 0px' });
  els.forEach((el) => { el.classList.add('rv'); io.observe(el); });
  setTimeout(() => els.forEach((el) => el.classList.add('in')), 2500); // never leave anything hidden
})();
