'use strict';
/**
 * ╔══════════════════════════════════════════════════════╗
 * ║  STARTUP SURVIVOR — Interactive Effects Engine v2.0  ║
 * ║  Cursor · Trail · Magnetic · Tilt · Reveal           ║
 * ║  Parallax · Count-up · Ripple · Grid Glow · Glitch   ║
 * ╚══════════════════════════════════════════════════════╝
 */
const Effects = (() => {

  /* ─────────────────────────────────────────────
     STATE
  ───────────────────────────────────────────── */
  let mouseX = window.innerWidth / 2;
  let mouseY = window.innerHeight / 2;
  let cursorX = mouseX;
  let cursorY = mouseY;
  let ringX   = mouseX;
  let ringY   = mouseY;
  let scrollY = 0;
  let ticking = false;
  const TRAIL_COUNT = 14;
  const trailDots   = [];
  const trailPos    = Array.from({ length: TRAIL_COUNT }, () => ({ x: mouseX, y: mouseY }));
  let cursor, ring;
  let isDesktop = window.matchMedia('(pointer:fine)').matches;

  /* ─────────────────────────────────────────────
     1. CUSTOM CURSOR + RING
  ───────────────────────────────────────────── */
  function initCursor() {
    if (!isDesktop) return;
    document.documentElement.style.cursor = 'none';

    cursor = document.createElement('div');
    cursor.id = 'ss-cursor';
    document.body.appendChild(cursor);

    ring = document.createElement('div');
    ring.id = 'ss-cursor-ring';
    document.body.appendChild(ring);

    // Progress bar
    const bar = document.createElement('div');
    bar.id = 'scroll-progress';
    document.body.appendChild(bar);

    // Pointer tracking
    document.addEventListener('mousemove', e => { mouseX = e.clientX; mouseY = e.clientY; }, { passive: true });
    document.addEventListener('mouseleave', () => {
      cursor.style.opacity = '0';
      ring.style.opacity   = '0';
    });
    document.addEventListener('mouseenter', () => {
      cursor.style.opacity = '1';
      ring.style.opacity   = '1';
    });

    // Click pulse
    document.addEventListener('mousedown', () => document.body.classList.add('cursor-click'));
    document.addEventListener('mouseup',   () => document.body.classList.remove('cursor-click'));

    // Contextual states
    const hoverSelectors = 'a, button, [role="button"], label, select, .bmc-cell, .sf-btn, .sp-card, .roe-card, .shock-card-admin';
    const textSelectors  = 'input, textarea';
    const dangerSelectors = '.btn-danger, .btn-arena-judge, #resetGame';

    document.addEventListener('mouseover', e => {
      const t = e.target.closest(dangerSelectors);
      const h = e.target.closest(hoverSelectors);
      const tx = e.target.closest(textSelectors);
      document.body.classList.toggle('cursor-danger', !!t);
      document.body.classList.toggle('cursor-hover',  !t && !!h);
      document.body.classList.toggle('cursor-text',   !!tx);
    });
    document.addEventListener('mouseout', () => {
      document.body.classList.remove('cursor-hover','cursor-danger','cursor-text');
    });

    animateCursor();
  }

  function animateCursor() {
    // Smooth cursor lerp
    cursorX += (mouseX - cursorX) * 0.75;
    cursorY += (mouseY - cursorY) * 0.75;
    ringX   += (mouseX - ringX)   * 0.18;
    ringY   += (mouseY - ringY)   * 0.18;

    if (cursor) {
      cursor.style.left = cursorX + 'px';
      cursor.style.top  = cursorY + 'px';
    }
    if (ring) {
      ring.style.left = ringX + 'px';
      ring.style.top  = ringY + 'px';
    }

    animateTrail();
    requestAnimationFrame(animateCursor);
  }

  /* ─────────────────────────────────────────────
     2. MULTI-LAYER CURSOR TRAIL (Physics)
  ───────────────────────────────────────────── */
  function initTrail() {
    if (!isDesktop) return;

    for (let i = 0; i < TRAIL_COUNT; i++) {
      const dot = document.createElement('div');
      dot.className = 'cursor-trail-dot';
      const alpha = 1 - (i / TRAIL_COUNT);
      const size  = Math.max(2, 7 - i * 0.4);
      dot.style.cssText = `
        position:fixed; border-radius:50%; pointer-events:none;
        z-index:99996; transform:translate(-50%,-50%);
        width:${size}px; height:${size}px;
        background:${i < 4 ? 'rgba(0,245,255,' + (alpha * 0.7) + ')' : 'rgba(124,58,237,' + (alpha * 0.5) + ')'};
        box-shadow: 0 0 ${size * 2}px ${i < 4 ? 'rgba(0,245,255,0.4)' : 'rgba(124,58,237,0.3)'};
        transition: width 0.2s, height 0.2s;
        mix-blend-mode: screen;
      `;
      document.body.appendChild(dot);
      trailDots.push(dot);
    }
  }

  function animateTrail() {
    // Physics chain — each dot follows previous with damping
    trailPos[0].x += (mouseX - trailPos[0].x) * 0.5;
    trailPos[0].y += (mouseY - trailPos[0].y) * 0.5;
    for (let i = 1; i < TRAIL_COUNT; i++) {
      trailPos[i].x += (trailPos[i-1].x - trailPos[i].x) * 0.4;
      trailPos[i].y += (trailPos[i-1].y - trailPos[i].y) * 0.4;
    }
    trailDots.forEach((dot, i) => {
      dot.style.left = trailPos[i].x + 'px';
      dot.style.top  = trailPos[i].y + 'px';
    });
  }

  /* ─────────────────────────────────────────────
     3. MAGNETIC BUTTONS
  ───────────────────────────────────────────── */
  function initMagnetic() {
    if (!isDesktop) return;
    document.querySelectorAll('.mag-btn, .btn-arena, .btn-primary, .btn-danger').forEach(btn => {
      btn.addEventListener('mousemove', e => {
        const rect   = btn.getBoundingClientRect();
        const cx     = rect.left + rect.width / 2;
        const cy     = rect.top  + rect.height / 2;
        const dx     = e.clientX - cx;
        const dy     = e.clientY - cy;
        const dist   = Math.hypot(dx, dy);
        const maxDist = Math.max(rect.width, rect.height) * 0.75;
        if (dist < maxDist) {
          const strength = (1 - dist / maxDist) * 12;
          btn.style.transform = `translate(${dx * strength / maxDist}px, ${dy * strength / maxDist}px)`;
          btn.style.transition = 'transform 0.15s ease';
        }
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.transform  = '';
        btn.style.transition = 'transform 0.5s cubic-bezier(0.34,1.56,0.64,1)';
      });
    });
  }

  /* ─────────────────────────────────────────────
     4. 3D CARD TILT + SHINE
  ───────────────────────────────────────────── */
  function initTilt() {
    if (!isDesktop) return;
    document.querySelectorAll('.roe-card, .sp-card, .shock-card-admin, .metric-card, .tilt').forEach(card => {
      let shine = card.querySelector('.card-shine');
      if (!shine) {
        shine = document.createElement('div');
        shine.className = 'card-shine';
        shine.style.cssText = `
          position:absolute; inset:0; border-radius:inherit;
          background:radial-gradient(circle at 50% 50%, rgba(255,255,255,0.07), transparent 70%);
          opacity:0; pointer-events:none; transition:opacity 0.3s ease;
        `;
        if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
        card.appendChild(shine);
      }

      card.addEventListener('mousemove', e => {
        const rect = card.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width;
        const y = (e.clientY - rect.top)  / rect.height;
        const rx = (y - 0.5) * -14;
        const ry = (x - 0.5) *  14;
        card.style.transform = `perspective(700px) rotateX(${rx}deg) rotateY(${ry}deg) scale(1.02)`;
        card.style.transition = 'transform 0.12s ease';
        shine.style.background = `radial-gradient(circle at ${x*100}% ${y*100}%, rgba(255,255,255,0.1), transparent 65%)`;
        shine.style.opacity = '1';
      });

      card.addEventListener('mouseleave', () => {
        card.style.transform  = '';
        card.style.transition = 'transform 0.5s cubic-bezier(0.34,1.56,0.64,1)';
        shine.style.opacity   = '0';
      });
    });
  }

  /* ─────────────────────────────────────────────
     5. SCROLL REVEAL (IntersectionObserver)
  ───────────────────────────────────────────── */
  function initReveal() {
    const obs = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          // Staggered children
          entry.target.querySelectorAll('[data-delay]').forEach(child => {
            child.style.transitionDelay = child.dataset.delay + 'ms';
          });
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

    document.querySelectorAll('.reveal, .reveal-stagger').forEach(el => obs.observe(el));
  }

  /* ─────────────────────────────────────────────
     6. SCROLL PROGRESS BAR
  ───────────────────────────────────────────── */
  function initScrollProgress() {
    const bar = document.getElementById('scroll-progress');
    if (!bar) return;
    window.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          scrollY = window.scrollY;
          const max = document.documentElement.scrollHeight - window.innerHeight;
          bar.style.width = max > 0 ? (scrollY / max * 100) + '%' : '0%';
          ticking = false;
        });
        ticking = true;
      }
    }, { passive: true });
  }

  /* ─────────────────────────────────────────────
     7. PARALLAX
  ───────────────────────────────────────────── */
  function initParallax() {
    const layers = document.querySelectorAll('[data-parallax]');
    if (!layers.length) return;
    window.addEventListener('scroll', () => {
      requestAnimationFrame(() => {
        const sy = window.scrollY;
        layers.forEach(el => {
          const speed = parseFloat(el.dataset.parallax) || 0.3;
          el.style.transform = `translateY(${sy * speed}px)`;
        });
      });
    }, { passive: true });

    // Mouse parallax for hero elements
    document.addEventListener('mousemove', e => {
      const mx = (e.clientX / window.innerWidth  - 0.5) * 2;
      const my = (e.clientY / window.innerHeight - 0.5) * 2;
      document.querySelectorAll('[data-mouse-parallax]').forEach(el => {
        const depth = parseFloat(el.dataset.mouseParallax) || 10;
        el.style.transform = `translate(${mx * depth}px, ${my * depth}px)`;
        el.style.transition = 'transform 0.4s ease-out';
      });
    });
  }

  /* ─────────────────────────────────────────────
     8. COUNT-UP ANIMATION
  ───────────────────────────────────────────── */
  function initCountUp() {
    const obs = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          animateNumber(entry.target);
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.3 });

    document.querySelectorAll('[data-count]').forEach(el => obs.observe(el));
  }

  function animateNumber(el) {
    const target = parseFloat(el.dataset.count) || 0;
    const prefix = el.dataset.prefix || '';
    const suffix = el.dataset.suffix || '';
    const duration = parseInt(el.dataset.duration) || 1500;
    const start = performance.now();

    const tick = now => {
      const elapsed  = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const ease     = 1 - Math.pow(1 - progress, 3); // cubic ease-out
      const value    = Math.round(ease * target);
      el.textContent = prefix + value.toLocaleString('en-IN') + suffix;
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ─────────────────────────────────────────────
     9. RIPPLE ON CLICK
  ───────────────────────────────────────────── */
  function initRipple() {
    document.addEventListener('click', e => {
      const target = e.target.closest('button, .btn, [role="button"]');
      if (!target) return;
      const rect   = target.getBoundingClientRect();
      const size   = Math.max(rect.width, rect.height) * 2;
      const ripple = document.createElement('span');
      ripple.className = 'ripple-effect';
      ripple.style.cssText = `
        position:absolute;
        width:${size}px; height:${size}px;
        left:${e.clientX - rect.left - size/2}px;
        top:${e.clientY - rect.top  - size/2}px;
        border-radius:50%;
        background:rgba(255,255,255,0.18);
        transform:scale(0);
        animation: rippleAnim 0.7s linear forwards;
        pointer-events:none;
      `;
      if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
      target.style.overflow = 'hidden';
      target.appendChild(ripple);
      ripple.addEventListener('animationend', () => ripple.remove());
    });
  }

  /* ─────────────────────────────────────────────
     10. REACTIVE BACKGROUND GRID GLOW
  ───────────────────────────────────────────── */
  function initGridGlow() {
    if (!isDesktop) return;
    const grid = document.querySelector('.bg-grid');
    if (!grid) return;
    document.addEventListener('mousemove', e => {
      const x = (e.clientX / window.innerWidth  * 100).toFixed(1);
      const y = (e.clientY / window.innerHeight * 100).toFixed(1);
      grid.style.backgroundImage = `
        radial-gradient(circle 250px at ${x}% ${y}%, rgba(0,245,255,0.06) 0%, transparent 100%),
        linear-gradient(rgba(0,245,255,0.04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0,245,255,0.04) 1px, transparent 1px)
      `;
    }, { passive: true });
  }

  /* ─────────────────────────────────────────────
     11. SPORADIC GLITCH ON HEADINGS
  ───────────────────────────────────────────── */
  function initGlitch() {
    const targets = document.querySelectorAll('[data-glitch]');
    targets.forEach(el => {
      const original = el.textContent;
      const chars    = '!<>-_\\/[]{}—=+*^?#X0123456789';
      let   glitching = false;

      const trigger = () => {
        if (glitching) return;
        glitching = true;
        let count = 0;
        const max = 12;
        const tick = () => {
          el.textContent = original.split('').map((ch, i) =>
            Math.random() < 0.15 ? chars[Math.floor(Math.random() * chars.length)] : ch
          ).join('');
          if (++count < max) setTimeout(tick, 50);
          else { el.textContent = original; glitching = false; }
        };
        tick();
      };

      // Auto trigger
      setInterval(trigger, 6000 + Math.random() * 8000);
      // On hover
      el.addEventListener('mouseenter', trigger);
    });
  }

  /* ─────────────────────────────────────────────
     12. HOVER GLOW PROXIMITY (buttons near cursor)
  ───────────────────────────────────────────── */
  function initProximityGlow() {
    if (!isDesktop) return;
    const cards = document.querySelectorAll('.metric-card, .sp-card, .roe-card');
    document.addEventListener('mousemove', e => {
      cards.forEach(card => {
        const rect = card.getBoundingClientRect();
        const cx = rect.left + rect.width  / 2;
        const cy = rect.top  + rect.height / 2;
        const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
        const radius = 200;
        if (dist < radius) {
          const intensity = (1 - dist / radius) * 0.3;
          const x = ((e.clientX - rect.left) / rect.width  * 100).toFixed(1);
          const y = ((e.clientY - rect.top)  / rect.height * 100).toFixed(1);
          card.style.setProperty('--glow-x', x + '%');
          card.style.setProperty('--glow-y', y + '%');
          card.style.setProperty('--glow-i', intensity);
          card.style.boxShadow = `inset 0 0 30px rgba(0,245,255,${intensity * 0.3}), 0 0 20px rgba(0,245,255,${intensity * 0.15})`;
        } else {
          card.style.boxShadow = '';
        }
      });
    }, { passive: true });
  }

  /* ─────────────────────────────────────────────
     13. ANIMATED NUMBER TICKER (live stats)
  ───────────────────────────────────────────── */
  function initLiveTicker(el, getValue, interval = 2000) {
    if (!el) return;
    let prev = null;
    const update = () => {
      const v = getValue();
      if (v !== prev) {
        el.style.transform = 'translateY(-4px)';
        el.style.opacity   = '0.5';
        setTimeout(() => {
          el.textContent    = v;
          el.style.transform = 'translateY(0)';
          el.style.opacity   = '1';
          el.style.transition = 'all 0.3s cubic-bezier(0.34,1.56,0.64,1)';
        }, 180);
        prev = v;
      }
    };
    update();
    return setInterval(update, interval);
  }

  /* ─────────────────────────────────────────────
     14. SCROLL-TRIGGERED LINE DRAW (SVG paths)
  ───────────────────────────────────────────── */
  function initLineDraw() {
    const obs = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.querySelectorAll('path, line, polyline, circle, rect').forEach(path => {
            const len = path.getTotalLength?.() || 200;
            path.style.strokeDasharray  = len;
            path.style.strokeDashoffset = len;
            path.style.transition = 'stroke-dashoffset 1.2s cubic-bezier(0.4,0,0.2,1)';
            requestAnimationFrame(() => { path.style.strokeDashoffset = '0'; });
          });
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.3 });
    document.querySelectorAll('.draw-svg').forEach(el => obs.observe(el));
  }

  /* ─────────────────────────────────────────────
     PUBLIC INIT
  ───────────────────────────────────────────── */
  function init() {
    initCursor();
    initTrail();
    initMagnetic();
    initReveal();
    initScrollProgress();
    initParallax();
    initCountUp();
    initRipple();
    initGridGlow();
    initGlitch();
    initProximityGlow();
    initLineDraw();

    // Re-run tilt whenever new cards are added to DOM
    const tiltObs = new MutationObserver(() => initTilt());
    tiltObs.observe(document.body, { childList: true, subtree: true });
    initTilt();
  }

  return { init, initLiveTicker, animateNumber };
})();

/* Auto-init on DOMContentLoaded */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', Effects.init);
} else {
  Effects.init();
}
