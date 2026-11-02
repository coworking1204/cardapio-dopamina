import {
  fetchMenu, formatPrice, slugify, h, BADGES,
  barNow, promotionStatus, promotionAppliesTo, formatCountdown, formatTime,
} from './shared.js?v=202611021720';

const els = {
  barName: document.getElementById('bar-name'),
  tagline: document.getElementById('tagline'),
  notice: document.getElementById('notice'),
  tabs: document.getElementById('tabs'),
  panel: document.getElementById('panel'),
  footer: document.getElementById('footer-text'),
  promos: document.getElementById('promo-banner'),
};

let sections = [];
let firstLoad = true;
let activeSlug = decodeURIComponent(location.hash.slice(1));
let tabScrollFrame = 0;
let tabScrollTimer = 0;
let ignoreTabScrollUntil = 0;

const CACHE_KEY = 'menu-cache-v1';
let lastJson = '';

let currentMenu = null;
let activePromoKey = '';

function show(menu) {
  currentMenu = menu;
  const { settings, categories, items } = menu;
  const now = barNow();
  const running = (menu.promotions ?? []).filter((p) => promotionStatus(p, now).active);
  activePromoKey = running.map((p) => p.id).join();

  sections = categories
    .filter((c) => c.visible)
    .map((c) => ({
      ...c,
      slug: slugify(c.name),
      items: items.filter((i) => i.category_id === c.id && i.visible).map((i) => withPromotions(i, running)),
    }))
    .filter((c) => c.items.length > 0);
  renderHeader(settings);
  renderTabs();
  renderPanel(firstLoad);
  renderPromoBanner();
  firstLoad = false;
}

// Aplica a promoção programada que estiver valendo agora (fica com o menor preço, se houver mais de uma).
function withPromotions(item, running) {
  const prices = running.filter((p) => promotionAppliesTo(p, item)).map((p) => Number(p.price));
  if (item.promo_price !== null) prices.push(Number(item.promo_price));
  const best = Math.min(...prices);
  if (!(best < Number(item.price))) return item;
  return { ...item, promo_price: best, badge: item.badge || 'promo' };
}

/* ---------- Faixa de promoções com cronômetro ---------- */

function promoTarget(promo) {
  const category = currentMenu.categories.find((c) => c.id === promo.category_id);
  const name = category?.name ?? '';
  // Evita concordância errada ("Todos os cervejas"): usa o nome da aba como está
  return promo.item_ids ? `${name}: itens selecionados` : name;
}

const promoTrack = document.getElementById('promo-track');
const promoDots = document.getElementById('promo-dots');
let bannerKey = '';
let bannerIndex = 0;
let pausedUntil = 0;

function currentPromos() {
  const now = barNow();
  const visible = new Set(sections.map((s) => s.id));
  return (currentMenu.promotions ?? [])
    .filter((p) => visible.has(p.category_id))
    .map((p) => ({ promo: p, status: promotionStatus(p, now) }))
    .filter(({ status }) => status.active || status.startsIn !== undefined)
    .sort((a, b) => Number(b.status.active) - Number(a.status.active));
}

const promoTagText = (promo, status) =>
  status.active ? 'Promoção agora' : `Hoje das ${formatTime(promo.start_time)} às ${formatTime(promo.end_time)}`;

// Monta os cards só quando a lista muda; a cada segundo atualiza apenas os cronômetros,
// para não atrapalhar quem está arrastando o carrossel.
function renderPromoBanner() {
  if (!currentMenu) return;
  const promos = currentPromos();
  const key = promos.map(({ promo, status }) => promo.id + (status.active ? '+' : '-') + (promo.image_url ?? '')).join();
  els.promos.hidden = promos.length === 0;

  if (key !== bannerKey) {
    bannerKey = key;
    promoTrack.replaceChildren(...promos.map(({ promo, status }) => {
      const slug = sections.find((s) => s.id === promo.category_id)?.slug;
      return h('button', {
        type: 'button',
        class: `promo-card${status.active ? ' is-live' : ''}${promo.image_url ? ' has-image' : ''}`,
        dataset: { id: promo.id },
        style: promo.image_url ? `--promo-image: url(${JSON.stringify(promo.image_url)})` : null,
        onclick: () => slug && select(slug),
      },
        h('span', { class: 'promo-tag' }, promoTagText(promo, status)),
        h('span', { class: 'promo-name' }, promo.name),
        h('span', { class: 'promo-offer' }, `${promoTarget(promo)} por ${formatPrice(promo.price)}`),
        h('span', { class: 'promo-timer' },
          status.active ? 'termina em ' : 'começa em ',
          h('strong', { class: 'promo-clock' }, '')),
      );
    }));
    promoDots.hidden = promos.length < 2;
    promoDots.replaceChildren(...promos.map(() => h('span', { class: 'dot' })));
    bannerIndex = Math.min(bannerIndex, Math.max(0, promos.length - 1));
    scrollToPromo(bannerIndex, false);
  }

  promos.forEach(({ promo, status }) => {
    const clock = promoTrack.querySelector(`[data-id="${promo.id}"] .promo-clock`);
    if (clock) clock.textContent = formatCountdown(status.active ? status.endsIn : status.startsIn);
  });
  updateDots();
}

function promoStep() {
  const card = promoTrack.firstElementChild;
  if (!card) return 0;
  return card.offsetWidth + parseFloat(getComputedStyle(promoTrack).columnGap || 0);
}

function scrollToPromo(index, smooth = true) {
  const step = promoStep();
  if (!step) return;
  const left = Math.min(index * step, promoTrack.scrollWidth - promoTrack.clientWidth);
  if (smooth) slideTo(left);
  else promoTrack.scrollLeft = left;
}

// Deslize próprio (não depende do "smooth" do navegador, que no iPhone costuma pular direto).
// Durante a animação o encaixe fica desligado, senão ele puxa o card antes da hora.
let slideFrame = 0;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function slideTo(left, duration = 900) {
  stopSlide();
  const from = promoTrack.scrollLeft;
  const start = performance.now();
  promoTrack.style.scrollSnapType = 'none';
  const frame = (now) => {
    const t = Math.min(1, (now - start) / duration);
    promoTrack.scrollLeft = from + (left - from) * ease(t);
    if (t < 1) slideFrame = requestAnimationFrame(frame);
    else stopSlide();
  };
  slideFrame = requestAnimationFrame(frame);
}

function stopSlide() {
  cancelAnimationFrame(slideFrame);
  slideFrame = 0;
  promoTrack.style.scrollSnapType = '';
}

function updateDots() {
  [...promoDots.children].forEach((dot, i) => dot.classList.toggle('is-active', i === bannerIndex));
}

promoTrack.addEventListener('scroll', () => {
  const step = promoStep();
  if (!step) return;
  bannerIndex = Math.min(promoTrack.children.length - 1, Math.round(promoTrack.scrollLeft / step));
  updateDots();
}, { passive: true });

// Se a pessoa mexer no carrossel, a troca automática espera um pouco
for (const type of ['pointerdown', 'touchstart', 'wheel']) {
  promoTrack.addEventListener(type, () => {
    pausedUntil = Date.now() + 10000;
    if (slideFrame) stopSlide(); // o dedo manda: interrompe o deslize automático
  }, { passive: true });
}

// Troca de card a cada 5 segundos; depois do último volta para o primeiro
setInterval(() => {
  const count = promoTrack.children.length;
  if (count < 2 || els.promos.hidden || document.hidden || Date.now() < pausedUntil) return;
  bannerIndex = (bannerIndex + 1) % count;
  scrollToPromo(bannerIndex);
  updateDots();
}, 5000);

// A cada segundo: atualiza os cronômetros e, quando uma promoção começa ou acaba, os preços.
setInterval(() => {
  if (!currentMenu || document.hidden) return;
  const now = barNow();
  const key = (currentMenu.promotions ?? []).filter((p) => promotionStatus(p, now).active).map((p) => p.id).join();
  if (key !== activePromoKey) {
    show(currentMenu);
    return;
  }
  renderPromoBanner();
}, 1000);

async function load() {
  try {
    const menu = await fetchMenu();
    const json = JSON.stringify(menu);
    if (json === lastJson) return; // nada mudou desde o que já está na tela
    lastJson = json;
    show(menu);
    try {
      localStorage.setItem(CACHE_KEY, json);
    } catch {}
  } catch (error) {
    console.error(error);
    if (!sections.length) {
      els.panel.replaceChildren(h('p', { class: 'state' }, 'Não foi possível carregar o cardápio. Verifique sua conexão e recarregue a página.'));
    }
  }
}

// Na volta ao cardápio, mostra na hora a última versão guardada neste celular e atualiza em seguida.
function showCached() {
  try {
    const json = localStorage.getItem(CACHE_KEY);
    if (!json) return;
    lastJson = json;
    show(JSON.parse(json));
  } catch {}
}

function renderHeader(settings) {
  const name = settings.bar_name || 'Dopamina Gastrobar';
  els.barName.textContent = name;
  document.title = `Cardápio ${name} | Uberaba - MG`;
  els.tagline.textContent = settings.tagline || '';
  els.tagline.hidden = !settings.tagline;
  els.notice.textContent = settings.notice_text || '';
  els.notice.hidden = !(settings.notice_active && settings.notice_text);
  els.footer.textContent = settings.footer_text || '';
  els.footer.hidden = !settings.footer_text;
}

function currentSection() {
  return sections.find((s) => s.slug === activeSlug) ?? sections[0];
}

function renderTabs({ center = true } = {}) {
  const current = currentSection();
  // As abas só são recriadas quando a lista muda. Recriar no meio do toque tiraria a aba da
  // página antes de o navegador acionar o interruptor da vibração.
  const signature = sections.map((s) => `${s.slug}:${s.name}`).join('|');
  if (els.tabs.dataset.signature !== signature) {
    els.tabs.dataset.signature = signature;
    els.tabs.replaceChildren(
      ...sections.map((s) =>
        // Cada aba é o rótulo de um interruptor escondido: o toque real do dedo aciona o
        // interruptor e o iPhone dá o "tique" de vibração do sistema (veja tapFeedback)
        h('label', {
          class: 'tab',
          for: 'tab-haptic',
          role: 'tab',
          tabindex: '0',
          dataset: { slug: s.slug },
          onclick: () => {
            tapFeedback();
            select(s.slug);
          },
          onkeydown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            select(s.slug);
          },
        }, s.name),
      ),
    );
  }
  for (const tab of els.tabs.children) {
    tab.setAttribute('aria-selected', String(tab.dataset.slug === current?.slug));
  }
  requestAnimationFrame(() => {
    updateTabEdgeSpace();
    if (center) centerTab(current?.slug, 'smooth');
  });
}

// Dá espaço nas pontas para a primeira e a última categoria também conseguirem parar no centro.
function updateTabEdgeSpace() {
  const first = els.tabs.firstElementChild;
  const last = els.tabs.lastElementChild;
  if (!first || !last) return;
  els.tabs.style.setProperty('--tab-edge-start', `${first.offsetWidth / 2}px`);
  els.tabs.style.setProperty('--tab-edge-end', `${last.offsetWidth / 2}px`);
}

function centerTab(slug, behavior = 'smooth') {
  const tab = [...els.tabs.children].find((item) => item.dataset.slug === slug);
  if (!tab) return;
  clearTimeout(tabScrollTimer);
  const left = tab.offsetLeft + tab.offsetWidth / 2 - els.tabs.clientWidth / 2;
  ignoreTabScrollUntil = performance.now() + (behavior === 'smooth' ? 450 : 80);
  els.tabs.scrollTo({ left, behavior });
}

function closestTabToCenter() {
  const track = els.tabs.getBoundingClientRect();
  const center = track.left + track.width / 2;
  let closest = null;
  let distance = Infinity;
  for (const tab of els.tabs.children) {
    const rect = tab.getBoundingClientRect();
    const nextDistance = Math.abs(rect.left + rect.width / 2 - center);
    if (nextDistance < distance) {
      closest = tab;
      distance = nextDistance;
    }
  }
  return closest;
}

// Enquanto a pessoa desliza, a categoria que atravessa o centro vira a categoria aberta.
// Ao parar, o scroll-snap do CSS encaixa a cápsula mais próxima exatamente no centro.
els.tabs.addEventListener('scroll', () => {
  if (performance.now() < ignoreTabScrollUntil) return;
  cancelAnimationFrame(tabScrollFrame);
  tabScrollFrame = requestAnimationFrame(() => {
    const tab = closestTabToCenter();
    if (tab?.dataset.slug && tab.dataset.slug !== currentSection()?.slug) {
      select(tab.dataset.slug, { center: false, scrollPage: false, animate: false });
    }
  });

  clearTimeout(tabScrollTimer);
  tabScrollTimer = setTimeout(() => {
    const tab = closestTabToCenter();
    if (tab?.dataset.slug) centerTab(tab.dataset.slug);
  }, 120);
}, { passive: true });

// Se a pessoa encostar durante um encaixe automático, o dedo volta a comandar na hora.
for (const type of ['pointerdown', 'touchstart', 'wheel']) {
  els.tabs.addEventListener(type, () => {
    ignoreTabScrollUntil = 0;
    clearTimeout(tabScrollTimer);
  }, { passive: true });
}

// Vibração curtinha ao tocar numa aba.
// Android: API de vibração do navegador.
// iPhone: o Safari não tem essa API; mas tocar num rótulo ligado a um <input switch> faz o
// próprio iPhone vibrar, como nos interruptores dos Ajustes. Precisa ser o toque de verdade
// (a Apple bloqueou o clique feito por código no iOS 26.5), por isso a aba é o rótulo.
function tapFeedback() {
  navigator.vibrate?.(10);
}

function renderPanel(animate = false) {
  const section = currentSection();
  if (!section) {
    els.panel.replaceChildren(h('p', { class: 'state' }, 'O cardápio está sendo atualizado. Volte em instantes.'));
    return;
  }
  // Em abas com dois preços, os itens sem foto usam colunas; o cabeçalho das colunas só aparece se houver algum.
  const columns = section.price2_label && section.items.some((i) => !i.image_url);
  els.panel.replaceChildren(...[
    h('h2', { class: 'section-title' }, section.name),
    columns
      ? h('p', { class: 'price-head' },
          h('span', { class: 'price-head-label' }, section.price_label || 'R$'),
          h('span', { class: 'price-head-label' }, section.price2_label))
      : null,
    h('ul', { class: animate ? 'items is-entering' : 'items' }, section.items.map((item) => renderItem(item, section))),
  ].filter(Boolean));
}

function renderItem(item, section) {
  return item.image_url ? renderPhotoItem(item, section) : renderPlainItem(item, section);
}

function itemPrice(item, money) {
  if (!item.available) return h('span', { class: 'price price-out' }, 'Esgotado');
  const promo = item.promo_price !== null && Number(item.promo_price) < Number(item.price);
  return h('span', { class: 'price' },
    promo ? h('s', { class: 'price-old' }, money(item.price)) : null,
    money(promo ? item.promo_price : item.price));
}

function badge(item) {
  return item.badge && BADGES[item.badge] ? h('span', { class: `badge badge-${item.badge}` }, BADGES[item.badge]) : null;
}

// Sem foto: nome à esquerda e preço à direita, numa linha só (layout clássico).
function renderPlainItem(item, section) {
  const twoPrices = Boolean(section.price2_label);
  const money = twoPrices ? (value) => formatPrice(value).replace(/^R\$\s?/, '') : formatPrice;
  return h('li', { class: `item item-plain${item.available ? '' : ' is-out'}` },
    h('p', { class: `item-line${twoPrices ? ' has-two-prices' : ''}` },
      h('span', { class: 'item-name' },
        h('strong', {}, item.name),
        item.detail ? h('span', { class: 'item-detail' }, ` ${item.detail}`) : null,
        badge(item),
      ),
      itemPrice(item, money),
      twoPrices
        ? h('span', { class: 'price' }, item.available && item.price2 !== null ? money(item.price2) : '')
        : null,
    ),
    item.description ? h('p', { class: 'item-desc' }, item.description) : null,
  );
}

// Com foto: texto e preço à esquerda, foto pequena à direita; tocar abre a foto grande.
function renderPhotoItem(item, section) {
  const twoPrices = Boolean(section.price2_label);
  const label = (text) => (twoPrices && text ? h('span', { class: 'price-label' }, text) : null);
  const first = itemPrice(item, formatPrice);
  if (item.available) first.prepend(...[label(section.price_label)].filter(Boolean));
  const prices = [
    first,
    item.available && twoPrices && item.price2 !== null
      ? h('span', { class: 'price' }, label(section.price2_label), formatPrice(item.price2))
      : null,
  ];

  return h('li', { class: `item item-photo-row${item.available ? '' : ' is-out'}` },
    h('button', {
      type: 'button',
      class: 'item-row',
      'aria-label': `Ver foto: ${item.name} ${item.detail}`.trim(),
      onclick: () => openPhoto(item),
    },
      h('span', { class: 'item-body' },
        h('span', { class: 'item-title' }, item.name, badge(item)),
        item.detail ? h('span', { class: 'item-sub' }, item.detail) : null,
        item.description ? h('span', { class: 'item-desc' }, item.description) : null,
        h('span', { class: 'item-prices' }, prices),
      ),
      h('img', { class: 'item-photo', src: item.thumb_url || item.image_url, alt: '', loading: 'lazy', decoding: 'async' }),
    ),
  );
}

/* ---------- Foto do item (desliza para ver as outras fotos da aba) ---------- */

const photoDialog = document.getElementById('photo-dialog');
const photoImg = document.getElementById('photo-img');
let gallery = [];
let galleryIndex = 0;

function openPhoto(item) {
  gallery = currentSection().items.filter((i) => i.image_url);
  galleryIndex = Math.max(0, gallery.indexOf(item));
  showPhoto(0);
  photoDialog.showModal();
}

function showPhoto(direction) {
  const section = currentSection();
  const twoPrices = Boolean(section.price2_label);
  const item = gallery[galleryIndex];
  photoImg.src = item.image_url;
  photoImg.alt = `${item.name} ${item.detail}`.trim();
  photoImg.classList.remove('slide-next', 'slide-prev');
  if (direction) {
    void photoImg.offsetWidth; // reinicia a animação
    photoImg.classList.add(direction > 0 ? 'slide-next' : 'slide-prev');
  }
  document.getElementById('photo-name').replaceChildren(
    h('strong', {}, item.name),
    ...(item.detail ? [h('span', { class: 'item-detail' }, ` ${item.detail}`)] : []),
  );
  const promo = item.promo_price !== null && Number(item.promo_price) < Number(item.price);
  document.getElementById('photo-price').textContent = !item.available
    ? 'Esgotado'
    : [
        `${twoPrices && section.price_label ? `${section.price_label}: ` : ''}${formatPrice(promo ? item.promo_price : item.price)}`,
        twoPrices && item.price2 !== null ? `${section.price2_label}: ${formatPrice(item.price2)}` : null,
      ].filter(Boolean).join(' · ');
  const desc = document.getElementById('photo-desc');
  desc.textContent = item.description || '';
  desc.hidden = !item.description;

  const many = gallery.length > 1;
  document.getElementById('photo-prev').hidden = !many;
  document.getElementById('photo-next').hidden = !many;
  const dots = document.getElementById('photo-dots');
  dots.hidden = !many;
  dots.replaceChildren(...gallery.map((_, i) => h('span', { class: i === galleryIndex ? 'dot is-active' : 'dot' })));
  // Já carrega a próxima foto para o deslize ser instantâneo
  if (many) new Image().src = gallery[(galleryIndex + 1) % gallery.length].image_url;
}

function step(delta) {
  if (gallery.length < 2) return;
  galleryIndex = (galleryIndex + delta + gallery.length) % gallery.length;
  showPhoto(delta);
}

document.getElementById('photo-prev').addEventListener('click', () => step(-1));
document.getElementById('photo-next').addEventListener('click', () => step(1));

photoDialog.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowRight') step(1);
  if (event.key === 'ArrowLeft') step(-1);
});

let touchStart = null;
photoDialog.addEventListener('touchstart', (event) => {
  touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
}, { passive: true });
photoDialog.addEventListener('touchend', (event) => {
  if (!touchStart) return;
  const dx = event.changedTouches[0].clientX - touchStart.x;
  const dy = event.changedTouches[0].clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
});

photoDialog.addEventListener('click', (event) => {
  // Toque fora da foto (no fundo escuro) ou no botão fecha
  if (event.target === photoDialog || event.target.closest('[data-close]')) photoDialog.close();
});

function select(slug, { center = true, scrollPage = true, animate = true } = {}) {
  if (slug === currentSection()?.slug) return;
  activeSlug = slug;
  history.replaceState(null, '', `#${slug}`);
  renderTabs({ center });
  renderPanel(animate);
  if (scrollPage) window.scrollTo({ top: 0, behavior: 'instant' });
}

window.addEventListener('hashchange', () => {
  activeSlug = decodeURIComponent(location.hash.slice(1));
  renderTabs();
  renderPanel(true);
});

// Tempo real: qualquer edição carimba menu_settings, e a página recarrega o cardápio.
let reloadTimer;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(load, 400);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) scheduleReload();
});

showCached();
load().then(startLiveUpdates);

// Tempo real: a biblioteca do Supabase só é baixada depois que o cardápio já está na tela.
async function startLiveUpdates() {
  try {
    const { supabase } = await import('./client.js?v=202611021720');
    supabase
      .channel('cardapio')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'menu_settings' }, scheduleReload)
      .subscribe();
  } catch (error) {
    console.error(error); // sem tempo real, o cardápio ainda atualiza ao voltar para a página
  }
}
