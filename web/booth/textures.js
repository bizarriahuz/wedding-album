// Everything drawn on a 2D canvas and used as a texture: the lit sign, the plate, the monogram panel,
// the photo strip itself, plus soft glow / shadow sprites.
import { CanvasTexture, SRGBColorSpace, LinearFilter, LinearMipmapLinearFilter } from 'three';

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function tex(c, aniso = 4) {
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace; t.anisotropy = aniso;
  t.minFilter = LinearMipmapLinearFilter; t.magFilter = LinearFilter; t.generateMipmaps = true;
  return t;
}
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
// shrink the font until the text fits
function fit(ctx, text, font, size, maxW, min = 10) {
  let s = size;
  do { ctx.font = font.replace('%', s); if (ctx.measureText(text).width <= maxW) break; s -= 2; } while (s > min);
  return s;
}

export function signTexture(P, F) {
  const c = canvas(1024, 232), x = c.getContext('2d');
  rr(x, 0, 0, 1024, 232, 60); x.fillStyle = P.signFace; x.fill();
  const g = x.createRadialGradient(512, 116, 20, 512, 116, 560);
  g.addColorStop(0, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,214,150,.28)');
  x.fillStyle = g; x.fill();
  rr(x, 14, 14, 996, 204, 48); x.lineWidth = 4; x.strokeStyle = P.signInk; x.globalAlpha = .55; x.stroke(); x.globalAlpha = 1;
  x.fillStyle = P.signInk; x.textAlign = 'center'; x.textBaseline = 'middle';
  fit(x, 'photo booth', `italic 400 %px ${F.serif}`, 150, 800);
  x.fillText('photo booth', 512, 112);
  return tex(c, 8);
}

export function plateTexture(P, F) {
  const c = canvas(512, 128), x = c.getContext('2d');
  rr(x, 0, 0, 512, 128, 22); x.fillStyle = P.signFace; x.fill();
  rr(x, 8, 8, 496, 112, 16); x.lineWidth = 3; x.strokeStyle = P.signInk; x.globalAlpha = .5; x.stroke(); x.globalAlpha = 1;
  x.fillStyle = P.signInk; x.textAlign = 'center'; x.textBaseline = 'middle';
  fit(x, 'press to start', `italic 400 %px ${F.serif}`, 72, 430);
  x.fillText('press to start', 256, 60);
  return tex(c, 8);
}

// Side panel: the couple's initials in the names script, inside a fine double oval
export function monogramTexture(P, F, initials, dateText) {
  const c = canvas(512, 928), x = c.getContext('2d');
  rr(x, 0, 0, 512, 928, 26); x.fillStyle = P.trim; x.fill();
  x.strokeStyle = P.gold; x.lineWidth = 5; rr(x, 22, 22, 468, 884, 14); x.stroke();
  x.lineWidth = 2; rr(x, 36, 36, 440, 856, 8); x.stroke();
  x.beginPath(); x.ellipse(256, 420, 168, 214, 0, 0, Math.PI * 2); x.lineWidth = 4; x.stroke();
  x.beginPath(); x.ellipse(256, 420, 154, 200, 0, 0, Math.PI * 2); x.lineWidth = 1.5; x.stroke();
  x.fillStyle = P.gold; x.textAlign = 'center'; x.textBaseline = 'middle';
  const mono = initials.length === 2 ? `${initials[0]} & ${initials[1]}` : (initials[0] || '');
  fit(x, mono, `italic 400 %px ${F.serif}`, 150, 250);
  x.fillText(mono, 256, 424);
  x.font = `500 30px ${F.caps}`;
  try { x.letterSpacing = '6px'; } catch {}
  x.fillText(dateText, 256, 742);
  return tex(c, 8);
}

// Soft round glow for the bulbs
export function glowTexture() {
  const c = canvas(128, 128), x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,244,214,1)'); g.addColorStop(.18, 'rgba(255,214,140,.75)');
  g.addColorStop(.45, 'rgba(255,170,80,.22)'); g.addColorStop(1, 'rgba(255,150,60,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const t = tex(c, 1); t.generateMipmaps = false; t.minFilter = LinearFilter; return t;
}

// Soft dark blob: contact shadow under the booth, and the drop shadow behind the floating strip
export function blobTexture(color, squareness = 0) {
  const c = canvas(256, 256), x = c.getContext('2d');
  if (squareness) {
    x.filter = 'blur(22px)'; x.fillStyle = color; rr(x, 52, 52, 152, 152, 10); x.fill();
  } else {
    const g = x.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, color); g.addColorStop(.55, color + '66'); g.addColorStop(1, color + '00');
    x.fillStyle = g; x.fillRect(0, 0, 256, 256);
  }
  const t = tex(c, 1); return t;
}

// Soft darkening towards the top and the corners of the booth's inside walls
export function wallTexture() {
  const c = canvas(128, 256), x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#6f6f6f'); g.addColorStop(.22, '#c9c9c9'); g.addColorStop(.6, '#ffffff'); g.addColorStop(1, '#bdbdbd');
  x.fillStyle = g; x.fillRect(0, 0, 128, 256);
  const h = x.createLinearGradient(0, 0, 128, 0);
  h.addColorStop(0, 'rgba(0,0,0,.28)'); h.addColorStop(.25, 'rgba(0,0,0,0)'); h.addColorStop(.75, 'rgba(0,0,0,0)'); h.addColorStop(1, 'rgba(0,0,0,.28)');
  x.fillStyle = h; x.fillRect(0, 0, 128, 256);
  return tex(c, 1);
}

// Light spilling out of the booth onto the floor when the flash fires
export function spillTexture() {
  const c = canvas(256, 256), x = c.getContext('2d');
  const g = x.createRadialGradient(128, 0, 0, 128, 0, 127);
  g.addColorStop(0, 'rgba(255,246,224,1)'); g.addColorStop(.45, 'rgba(255,226,180,.38)'); g.addColorStop(1, 'rgba(255,220,170,0)');
  x.fillStyle = g; x.fillRect(0, 0, 256, 256);
  const t = tex(c, 1); return t;
}

/* The photo strip. Layout is worked out first (so the 3D strip has the right shape straight away);
   photos are painted in as they arrive.
   Returns { texture, W, L, cells: [[u0,v0,u1,v1]...], paint(images) } with sizes in metres. */
export function stripTexture(P, F, { count, portrait, names, dateText, initials }) {
  const PX = 2000;                       // canvas pixels per metre
  const W = 0.26, pad = 0.015, gap = 0.012, foot = 0.108;
  const cw = W - pad * 2, ch = portrait ? cw * (118 / 88) : cw * (56 / 78);
  const n = Math.max(1, count);
  const L = pad + n * ch + (n - 1) * gap + foot;
  const c = canvas(Math.round(W * PX), Math.round(L * PX)), x = c.getContext('2d');
  const cells = [];
  for (let i = 0; i < n; i++) {
    const y = pad + i * (ch + gap);
    cells.push({ x: pad * PX, y: y * PX, w: cw * PX, h: ch * PX });
  }
  const texture = tex(c, 8);
  function paint(images) {
    x.fillStyle = P.paper; x.fillRect(0, 0, c.width, c.height);
    cells.forEach((r, i) => {
      const im = images && images[i];
      if (im && im.width) {
        const s = Math.max(r.w / im.width, r.h / im.height), sw = r.w / s, sh = r.h / s;
        x.drawImage(im, (im.width - sw) / 2, (im.height - sh) / 2, sw, sh, r.x, r.y, r.w, r.h);
      } else {
        const g = x.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
        g.addColorStop(0, P.curtain); g.addColorStop(1, P.trim);
        x.fillStyle = g; x.fillRect(r.x, r.y, r.w, r.h);
        if (!images || !images.length) {   // no photos at all: the couple's initials
          x.fillStyle = P.gold; x.textAlign = 'center'; x.textBaseline = 'middle';
          const mono = initials.length === 2 ? `${initials[0]} & ${initials[1]}` : (initials[0] || '');
          fit(x, mono, `400 %px ${F.script}`, r.h * .5, r.w * .7);
          x.fillText(mono, r.x + r.w / 2, r.y + r.h / 2);
        }
      }
      // a hair of inner shadow so each print sits in the paper
      x.strokeStyle = 'rgba(40,20,20,.18)'; x.lineWidth = 2; x.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    });
    // footer: names in the album's script, the date beneath
    const fy = (L - foot) * PX, fh = foot * PX, cx = c.width / 2;
    x.fillStyle = P.stripInk; x.textAlign = 'center'; x.textBaseline = 'middle';
    fit(x, names, `400 %px ${F.script}`, 84, c.width - 56, 30);
    x.fillText(names, cx, fy + fh * .40);
    x.fillStyle = P.stripSoft; x.font = `500 22px ${F.caps}`;
    try { x.letterSpacing = '5px'; } catch {}
    x.fillText(dateText, cx + 2, fy + fh * .80);
    try { x.letterSpacing = '0px'; } catch {}
    texture.needsUpdate = true;
  }
  paint(null);
  return {
    texture, W, L, paint,
    // cell rectangles in texture coordinates (v runs bottom to top)
    cells: cells.map((r) => [r.x / c.width, 1 - (r.y + r.h) / c.height, (r.x + r.w) / c.width, 1 - r.y / c.height]),
  };
}
