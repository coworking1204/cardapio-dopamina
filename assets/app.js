import {
  fetchMenu, formatPrice, slugify, h, BADGES,
  barNow, promotionStatus, promotionAppliesTo, formatCountdown, formatTime,
} from './shared.js?v=202611022037';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js?v=202611021747';

const els = {
  barName: document.getElementById('bar-name'),
  tagline: document.getElementById('tagline'),
  notice: document.getElementById('notice'),
  tabs: document.getElementById('tabs'),
  panel: document.getElementById('panel'),
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

/* ---------- Carrinho da versão beta (somente neste aparelho) ---------- */

const CART_KEY = 'dopamina-beta-cart-v1';
const BETA_ORDER_KEY = 'dopamina-beta-last-order-v1';
let cart = loadCart();

function loadCart() {
  try {
    const saved = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    if (!Array.isArray(saved)) return [];
    return saved
      .filter((row) =>
        row
        && typeof row.key === 'string'
        && typeof row.itemId === 'string'
        && Number(row.quantity) > 0
        && Number.isFinite(Number(row.price)))
      .map((row) => ({
        ...row,
        price: Number(row.price),
        quantity: Math.min(99, Math.floor(Number(row.quantity))),
      }));
  } catch {
    return [];
  }
}

function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch {}
  updateCartBar();
  if (document.getElementById('cart-dialog')?.open) renderCart();
}

function effectivePrice(item, variant = 'price') {
  if (variant === 'price2') return Number(item.price2);
  const promo = item.promo_price !== null && Number(item.promo_price) < Number(item.price);
  return Number(promo ? item.promo_price : item.price);
}

function shortVariant(label, fallback) {
  return (label || fallback).replace(/\s*\(.+\)\s*$/, '').trim();
}

function reconcileCart() {
  const available = new Map();
  for (const section of sections) {
    for (const item of section.items) available.set(item.id, { item, section });
  }
  cart = cart.flatMap((row) => {
    const current = available.get(row.itemId);
    if (!current?.item.available) return [];
    if (row.variant === 'price2' && current.item.price2 === null) return [];
    const label = row.variant === 'price2'
      ? shortVariant(current.section.price2_label, 'Opção 2')
      : shortVariant(current.section.price_label, 'Unidade');
    return [{
      ...row,
      name: current.item.name,
      detail: current.item.detail,
      variantLabel: current.section.price2_label ? label : '',
      price: effectivePrice(current.item, row.variant),
      image: current.item.thumb_url || current.item.image_url || '',
    }];
  });
  saveCart();
}

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
  reconcileCart();
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
      tapFeedback();
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
    orderOptions(item, section),
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
    orderOptions(item, section),
  );
}

function orderOptions(item, section) {
  if (!item.available) return null;
  const variants = [{ key: 'price', label: shortVariant(section.price_label, 'Unidade') }];
  if (section.price2_label && item.price2 !== null) {
    variants.push({ key: 'price2', label: shortVariant(section.price2_label, 'Opção 2') });
  }
  return h('div', { class: `order-options${variants.length > 1 ? ' has-variants' : ''}` },
    variants.map((variant) => h('button', {
      type: 'button',
      class: `order-add${variants.length === 1 ? ' is-single' : ''}`,
      'aria-label': `Adicionar ${item.name}${variants.length > 1 ? `, ${variant.label}` : ''} ao pedido`,
      onclick: () => addToCart(item, section, variant.key, variant.label),
    }, variants.length > 1 ? `+ ${variant.label}` : '+')),
  );
}

function addToCart(item, section, variant, variantLabel) {
  const key = `${item.id}:${variant}`;
  const existing = cart.find((row) => row.key === key);
  if (existing) {
    existing.quantity = Math.min(99, existing.quantity + 1);
    existing.price = effectivePrice(item, variant);
  } else {
    cart.push({
      key,
      itemId: item.id,
      variant,
      name: item.name,
      detail: item.detail,
      variantLabel: section.price2_label ? variantLabel : '',
      price: effectivePrice(item, variant),
      quantity: 1,
      image: item.thumb_url || item.image_url || '',
    });
  }
  saveCart();
  const bar = document.getElementById('cart-bar');
  bar.classList.remove('is-pulsing');
  void bar.offsetWidth;
  bar.classList.add('is-pulsing');
}

function cartQuantity() {
  return cart.reduce((sum, row) => sum + row.quantity, 0);
}

function cartTotal() {
  return cart.reduce((sum, row) => sum + row.price * row.quantity, 0);
}

function updateCartBar() {
  const bar = document.getElementById('cart-bar');
  if (!bar) return;
  const quantity = cartQuantity();
  bar.hidden = quantity === 0;
  document.body.classList.toggle('has-cart', quantity > 0);
  document.getElementById('cart-count').textContent = `${quantity} ${quantity === 1 ? 'item' : 'itens'}`;
  document.getElementById('cart-bar-total').textContent = formatPrice(cartTotal());
}

function changeCartQuantity(key, delta) {
  const row = cart.find((item) => item.key === key);
  if (!row) return;
  row.quantity += delta;
  if (row.quantity <= 0) cart = cart.filter((item) => item.key !== key);
  else row.quantity = Math.min(99, row.quantity);
  saveCart();
}

function renderCart() {
  const list = document.getElementById('cart-items');
  const empty = document.getElementById('cart-empty');
  const footer = document.getElementById('cart-footer');
  empty.hidden = cart.length > 0;
  footer.hidden = cart.length === 0;
  list.replaceChildren(...cart.map((row) => h('li', { class: 'cart-item' },
    row.image ? h('img', { class: 'cart-thumb', src: row.image, alt: '', loading: 'lazy' }) : null,
    h('div', { class: 'cart-item-body' },
      h('strong', { class: 'cart-item-name' }, row.name),
      row.detail ? h('span', { class: 'cart-item-detail' }, row.detail) : null,
      row.variantLabel ? h('span', { class: 'cart-item-variant' }, row.variantLabel) : null,
      h('span', { class: 'cart-item-price' }, formatPrice(row.price * row.quantity)),
    ),
    h('div', { class: 'cart-stepper', 'aria-label': `Quantidade de ${row.name}` },
      h('button', { type: 'button', 'aria-label': `Diminuir ${row.name}`, onclick: () => changeCartQuantity(row.key, -1) }, '−'),
      h('span', { 'aria-live': 'polite' }, row.quantity),
      h('button', { type: 'button', 'aria-label': `Aumentar ${row.name}`, onclick: () => changeCartQuantity(row.key, 1) }, '+'),
    ),
  )));
  document.getElementById('cart-total').textContent = formatPrice(cartTotal());
}

function setCartView(view) {
  document.getElementById('cart-view').hidden = view !== 'cart';
  document.getElementById('checkout-form').hidden = view !== 'checkout';
  document.getElementById('payment-pending').hidden = view !== 'pending';
  document.getElementById('order-success').hidden = view !== 'success';
  const titles = {
    cart: ['Seu pedido', 'Carrinho'],
    checkout: ['Pedido', 'Identificação'],
    pending: ['Pagamento', 'Aguarde'],
    success: ['Retirada', 'QR Code'],
  };
  document.getElementById('cart-kicker').textContent = titles[view][0];
  document.getElementById('cart-title').textContent = titles[view][1];
}

function localPhoneDigits(value) {
  let digits = String(value).replace(/\D/g, '');
  if (digits.startsWith('55') && digits.length > 11) digits = digits.slice(2);
  return digits.slice(0, 11);
}

function formatWhatsapp(value) {
  const digits = localPhoneDigits(value);
  if (digits.length <= 2) return digits ? `(${digits}` : '';
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

function showCheckout() {
  if (!cart.length) return;
  const quantity = cartQuantity();
  document.getElementById('checkout-summary').textContent = `${quantity} ${quantity === 1 ? 'item' : 'itens'} · ${formatPrice(cartTotal())}`;
  document.getElementById('checkout-error').hidden = true;
  setCartView('checkout');
  document.getElementById('checkout-name').focus();
}

function showOrderSuccess(order) {
  document.getElementById('success-code').textContent = order.code;
  document.getElementById('success-items').textContent = `${order.quantity} ${order.quantity === 1 ? 'item' : 'itens'}`;
  document.getElementById('success-total').textContent = formatPrice(order.total);
  setCartView('success');
  renderOrderQr(order).catch(() => {
    document.getElementById('success-qr').hidden = true;
  });
}

async function renderOrderQr(order) {
  const canvas = document.getElementById('success-qr');
  canvas.hidden = false;
  const pickupUrl = new URL('retirada.html', location.href);
  pickupUrl.search = '';
  pickupUrl.hash = '';
  pickupUrl.searchParams.set('t', order.token);
  canvas.dataset.url = pickupUrl.href;
  const { default: QRCode } = await import('https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm');
  await QRCode.toCanvas(canvas, pickupUrl.href, {
    width: 220,
    margin: 1,
    color: { dark: '#080809', light: '#ffffff' },
    errorCorrectionLevel: 'M',
  });
}

const cartDialog = document.getElementById('cart-dialog');
document.getElementById('cart-bar').addEventListener('click', () => {
  renderCart();
  setCartView('cart');
  cartDialog.showModal();
});
cartDialog.addEventListener('click', (event) => {
  if (event.target === cartDialog || event.target.closest('[data-cart-close]')) cartDialog.close();
});
cartDialog.addEventListener('close', () => setCartView('cart'));
document.getElementById('cart-clear').addEventListener('click', () => {
  if (!confirm('Esvaziar todo o carrinho?')) return;
  cart = [];
  saveCart();
});
document.getElementById('cart-continue').addEventListener('click', showCheckout);
document.getElementById('checkout-back').addEventListener('click', () => setCartView('cart'));
document.getElementById('checkout-phone').addEventListener('input', (event) => {
  event.target.value = formatWhatsapp(event.target.value);
});
document.getElementById('checkout-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const nameInput = document.getElementById('checkout-name');
  const phoneInput = document.getElementById('checkout-phone');
  const emailInput = document.getElementById('checkout-email');
  const submit = document.getElementById('checkout-submit');
  const name = nameInput.value.trim().replace(/\s+/g, ' ');
  const phoneDigits = localPhoneDigits(phoneInput.value);
  const email = emailInput.value.trim().toLowerCase();
  const error = document.getElementById('checkout-error');
  if (name.length < 2) {
    error.textContent = 'Digite seu nome para identificar o pedido.';
    error.hidden = false;
    nameInput.focus();
    return;
  }
  if (phoneDigits.length < 10) {
    error.textContent = 'Digite um WhatsApp com DDD.';
    error.hidden = false;
    phoneInput.focus();
    return;
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    error.textContent = 'Digite um e-mail válido.';
    error.hidden = false;
    emailInput.focus();
    return;
  }

  submit.disabled = true;
  submit.textContent = 'Abrindo…';
  error.hidden = true;

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/mercadopago-checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({
        name,
        phone: phoneDigits,
        email,
        items: cart.map((row) => ({
        item_id: row.itemId,
        variant: row.variant,
        quantity: row.quantity,
        })),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.order?.token || !data?.checkout_url) throw new Error(data?.error || 'Pagamento indisponível');

    const order = {
      ...data.order,
      customer: { name, phone: formatWhatsapp(phoneDigits), email },
    };
    localStorage.setItem(BETA_ORDER_KEY, JSON.stringify(order));
    cart = [];
    saveCart();
    location.assign(data.checkout_url);
  } catch (requestError) {
    error.textContent = requestError?.message || 'Não foi possível abrir o pagamento.';
    error.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = 'Ir para pagamento';
  }
});
updateCartBar();

async function refreshPayment(order, quiet = false) {
  if (!quiet) setCartView('pending');
  const response = await fetch(`${SUPABASE_URL}/functions/v1/mercadopago-status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({ token: order.token }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || 'Consulta indisponível');
  if (data.payment_status === 'paid') {
    const confirmed = { ...order, ...data.order, token: order.token, payment_status: 'paid' };
    localStorage.setItem(BETA_ORDER_KEY, JSON.stringify(confirmed));
    showOrderSuccess(confirmed);
    return true;
  }
  if (['failed', 'refunded'].includes(data.payment_status)) {
    document.querySelector('#payment-pending strong').textContent = 'Pagamento não aprovado';
    document.querySelector('#payment-pending p').textContent = 'Volte ao cardápio e tente novamente.';
    document.getElementById('payment-refresh').hidden = true;
    return true;
  }
  return false;
}

async function resumePaymentReturn() {
  if (new URLSearchParams(location.search).get('payment') !== 'return') return;
  history.replaceState(null, '', `${location.pathname}${location.hash}`);
  let order;
  try { order = JSON.parse(localStorage.getItem(BETA_ORDER_KEY) || 'null'); } catch { order = null; }
  if (!order?.token) return;
  setCartView('pending');
  cartDialog.showModal();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      if (await refreshPayment(order, true)) return;
    } catch {
      // O botão manual continua disponível se a rede oscilar.
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  document.querySelector('#payment-pending strong').textContent = 'Pagamento em análise';
  document.querySelector('#payment-pending p').textContent = 'Toque em atualizar daqui a pouco.';
}

document.getElementById('payment-refresh').addEventListener('click', async () => {
  let order;
  try { order = JSON.parse(localStorage.getItem(BETA_ORDER_KEY) || 'null'); } catch { order = null; }
  if (!order?.token) return;
  const button = document.getElementById('payment-refresh');
  button.disabled = true;
  try { await refreshPayment(order); } finally { button.disabled = false; }
});

resumePaymentReturn();

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
    const { supabase } = await import('./client.js?v=202611022120');
    supabase
      .channel('cardapio')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'menu_settings' }, scheduleReload)
      .subscribe();
  } catch (error) {
    console.error(error); // sem tempo real, o cardápio ainda atualiza ao voltar para a página
  }
}
