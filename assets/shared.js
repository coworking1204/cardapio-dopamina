import { SUPABASE_URL, SUPABASE_KEY } from './config.js?v=202611021747';

export const BADGES = {
  novo: 'Novo',
  mais_pedido: 'Mais pedido 🔥',
  promo: 'Promo',
  em_breve: 'Em breve',
};

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatPrice(value) {
  return brl.format(Number(value) || 0);
}

// "14,50", "14.50" ou "R$ 14,50" → 14.5 (null se não for um número válido)
export function parsePrice(text) {
  const clean = String(text).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  if (clean === '') return null;
  const value = Number(clean);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null;
}

export function slugify(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Cria elementos sem innerHTML, para nenhum texto do banco virar HTML.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'value' || (key in el && typeof value !== 'string')) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

// Busca direto pela API REST, sem a biblioteca do Supabase: o cardápio aparece bem mais rápido no celular.
export async function fetchMenu(headers = {}) {
  const get = async (path) => {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPABASE_KEY, ...headers },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Falha ao carregar ${path}: ${response.status}`);
    return response.json();
  };
  const [settings, categories, items, promotions] = await Promise.all([
    get('menu_settings?select=*&id=eq.1'),
    get('menu_categories?select=*&order=position.asc,created_at.asc'),
    get('menu_items?select=*&order=position.asc,created_at.asc'),
    get('menu_promotions?select=*&order=created_at.asc'),
  ]);
  return { settings: settings[0] ?? {}, categories, items, promotions: promotions.sort(comparePromotions) };
}

/* ---------- Promoções programadas (sempre no horário de Brasília) ---------- */

export const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const DAY = 24 * 3600;

// A coluna position é usada quando já existe no banco. Enquanto a migração não for
// aplicada, created_at mantém a mesma ordem e também permite reordenar sem interromper o editor.
export function comparePromotions(a, b) {
  const aPosition = Number(a.position);
  const bPosition = Number(b.position);
  const hasPositions = a.position !== null && a.position !== undefined
    && b.position !== null && b.position !== undefined
    && Number.isFinite(aPosition) && Number.isFinite(bPosition)
    && aPosition !== bPosition;
  if (hasPositions) return aPosition - bPosition;
  return String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
    || String(a.id ?? '').localeCompare(String(b.id ?? ''));
}

const barClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Sao_Paulo',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

// Dia da semana (0 = domingo) e segundos desde a meia-noite, no horário do bar
export function barNow(date = new Date()) {
  const parts = Object.fromEntries(barClock.formatToParts(date).map((p) => [p.type, p.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { day, seconds: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second) };
}

const toSeconds = (time) => {
  const [h, m, sec = 0] = String(time).split(':').map(Number);
  return h * 3600 + m * 60 + sec;
};

export function formatTime(time) {
  const [h, m] = String(time).split(':');
  return m === '00' ? `${Number(h)}h` : `${Number(h)}h${m}`;
}

// Situação da promoção agora: ativa (e quanto falta para acabar) ou ainda vai começar hoje.
// Se o fim for antes do início (ex.: 22h às 2h), ela termina no dia seguinte.
export function promotionStatus(promo, now = barNow()) {
  if (!promo.active || !promo.days?.length) return { active: false };
  const start = toSeconds(promo.start_time);
  const end = toSeconds(promo.end_time);
  const today = promo.days.includes(now.day);
  const yesterday = promo.days.includes((now.day + 6) % 7);
  const t = now.seconds;
  if (end > start) {
    if (today && t >= start && t < end) return { active: true, endsIn: end - t };
  } else {
    if (today && t >= start) return { active: true, endsIn: DAY - t + end };
    if (yesterday && t < end) return { active: true, endsIn: end - t };
  }
  if (today && t < start) return { active: false, startsIn: start - t };
  return { active: false };
}

export function promotionAppliesTo(promo, item) {
  return promo.category_id === item.category_id && (!promo.item_ids || promo.item_ids.includes(item.id));
}

export function formatCountdown(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = Math.floor(seconds % 60);
  return [h, m, sec].map((n) => String(n).padStart(2, '0')).join(':');
}
