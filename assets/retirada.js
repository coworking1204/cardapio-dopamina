import { supabase, editKey } from './client.js?v=202611022120';

const state = document.getElementById('pickup-state');
const token = new URLSearchParams(location.search).get('t') || '';

const money = (value) => new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
}).format(Number(value || 0));

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statusCopy(order) {
  if (order.status === 'redeemed') return ['Entregue', 'Este QR Code já foi utilizado.'];
  if (order.status === 'expired') return ['Expirado', 'Este pedido não está mais disponível.'];
  if (order.status === 'cancelled') return ['Cancelado', 'Este pedido foi cancelado.'];
  return ['Pronto para retirada', 'Confira os itens antes de entregar.'];
}

async function loadOrder() {
  if (!/^[a-f0-9]{48}$/i.test(token)) {
    state.replaceChildren(el('p', 'pickup-error', 'QR Code inválido.'));
    return;
  }

  const [{ data: order, error }, access] = await Promise.all([
    supabase.rpc('get_guest_order', { p_token: token }),
    editKey ? supabase.rpc('has_menu_key') : Promise.resolve({ data: false }),
  ]);

  if (error || !order) {
    state.replaceChildren(el('p', 'pickup-error', 'Pedido não encontrado.'));
    return;
  }

  renderOrder(order, Boolean(access.data));
}

function renderOrder(order, canRedeem) {
  const [title, subtitle] = statusCopy(order);
  const badge = el('span', `pickup-status is-${order.status}`, title);
  const code = el('strong', 'pickup-code', order.code);
  const note = el('p', 'pickup-note', subtitle);
  const list = el('ul', 'pickup-items');

  for (const item of order.items || []) {
    const row = el('li', 'pickup-item');
    const copy = el('span', 'pickup-item-copy');
    copy.append(
      el('strong', '', item.name),
      el('small', '', [item.detail, item.variant].filter(Boolean).join(' · ')),
    );
    row.append(copy, el('b', '', `${item.quantity}×`));
    list.append(row);
  }

  const total = el('div', 'pickup-total');
  total.append(el('span', '', `${order.quantity} ${order.quantity === 1 ? 'item' : 'itens'}`), el('strong', '', money(order.total)));

  const children = [badge, code, note, list, total];
  if (canRedeem && order.status === 'created') {
    const button = el('button', 'pickup-redeem', 'Marcar como entregue');
    button.type = 'button';
    button.addEventListener('click', () => redeem(button));
    children.push(button);
  }
  state.replaceChildren(...children);
}

async function redeem(button) {
  button.disabled = true;
  button.textContent = 'Confirmando…';
  const { data, error } = await supabase.rpc('redeem_guest_order', { p_token: token });
  if (error || !data?.ok) {
    button.textContent = data?.reason === 'already_redeemed' ? 'Já entregue' : 'Não foi possível';
    await loadOrder();
    return;
  }
  await loadOrder();
}

loadOrder();
