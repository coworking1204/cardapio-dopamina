import jsQR from 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/+esm';
import { supabase, editKey } from './client.js?v=202611022315';

const locked = document.getElementById('scanner-locked');
const content = document.getElementById('scanner-content');
const stage = document.getElementById('camera-stage');
const video = document.getElementById('camera-video');
const toggle = document.getElementById('camera-toggle');
const cameraStatus = document.getElementById('camera-status');
const result = document.getElementById('scanner-result');
const pendingList = document.getElementById('pending-list');
const refresh = document.getElementById('pending-refresh');

let stream;
let scanning = false;
let frameId;
let detector;
let lastFrameAt = 0;
const canvas = document.createElement('canvas');
const context = canvas.getContext('2d', { willReadFrequently: true });

const money = (value) => new Intl.NumberFormat('pt-BR', {
  style: 'currency', currency: 'BRL',
}).format(Number(value || 0));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function shortTime(value) {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function pulse() {
  navigator.vibrate?.(45);
}

function extractToken(raw) {
  const value = String(raw || '').trim();
  if (/^[a-f0-9]{48}$/i.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.origin !== location.origin || !url.pathname.endsWith('/retirada.html')) return '';
    const token = url.searchParams.get('t') || '';
    return /^[a-f0-9]{48}$/i.test(token) ? token : '';
  } catch {
    return '';
  }
}

async function init() {
  if (!editKey) return showLocked();
  const { data, error } = await supabase.rpc('has_menu_key');
  if (error || !data) return showLocked();
  content.hidden = false;
  await loadPending();
}

function showLocked() {
  locked.hidden = false;
  content.hidden = true;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraStatus.textContent = 'Câmera indisponível neste navegador';
    return;
  }

  toggle.disabled = true;
  cameraStatus.textContent = 'Abrindo câmera…';
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    video.srcObject = stream;
    await video.play();
    stage.hidden = false;
    toggle.disabled = false;
    toggle.textContent = 'Fechar câmera';
    cameraStatus.textContent = 'Aponte para o QR Code';
    scanning = true;
    if ('BarcodeDetector' in window) {
      try { detector = new BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; }
    }
    frameId = requestAnimationFrame(scanFrame);
  } catch {
    toggle.disabled = false;
    cameraStatus.textContent = 'Câmera bloqueada. Libere o acesso no Safari.';
  }
}

function stopCamera() {
  scanning = false;
  cancelAnimationFrame(frameId);
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  video.srcObject = null;
  stage.hidden = true;
  toggle.disabled = false;
  toggle.textContent = 'Abrir câmera';
}

async function scanFrame(now) {
  if (!scanning) return;
  if (video.readyState >= 2 && now - lastFrameAt > 140) {
    lastFrameAt = now;
    let raw = '';
    try {
      if (detector) {
        const codes = await detector.detect(video);
        raw = codes[0]?.rawValue || '';
      } else {
        const width = video.videoWidth;
        const height = video.videoHeight;
        canvas.width = width;
        canvas.height = height;
        context.drawImage(video, 0, 0, width, height);
        const image = context.getImageData(0, 0, width, height);
        raw = jsQR(image.data, width, height, { inversionAttempts: 'dontInvert' })?.data || '';
      }
    } catch {
      raw = '';
    }
    const token = extractToken(raw);
    if (token) {
      pulse();
      stopCamera();
      cameraStatus.textContent = 'QR Code lido';
      await loadByToken(token);
      return;
    }
  }
  frameId = requestAnimationFrame(scanFrame);
}

async function loadByToken(token) {
  setResultLoading();
  const { data, error } = await supabase.rpc('get_guest_order', { p_token: token });
  if (error || !data) return showResultError('Pedido não encontrado');
  renderOrder(data, { token });
}

async function loadByCode(code) {
  setResultLoading();
  const { data, error } = await supabase.rpc('get_staff_order', { p_code: code });
  if (error || !data) return showResultError('Pedido não encontrado');
  renderOrder(data, { code });
  result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setResultLoading() {
  result.hidden = false;
  result.replaceChildren(el('p', 'scanner-result-note', 'Carregando…'));
}

function showResultError(message) {
  result.hidden = false;
  result.replaceChildren(el('p', 'scanner-result-error', message));
}

function renderOrder(order, source) {
  const top = el('div', 'scanner-order-top');
  const identity = el('div', 'scanner-order-id');
  identity.append(el('strong', '', order.code), el('span', '', order.customer_name));
  top.append(identity, el('b', '', money(order.total)));

  const list = el('ul', 'scanner-order-items');
  for (const item of order.items || []) {
    const row = el('li', '');
    const copy = el('span', '');
    copy.append(el('strong', '', item.name), el('small', '', [item.detail, item.variant].filter(Boolean).join(' · ')));
    row.append(copy, el('b', '', `${item.quantity}×`));
    list.append(row);
  }

  const children = [top, list];
  if (order.status === 'created') {
    const button = el('button', 'scanner-deliver', 'Entregar pedido');
    button.type = 'button';
    button.addEventListener('click', () => redeem(order, source, button));
    children.push(button);
  } else {
    const labels = { redeemed: 'Pedido já entregue', expired: 'Pedido expirado', cancelled: 'Pedido cancelado' };
    children.push(el('p', 'scanner-result-error', labels[order.status] || 'Pedido indisponível'));
  }
  result.hidden = false;
  result.replaceChildren(...children);
}

async function redeem(order, source, button) {
  button.disabled = true;
  button.textContent = 'Confirmando…';
  const call = source.token
    ? supabase.rpc('redeem_guest_order', { p_token: source.token })
    : supabase.rpc('redeem_guest_order_by_code', { p_code: source.code });
  const { data, error } = await call;
  if (error || !data?.ok) {
    button.textContent = data?.reason === 'already_redeemed' ? 'Já entregue' : 'Tentar novamente';
    return;
  }
  pulse();
  result.replaceChildren(el('div', 'scanner-success', 'Pedido entregue'));
  await loadPending();
}

async function loadPending() {
  refresh.disabled = true;
  const { data, error } = await supabase.rpc('list_open_orders', { p_limit: 40 });
  refresh.disabled = false;
  if (error) {
    pendingList.replaceChildren(el('p', 'pending-empty', 'Não foi possível atualizar'));
    return;
  }
  if (!data?.length) {
    pendingList.replaceChildren(el('p', 'pending-empty', 'Nenhum pedido pendente'));
    return;
  }
  const rows = data.map((order) => {
    const button = el('button', 'pending-order');
    button.type = 'button';
    const copy = el('span', 'pending-order-copy');
    copy.append(el('strong', '', order.code), el('small', '', `${shortTime(order.created_at)} · ${order.customer_name}`));
    button.append(copy, el('b', '', `${order.quantity}×`));
    button.addEventListener('click', () => loadByCode(order.code));
    return button;
  });
  pendingList.replaceChildren(...rows);
}

toggle.addEventListener('click', () => stream ? stopCamera() : startCamera());
refresh.addEventListener('click', loadPending);
document.addEventListener('visibilitychange', () => { if (document.hidden && stream) stopCamera(); });
window.addEventListener('pagehide', stopCamera);

init();
