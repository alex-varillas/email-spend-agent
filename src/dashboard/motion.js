// Mejora visual opcional: el HTML siempre parte de su estado legible y final.
// Cada contexto se restaura al terminar, cancelar o cambiar a movimiento reducido.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const running = new Map();
const pending = new Map();
const dataRegions = ['kpis', 'monthly-chart', 'breakdown-body'];
let observer;

function canAnimate() {
  return Boolean(window.gsap) && !reducedMotion.matches && !document.hidden;
}

function inView(element) {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && box.top < window.innerHeight && box.bottom > 0;
}

export function cancelMotion(element) {
  pending.delete(element);
  observer?.unobserve(element);
  running.get(element)?.revert();
  running.delete(element);
}

export function cancelDataMotion() {
  dataRegions.forEach((id) => cancelMotion(document.getElementById(id)));
}

function finishAll() {
  for (const element of new Set([...running.keys(), ...pending.keys()])) cancelMotion(element);
}

function play(element, build) {
  if (!canAnimate() || !element.isConnected) return;
  cancelMotion(element);
  let timeline;
  const context = window.gsap.context(() => {
    timeline = window.gsap.timeline({ paused: true, defaults: { ease: 'power3.out' } });
    build(timeline);
  }, element);
  running.set(element, context);
  timeline.eventCallback('onComplete', () => {
    if (running.get(element) === context) cancelMotion(element);
  });
  timeline.play(0);
}

function reveal(element, build) {
  cancelMotion(element);
  if (!canAnimate()) return;
  if (inView(element)) {
    play(element, build);
    return;
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const buildPending = pending.get(entry.target);
      if (entry.isIntersecting && buildPending) play(entry.target, buildPending);
    }
  }, { threshold: 0.12 });
  // No se oculta contenido mientras queda fuera de pantalla.
  pending.set(element, build);
  observer.observe(element);
}

export function initMotion() {
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) finishAll();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) finishAll();
  });
  window.addEventListener('pagehide', finishAll);

  const heading = document.querySelector('.overview-copy');
  reveal(heading, (timeline) => {
    timeline.fromTo(heading.children, { y: 8, opacity: 0.35 }, {
      y: 0, opacity: 1, duration: 0.45, stagger: 0.05,
    });
  });

  const art = document.querySelector('.overview-art');
  // El dibujo está oculto en móvil: no prepara ni reproduce una animación allí.
  if (!inView(art)) return;
  const routes = [...art.querySelectorAll('.agent-route')].map((path) => ({ path, length: path.getTotalLength() }));
  reveal(art, (timeline) => {
    timeline.fromTo('.agent-mail', { x: -4, opacity: 0.3 }, { x: 0, opacity: 1, duration: 0.3 }, 0);
    routes.forEach(({ path, length }, index) => {
      timeline.fromTo(path, { strokeDasharray: length, strokeDashoffset: length }, {
        strokeDashoffset: 0, duration: 0.35, ease: 'power2.out',
      }, 0.1 + index * 0.32);
    });
    timeline.fromTo('.agent-head', { y: 3, opacity: 0.45 }, { y: 0, opacity: 1, duration: 0.35 }, 0.2);
    timeline.to('.agent-eyes', { scaleY: 0.15, transformOrigin: '50% 50%', duration: 0.08 }, 0.48);
    timeline.to('.agent-eyes', { scaleY: 1, duration: 0.12 }, 0.56);
    timeline.fromTo('.agent-receipt', { y: 3, opacity: 0.25 }, { y: 0, opacity: 1, duration: 0.3 }, 0.65);
  });
}

export function animateData() {
  const kpis = document.getElementById('kpis');
  reveal(kpis, (timeline) => {
    // Los importes no se interpolan: mantienen su valor exacto durante la entrada.
    timeline.fromTo('.tile-value', { y: 6, opacity: 0.5 }, {
      y: 0, opacity: 1, duration: 0.28, stagger: 0.035,
    });
  });

  const chart = document.getElementById('monthly-chart');
  const stacks = [...chart.querySelectorAll('.bar-stack')].filter((group) => group.children.length);
  if (stacks.length) reveal(chart, (timeline) => {
    timeline.fromTo(stacks, { scaleY: 0, transformOrigin: '50% 100%' }, {
      scaleY: 1, duration: 0.48, stagger: { amount: 0.16 },
    });
  });

  const breakdown = document.getElementById('breakdown-body');
  if (breakdown.querySelector('.rank-fill')) reveal(breakdown, (timeline) => {
    timeline.fromTo('.rank-fill', { scaleX: 0, transformOrigin: '0% 50%' }, {
      scaleX: 1, duration: 0.4, stagger: { amount: 0.12 },
    });
  });
}
