import { supabase, editKey } from './client.js?v=202611021738';
import {
  fetchMenu, formatPrice, parsePrice, h, BADGES,
  WEEKDAYS, barNow, promotionStatus, formatTime,
} from './shared.js?v=202611021738';

const $ = (id) => document.getElementById(id);

const views = {
  locked: $('locked-view'),
  editor: $('editor-view'),
};

const state = {
  settings: {},
  categories: [],
  items: [],
  promotions: [],
  view: null, // id de uma aba, 'abas' ou 'avisos'
};

/* ---------- Acesso pelo link secreto ---------- */

function show(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

async function start() {
  const { data, error } = editKey ? await supabase.rpc('has_menu_key') : { data: false };
  if (error) {
    console.error(error);
    toast('Não foi possível conectar. Verifique a internet e recarregue.', true);
    return;
  }
  if (!data) {
    show('locked');
    return;
  }
  show('editor');
  await reload();
}

/* ---------- Dados ---------- */

async function reload() {
  try {
    Object.assign(state, await fetchMenu({ 'x-menu-key': editKey }));
    const valid = state.view === 'abas' || state.view === 'avisos' || state.view === 'promocoes' || state.categories.some((c) => c.id === state.view);
    if (!valid) state.view = state.categories[0]?.id ?? 'abas';
    render();
  } catch (error) {
    console.error(error);
    toast('Não foi possível carregar o cardápio. Verifique a conexão.', true);
  }
}

async function update(table, id, patch) {
  // Sem permissão o banco não dá erro, só não altera nenhuma linha; por isso confere o retorno.
  const { data, error } = await supabase.from(table).update(patch).eq('id', id).select('id');
  if (error || !data?.length) {
    console.error(error);
    toast(error ? 'Não salvou. Verifique a conexão e tente de novo.' : 'Não salvou: abra de novo o seu link de edição.', true);
    return false;
  }
  return true;
}

function itemsOf(categoryId) {
  return state.items
    .filter((i) => i.category_id === categoryId)
    .sort((a, b) => a.position - b.position);
}

function categoriesSorted() {
  return [...state.categories].sort((a, b) => a.position - b.position);
}

// Troca de lugar com o vizinho e renumera a lista inteira.
async function move(table, list, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  const reordered = [...list];
  [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
  const changes = reordered
    .map((row, position) => ({ row, position }))
    .filter(({ row, position }) => row.position !== position);
  changes.forEach(({ row, position }) => (row.position = position));
  render();
  const results = await Promise.all(changes.map(({ row, position }) => update(table, row.id, { position })));
  if (results.includes(false)) await reload();
}

/* ---------- Interface ---------- */

let toastTimer;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('is-error', isError);
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), isError ? 4000 : 1800);
}

function render() {
  renderTabs();
  const editor = $('editor');
  if (state.view === 'abas') editor.replaceChildren(renderCategoriesView());
  else if (state.view === 'avisos') editor.replaceChildren(renderSettingsView());
  else if (state.view === 'promocoes') editor.replaceChildren(renderPromotionsView());
  else editor.replaceChildren(renderCategoryView(state.categories.find((c) => c.id === state.view)));
}

function renderTabs() {
  const tab = (view, label, extraClass = '') =>
    h('button', {
      type: 'button',
      class: `tab ${extraClass}`,
      'aria-pressed': String(state.view === view),
      onclick: () => {
        state.view = view;
        render();
        window.scrollTo({ top: 0 });
      },
    }, label);

  $('admin-tabs').replaceChildren(
    ...categoriesSorted().map((c) => tab(c.id, c.name, c.visible ? '' : 'is-hidden')),
    tab('promocoes', '⏱ Promoções', 'tab-tool'),
    tab('abas', '⚙ Abas', 'tab-tool'),
    tab('avisos', '⚙ Avisos e info', 'tab-tool'),
  );
}

function renderCategoryView(category) {
  const list = itemsOf(category.id);
  return h('div', { class: 'stack' },
    h('div', { class: 'view-head' },
      h('h1', {}, category.name),
      category.visible ? null : h('span', { class: 'pill' }, 'Aba oculta'),
    ),
    list.length
      ? h('ul', { class: 'cards' }, list.map((item, index) => renderItemCard(item, index, list)))
      : h('p', { class: 'muted' }, 'Nenhum item nesta aba. Abas vazias não aparecem para o cliente.'),
    h('button', { type: 'button', class: 'btn btn-gold btn-block', onclick: () => openItem(null, category.id) }, '+ Adicionar item'),
  );
}

function renderItemCard(item, index, list) {
  const card = h('li', { class: `card${item.available ? '' : ' is-out'}${item.visible ? '' : ' is-hidden'}` });

  const category = state.categories.find((c) => c.id === item.category_id);
  const priceInput = makePriceInput(item, 'price', category?.price_label);
  const price2Input = category?.price2_label ? makePriceInput(item, 'price2', category.price2_label) : null;

  const availability = h('input', {
    type: 'checkbox',
    checked: item.available,
    onchange: async (event) => {
      const available = event.target.checked;
      item.available = available;
      card.classList.toggle('is-out', !available);
      if (await update('menu_items', item.id, { available })) {
        toast(available ? `${item.name} disponível` : `${item.name} marcado como esgotado`);
      } else {
        item.available = !available;
        event.target.checked = !available;
        card.classList.toggle('is-out', available);
      }
    },
  });

  const promo = item.promo_price !== null && Number(item.promo_price) < Number(item.price);

  card.append(
    h('div', { class: 'card-main' },
      item.image_url ? h('img', { class: 'card-thumb', src: item.thumb_url || item.image_url, alt: '', loading: 'lazy' }) : null,
      h('button', { type: 'button', class: 'card-title', onclick: () => openItem(item) },
        h('strong', {}, item.name),
        item.detail ? h('span', {}, ` ${item.detail}`) : null,
        h('span', { class: 'card-tags' },
          item.badge ? h('span', { class: 'pill' }, BADGES[item.badge]) : null,
          promo ? h('span', { class: 'pill' }, `Promo ${formatPrice(item.promo_price)}`) : null,
          item.visible ? null : h('span', { class: 'pill' }, 'Oculto'),
        ),
      ),
      h('div', { class: 'price-fields' },
        priceInput,
        price2Input,
      ),
    ),
    h('div', { class: 'card-actions' },
      h('label', { class: 'switch' }, availability, h('span', { class: 'switch-track', 'aria-hidden': 'true' }), 'Disponível'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Subir', disabled: index === 0, onclick: () => move('menu_items', list, index, -1) }, '↑'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Descer', disabled: index === list.length - 1, onclick: () => move('menu_items', list, index, 1) }, '↓'),
      h('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: () => openItem(item) }, 'Editar'),
    ),
  );
  return card;
}

const plain = (value) => formatPrice(value).replace(/^R\$\s?/, '');

// Campo de preço editável direto na lista. O segundo preço pode ficar vazio.
function makePriceInput(item, key, label) {
  const optional = key === 'price2';
  const input = h('input', {
    class: 'price-input',
    inputmode: 'decimal',
    placeholder: optional ? '—' : '0,00',
    'aria-label': `${label || 'Preço'} de ${item.name} ${item.detail}`.trim(),
    value: item[key] === null ? '' : plain(item[key]),
    onfocus: (event) => event.target.select(),
    onkeydown: (event) => {
      if (event.key === 'Enter') event.target.blur();
    },
    onchange: async () => {
      const previous = item[key];
      const empty = input.value.trim() === '';
      const value = empty && optional ? null : parsePrice(input.value);
      const restore = () => (input.value = previous === null ? '' : plain(previous));
      if (value === null && !(empty && optional)) {
        restore();
        toast('Preço inválido. Use números, como 14,50.', true);
        return;
      }
      item[key] = value;
      input.value = value === null ? '' : plain(value);
      if (await update('menu_items', item.id, { [key]: value })) {
        toast(value === null ? `${item.name}: ${label} removido` : `${item.name}: ${formatPrice(value)}`);
      } else {
        item[key] = previous;
        restore();
      }
    },
  });
  return h('label', { class: 'price-field' },
    label ? h('span', { class: 'price-field-label' }, label) : null,
    h('span', { class: 'price-field-box' }, h('span', { 'aria-hidden': 'true' }, 'R$'), input),
  );
}

function renderCategoriesView() {
  const list = categoriesSorted();
  const addForm = h('form', {
    class: 'add-row',
    onsubmit: async (event) => {
      event.preventDefault();
      const name = event.target.elements.name.value.trim();
      if (!name) return;
      const position = list.length ? Math.max(...list.map((c) => c.position)) + 1 : 0;
      const { data, error } = await supabase.from('menu_categories').insert({ name, position }).select().single();
      if (error) {
        toast('Não foi possível criar a aba.', true);
        return;
      }
      state.categories.push(data);
      toast(`Aba "${name}" criada`);
      render();
    },
  },
    h('input', { name: 'name', placeholder: 'Nova aba, ex.: Copões', required: true, 'aria-label': 'Nome da nova aba' }),
    h('button', { type: 'submit', class: 'btn btn-gold' }, 'Adicionar aba'),
  );

  return h('div', { class: 'stack' },
    h('div', { class: 'view-head' }, h('h1', {}, 'Abas')),
    h('p', { class: 'muted' }, 'A ordem aqui é a ordem das abas no cardápio. Abas ocultas ou vazias não aparecem para o cliente.'),
    h('ul', { class: 'cards' }, list.map((category, index) => {
      const count = itemsOf(category.id).length;
      return h('li', { class: `card${category.visible ? '' : ' is-hidden'}` },
        h('input', {
          class: 'name-input',
          value: category.name,
          'aria-label': 'Nome da aba',
          onkeydown: (event) => {
            if (event.key === 'Enter') event.target.blur();
          },
          onchange: async (event) => {
            const name = event.target.value.trim();
            if (!name) {
              event.target.value = category.name;
              return;
            }
            if (await update('menu_categories', category.id, { name })) {
              category.name = name;
              renderTabs();
              toast('Nome da aba salvo');
            }
          },
        }),
        h('div', { class: 'field-row label-row' },
          labelInput(category, 'price_label', 'Nome do preço', 'Ex.: Individual (150g)'),
          labelInput(category, 'price2_label', '2º preço (opcional)', 'Ex.: Inteira (450g)'),
        ),
        h('div', { class: 'card-actions' },
          h('label', { class: 'switch' },
            h('input', {
              type: 'checkbox',
              checked: category.visible,
              onchange: async (event) => {
                const visible = event.target.checked;
                if (await update('menu_categories', category.id, { visible })) {
                  category.visible = visible;
                  toast(visible ? `"${category.name}" visível` : `"${category.name}" oculta`);
                  render();
                } else event.target.checked = !visible;
              },
            }),
            h('span', { class: 'switch-track', 'aria-hidden': 'true' }),
            'Visível',
          ),
          h('span', { class: 'muted small' }, `${count} ${count === 1 ? 'item' : 'itens'}`),
          h('span', { class: 'spacer' }),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Subir', disabled: index === 0, onclick: () => move('menu_categories', list, index, -1) }, '↑'),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Descer', disabled: index === list.length - 1, onclick: () => move('menu_categories', list, index, 1) }, '↓'),
          h('button', {
            type: 'button',
            class: 'icon-btn icon-danger',
            'aria-label': `Excluir aba ${category.name}`,
            onclick: async () => {
              const warning = count
                ? `Excluir a aba "${category.name}" e os ${count} itens dela? Não dá para desfazer.`
                : `Excluir a aba "${category.name}"?`;
              if (!confirm(warning)) return;
              const { error } = await supabase.from('menu_categories').delete().eq('id', category.id);
              if (error) {
                toast('Não foi possível excluir a aba.', true);
                return;
              }
              state.categories = state.categories.filter((c) => c.id !== category.id);
              state.items = state.items.filter((i) => i.category_id !== category.id);
              toast('Aba excluída');
              render();
            },
          }, '✕'),
        ),
      );
    })),
    addForm,
  );
}

// Nomes das colunas de preço de uma aba. Com o 2º preço preenchido, a aba mostra duas colunas.
function labelInput(category, key, label, placeholder) {
  return h('label', { class: 'field' }, label,
    h('input', {
      value: category[key] ?? '',
      placeholder,
      onkeydown: (event) => {
        if (event.key === 'Enter') event.target.blur();
      },
      onchange: async (event) => {
        const value = event.target.value.trim();
        if (await update('menu_categories', category.id, { [key]: value })) {
          category[key] = value;
          toast('Colunas de preço salvas');
        } else event.target.value = category[key] ?? '';
      },
    }),
  );
}

function renderSettingsView() {
  const s = state.settings;
  const form = h('form', {
    class: 'stack',
    onsubmit: async (event) => {
      event.preventDefault();
      const f = event.target.elements;
      const patch = {
        bar_name: f.bar_name.value.trim() || 'Cardápio',
        tagline: f.tagline.value.trim(),
        notice_text: f.notice_text.value.trim(),
        notice_active: f.notice_active.checked,
        footer_text: f.footer_text.value.trim(),
      };
      if (await update('menu_settings', 1, patch)) {
        Object.assign(state.settings, patch);
        toast('Avisos e informações salvos');
      }
    },
  },
    h('div', { class: 'view-head' }, h('h1', {}, 'Avisos e info')),
    h('fieldset', { class: 'card-plain stack' },
      h('legend', {}, 'Faixa de aviso no topo'),
      h('label', { class: 'field' }, 'Texto do aviso',
        h('input', { name: 'notice_text', value: s.notice_text ?? '', placeholder: 'Happy hour até 20h: Brahma 600ml por R$ 11' })),
      h('label', { class: 'switch' },
        h('input', { name: 'notice_active', type: 'checkbox', checked: Boolean(s.notice_active) }),
        h('span', { class: 'switch-track', 'aria-hidden': 'true' }),
        'Mostrar aviso no cardápio'),
    ),
    h('fieldset', { class: 'card-plain stack' },
      h('legend', {}, 'Informações do bar'),
      h('label', { class: 'field' }, 'Nome do bar', h('input', { name: 'bar_name', value: s.bar_name ?? '' })),
      h('label', { class: 'field' }, 'Frase abaixo do nome', h('input', { name: 'tagline', value: s.tagline ?? '', placeholder: 'Ex.: Aberto de quarta a domingo, das 18h às 2h' })),
      h('label', { class: 'field' }, 'Texto do rodapé', h('textarea', { name: 'footer_text', rows: 2, value: s.footer_text ?? '', placeholder: 'Ex.: Rua Exemplo, 123 · @seubar' })),
    ),
    h('button', { type: 'submit', class: 'btn btn-gold btn-block' }, 'Salvar avisos e informações'),
  );
  return form;
}

/* ---------- Promoções programadas ---------- */

function describeDays(days) {
  const sorted = [...days].sort();
  if (sorted.length === 7) return 'Todos os dias';
  return sorted.map((d) => WEEKDAYS[d]).join(', ');
}

function promoSummary(promo) {
  const category = state.categories.find((c) => c.id === promo.category_id);
  const count = promo.item_ids ? promo.item_ids.length : itemsOf(promo.category_id).length;
  const target = promo.item_ids ? `${count} ${count === 1 ? 'item' : 'itens'} de ${category?.name ?? '?'}` : `toda a aba ${category?.name ?? '?'}`;
  return `${describeDays(promo.days)} · ${formatTime(promo.start_time)} às ${formatTime(promo.end_time)} · ${target}`;
}

function renderPromotionsView() {
  const now = barNow();
  return h('div', { class: 'stack' },
    h('div', { class: 'view-head' }, h('h1', {}, 'Promoções')),
    h('p', { class: 'muted' }, 'Programe promoções que se repetem toda semana. No horário marcado (de Brasília), o cardápio mostra o preço promocional e um cronômetro; depois volta ao normal sozinho.'),
    state.promotions.length
      ? h('ul', { class: 'cards' }, state.promotions.map((promo) => {
          const status = promotionStatus(promo, now);
          return h('li', { class: `card${promo.active ? '' : ' is-hidden'}` },
            h('div', { class: 'card-main' },
              h('button', { type: 'button', class: 'card-title', onclick: () => openPromotion(promo) },
                h('strong', {}, promo.name),
                h('span', { class: 'card-tags' },
                  status.active ? h('span', { class: 'pill pill-live' }, 'Valendo agora') : null,
                  !status.active && status.startsIn !== undefined ? h('span', { class: 'pill' }, `Hoje às ${formatTime(promo.start_time)}`) : null,
                ),
              ),
              h('span', { class: 'promo-price' }, formatPrice(promo.price)),
            ),
            h('p', { class: 'muted small promo-summary' }, promoSummary(promo)),
            h('div', { class: 'card-actions' },
              h('label', { class: 'switch' },
                h('input', {
                  type: 'checkbox',
                  checked: promo.active,
                  onchange: async (event) => {
                    const active = event.target.checked;
                    if (await update('menu_promotions', promo.id, { active })) {
                      promo.active = active;
                      toast(active ? `"${promo.name}" ligada` : `"${promo.name}" desligada`);
                      render();
                    } else event.target.checked = !active;
                  },
                }),
                h('span', { class: 'switch-track', 'aria-hidden': 'true' }),
                'Ligada',
              ),
              h('span', { class: 'spacer' }),
              h('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: () => openPromotion(promo) }, 'Editar'),
            ),
          );
        }))
      : h('p', { class: 'muted' }, 'Nenhuma promoção programada ainda.'),
    h('button', { type: 'button', class: 'btn btn-gold btn-block', onclick: () => openPromotion(null) }, '+ Nova promoção'),
  );
}

const promoDialog = $('promo-dialog');
let promoImage = { file: null, remove: false }; // imagem pendente até salvar

function showPromoImage(url) {
  const preview = $('promo-image-preview');
  preview.hidden = !url;
  if (url) preview.src = url;
  else preview.removeAttribute('src');
  $('promo-image-remove').hidden = !url;
  $('promo-image-label').textContent = url ? 'Trocar imagem' : 'Escolher imagem';
}

$('promo-image-input').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) return;
  promoImage = { file, remove: false };
  showPromoImage(URL.createObjectURL(file));
});

$('promo-image-remove').addEventListener('click', () => {
  promoImage = { file: null, remove: true };
  $('promo-image-input').value = '';
  showPromoImage(null);
});

// Envia (ou remove) a imagem de fundo da promoção já salva e apaga a anterior.
async function savePromoImage(promo) {
  if (!promoImage.file && !promoImage.remove) return;
  const oldPath = photoPath(promo.image_url);
  let imageUrl = null;
  if (promoImage.file) {
    const bucket = supabase.storage.from(PHOTO_BUCKET);
    const path = `promos/${promo.id}/${Date.now()}.jpg`;
    const blob = await shrinkImage(promoImage.file, 1500, 0.85);
    const { error } = await bucket.upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000' });
    if (error) throw error;
    imageUrl = bucket.getPublicUrl(path).data.publicUrl;
  }
  if (!(await update('menu_promotions', promo.id, { image_url: imageUrl }))) throw new Error('Falha ao salvar a imagem');
  promo.image_url = imageUrl;
  if (oldPath) await supabase.storage.from(PHOTO_BUCKET).remove([oldPath]);
}
const promoForm = $('promo-form');
let editingPromo = null;

function renderPromoItems(selected) {
  const f = promoForm.elements;
  const box = $('promo-items');
  box.hidden = f.all_items.checked;
  box.replaceChildren(...itemsOf(f.category_id.value).map((item) =>
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', value: item.id, checked: !selected || selected.includes(item.id) }),
      `${item.name} ${item.detail}`.trim(),
      h('span', { class: 'muted small' }, ` ${formatPrice(item.price)}`),
    ),
  ));
}

function openPromotion(promo) {
  editingPromo = promo;
  const f = promoForm.elements;
  $('promo-dialog-title').textContent = promo ? 'Editar promoção' : 'Nova promoção';
  $('promo-delete').hidden = !promo;
  $('promo-error').hidden = true;
  f.name.value = promo?.name ?? '';
  f.price.value = promo ? formatPrice(promo.price).replace(/^R\$\s?/, '') : '';
  f.start_time.value = promo ? promo.start_time.slice(0, 5) : '19:00';
  f.end_time.value = promo ? promo.end_time.slice(0, 5) : '21:00';
  f.active.checked = promo?.active ?? true;
  const days = promo?.days ?? [];
  $('promo-days').replaceChildren(...WEEKDAYS.map((label, day) =>
    h('label', { class: 'day-chip' }, h('input', { type: 'checkbox', value: day, checked: days.includes(day) }), label),
  ));
  f.category_id.replaceChildren(...categoriesSorted().map((c) => h('option', { value: c.id }, c.name)));
  f.category_id.value = promo?.category_id ?? categoriesSorted()[0]?.id;
  f.all_items.checked = !promo?.item_ids;
  renderPromoItems(promo?.item_ids ?? null);
  promoImage = { file: null, remove: false };
  $('promo-image-input').value = '';
  showPromoImage(promo?.image_url ?? null);
  promoDialog.showModal();
}

promoForm.elements.category_id.addEventListener('change', () => renderPromoItems(null));
promoForm.elements.all_items.addEventListener('change', () => {
  $('promo-items').hidden = promoForm.elements.all_items.checked;
});
promoDialog.querySelector('[data-close]').addEventListener('click', () => promoDialog.close());

function promoError(message) {
  $('promo-error').textContent = message;
  $('promo-error').hidden = false;
}

promoForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const f = promoForm.elements;
  const price = parsePrice(f.price.value);
  const days = [...$('promo-days').querySelectorAll('input:checked')].map((i) => Number(i.value));
  const itemIds = f.all_items.checked ? null : [...$('promo-items').querySelectorAll('input:checked')].map((i) => i.value);
  if (!f.name.value.trim()) return promoError('Dê um nome à promoção.');
  if (price === null) return promoError('Preço inválido. Use números, como 9,90.');
  if (!days.length) return promoError('Escolha pelo menos um dia da semana.');
  if (f.start_time.value === f.end_time.value) return promoError('O horário de início e de fim não podem ser iguais.');
  if (itemIds && !itemIds.length) return promoError('Escolha pelo menos um item, ou marque "Todos os itens da aba".');

  const row = {
    name: f.name.value.trim(),
    price,
    days,
    start_time: f.start_time.value,
    end_time: f.end_time.value,
    category_id: f.category_id.value,
    item_ids: itemIds,
    active: f.active.checked,
  };
  const query = editingPromo
    ? supabase.from('menu_promotions').update(row).eq('id', editingPromo.id).select().single()
    : supabase.from('menu_promotions').insert(row).select().single();
  const { data, error } = await query;
  if (error) {
    console.error(error);
    return promoError('Não salvou. Verifique a conexão e tente de novo.');
  }
  const wasNew = !editingPromo;
  const saved = editingPromo ? Object.assign(editingPromo, data) : data;
  if (wasNew) state.promotions.push(saved);
  editingPromo = saved;
  try {
    await savePromoImage(saved);
  } catch (imageError) {
    console.error(imageError);
    render();
    return promoError('A promoção foi salva, mas a imagem não. Tente enviar a imagem de novo.');
  }
  promoDialog.close();
  toast(wasNew ? 'Promoção criada' : 'Promoção salva');
  render();
});

$('promo-delete').addEventListener('click', async () => {
  if (!editingPromo || !confirm(`Excluir a promoção "${editingPromo.name}"?`)) return;
  const { error } = await supabase.from('menu_promotions').delete().eq('id', editingPromo.id);
  if (error) return promoError('Não foi possível excluir.');
  const oldPath = photoPath(editingPromo.image_url);
  if (oldPath) await supabase.storage.from(PHOTO_BUCKET).remove([oldPath]);
  state.promotions = state.promotions.filter((p) => p.id !== editingPromo.id);
  promoDialog.close();
  toast('Promoção excluída');
  render();
});

/* ---------- Edição de item ---------- */

const dialog = $('item-dialog');
const itemForm = $('item-form');
let editing = null; // item existente, ou null para novo
let photo = { file: null, remove: false }; // mudança de foto pendente até salvar

const PHOTO_BUCKET = 'menu-photos';

function showPhoto(url) {
  const preview = $('photo-preview');
  preview.hidden = !url;
  if (url) preview.src = url;
  else preview.removeAttribute('src');
  $('photo-remove').hidden = !url;
  $('photo-edit').hidden = !url;
  $('photo-pick-label').textContent = url ? 'Trocar foto' : 'Escolher foto';
}

$('photo-input').addEventListener('change', (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (file) openCropper(file);
});

$('photo-remove').addEventListener('click', () => {
  photo = { file: null, remove: true };
  showPhoto(null);
});

$('photo-edit').addEventListener('click', () => {
  openCropper(photo.file ?? editing?.image_url);
});

/* ---------- Recorte (quadrado) e troca de fundo ---------- */

const cropImg = $('crop-img');
const cropFrame = $('crop-frame');
const crop = { source: null, w: 0, h: 0, zoom: 1, x: 0, y: 0 };

async function toBlob(source) {
  if (source instanceof Blob) return source;
  const response = await fetch(source);
  if (!response.ok) throw new Error('Falha ao baixar a foto');
  return response.blob();
}

async function openCropper(source) {
  if (!source) return;
  try {
    crop.source = await toBlob(source);
  } catch (error) {
    console.error(error);
    return toast('Não foi possível abrir a foto para recortar.', true);
  }
  $('cropper').hidden = false;
  $('photo-field').hidden = true;
  $('crop-status').hidden = true;
  await loadCropImage(true);
}

async function loadCropImage(reset) {
  if (cropImg.src) URL.revokeObjectURL(cropImg.src);
  cropImg.src = URL.createObjectURL(crop.source);
  await cropImg.decode();
  crop.w = cropImg.naturalWidth;
  crop.h = cropImg.naturalHeight;
  if (reset) {
    crop.zoom = 1;
    $('crop-zoom').value = 1;
    const k = scale();
    crop.x = (frameSize() - crop.w * k) / 2;
    crop.y = (frameSize() - crop.h * k) / 2;
  }
  layoutCrop();
}

const frameSize = () => cropFrame.clientWidth;
// Escala que faz a foto cobrir o quadrado inteiro, vezes o zoom
const scale = () => (frameSize() / Math.min(crop.w, crop.h)) * crop.zoom;

function layoutCrop() {
  const k = scale();
  const size = frameSize();
  crop.x = Math.min(0, Math.max(size - crop.w * k, crop.x));
  crop.y = Math.min(0, Math.max(size - crop.h * k, crop.y));
  cropImg.style.width = `${crop.w * k}px`;
  cropImg.style.height = `${crop.h * k}px`;
  cropImg.style.transform = `translate(${crop.x}px, ${crop.y}px)`;
}

let drag = null;
cropFrame.addEventListener('pointerdown', (event) => {
  drag = { id: event.pointerId, x: event.clientX - crop.x, y: event.clientY - crop.y };
  cropFrame.setPointerCapture(event.pointerId);
});
cropFrame.addEventListener('pointermove', (event) => {
  if (!drag || drag.id !== event.pointerId) return;
  crop.x = event.clientX - drag.x;
  crop.y = event.clientY - drag.y;
  layoutCrop();
});
cropFrame.addEventListener('pointerup', () => (drag = null));
cropFrame.addEventListener('pointercancel', () => (drag = null));

$('crop-zoom').addEventListener('input', (event) => {
  // Mantém o centro do quadrado no mesmo ponto da foto ao mudar o zoom
  const half = frameSize() / 2;
  const before = scale();
  const cx = (half - crop.x) / before;
  const cy = (half - crop.y) / before;
  crop.zoom = Number(event.target.value);
  const after = scale();
  crop.x = half - cx * after;
  crop.y = half - cy * after;
  layoutCrop();
});

function closeCropper() {
  $('cropper').hidden = true;
  $('photo-field').hidden = false;
}

$('crop-cancel').addEventListener('click', closeCropper);

$('crop-apply').addEventListener('click', async () => {
  const k = scale();
  const side = frameSize() / k; // lado do recorte em pixels da foto original
  const out = Math.round(Math.min(1200, side));
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out, out);
  ctx.drawImage(cropImg, -crop.x / k, -crop.y / k, side, side, 0, 0, out, out);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  photo = { file: blob, remove: false };
  showPhoto(URL.createObjectURL(blob));
  closeCropper();
});

// Remove o fundo no próprio aparelho (sem servidor) e coloca fundo branco.
$('crop-bg').addEventListener('click', async () => {
  const button = $('crop-bg');
  const status = $('crop-status');
  button.disabled = true;
  status.hidden = false;
  status.textContent = 'Preparando… Na primeira vez baixa uns 55 MB (use Wi-Fi); depois fica guardado.';
  try {
    const { removeBackground } = await import('./vendor/bg-removal.js');
    const cutout = await removeBackground(crop.source, {
      model: 'small',
      output: { format: 'image/png' },
      progress: (key, current, total) => {
        if (key.startsWith('fetch') && total) status.textContent = `Baixando o removedor de fundo… ${Math.round((current / total) * 100)}%`;
        else if (key.startsWith('compute')) status.textContent = 'Removendo o fundo…';
      },
    });
    const img = new Image();
    img.src = URL.createObjectURL(cutout);
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(img.src);
    crop.source = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    await loadCropImage(false);
    status.textContent = 'Fundo trocado por branco. Ajuste o recorte e toque em "Usar esta foto".';
  } catch (error) {
    console.error(error);
    status.textContent = 'Não deu para remover o fundo neste aparelho. Você ainda pode recortar e usar a foto normal.';
  } finally {
    button.disabled = false;
  }
});

// Reduz a foto do celular (vários MB) para ~1200px em JPEG antes de enviar.
async function shrinkImage(file, max = 1200, quality = 0.82) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Falha ao converter a foto'))), 'image/jpeg', quality),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

function photoPath(url) {
  const marker = `/${PHOTO_BUCKET}/`;
  return url?.includes(marker) ? url.slice(url.indexOf(marker) + marker.length) : null;
}

// Aplica a foto pendente ao item já salvo: envia a foto grande (para abrir) e uma
// miniatura leve (para a lista), e apaga as antigas.
async function savePhoto(item) {
  if (!photo.file && !photo.remove) return;
  const oldPaths = [photoPath(item.image_url), photoPath(item.thumb_url)].filter(Boolean);
  const urls = { image_url: null, thumb_url: null };
  if (photo.file) {
    const stamp = Date.now();
    const bucket = supabase.storage.from(PHOTO_BUCKET);
    const versions = [
      ['image_url', `${item.id}/${stamp}.jpg`, await shrinkImage(photo.file, 1200, 0.82)],
      ['thumb_url', `${item.id}/${stamp}-p.jpg`, await shrinkImage(photo.file, 360, 0.78)],
    ];
    for (const [key, path, blob] of versions) {
      const { error } = await bucket.upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000' });
      if (error) throw error;
      urls[key] = bucket.getPublicUrl(path).data.publicUrl;
    }
  }
  if (!(await update('menu_items', item.id, urls))) throw new Error('Falha ao salvar a foto');
  Object.assign(item, urls);
  if (oldPaths.length) await supabase.storage.from(PHOTO_BUCKET).remove(oldPaths);
}

function openItem(item, categoryId) {
  editing = item;
  const f = itemForm.elements;
  $('item-dialog-title').textContent = item ? 'Editar item' : 'Novo item';
  $('item-delete').hidden = !item;
  $('item-error').hidden = true;
  f.category_id.replaceChildren(...categoriesSorted().map((c) => h('option', { value: c.id }, c.name)));
  f.name.value = item?.name ?? '';
  f.detail.value = item?.detail ?? '';
  f.description.value = item?.description ?? '';
  f.price.value = item ? formatPrice(item.price).replace(/^R\$\s?/, '') : '';
  f.promo_price.value = item?.promo_price !== null && item?.promo_price !== undefined
    ? formatPrice(item.promo_price).replace(/^R\$\s?/, '')
    : '';
  f.price2.value = item?.price2 !== null && item?.price2 !== undefined ? plain(item.price2) : '';
  f.badge.value = item?.badge ?? '';
  f.category_id.value = item?.category_id ?? categoryId;
  syncPriceLabels();
  f.available.checked = item?.available ?? true;
  f.visible.checked = item?.visible ?? true;
  photo = { file: null, remove: false };
  $('photo-input').value = '';
  closeCropper();
  showPhoto(item?.image_url ?? null);
  dialog.showModal();
  if (!item) f.name.focus();
}

// Mostra o campo do 2º preço só quando a aba escolhida tem duas colunas.
function syncPriceLabels() {
  const f = itemForm.elements;
  const category = state.categories.find((c) => c.id === f.category_id.value);
  $('price-label').textContent = category?.price_label ? `${category.price_label} (R$)` : 'Preço (R$)';
  $('price2-field').hidden = !category?.price2_label;
  $('price2-label').textContent = category?.price2_label ? `${category.price2_label} (R$)` : '';
}

itemForm.elements.category_id.addEventListener('change', syncPriceLabels);

const submitButton = itemForm.querySelector('button[type="submit"]');

dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());

function formError(message) {
  $('item-error').textContent = message;
  $('item-error').hidden = false;
}

itemForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const f = itemForm.elements;
  const price = parsePrice(f.price.value);
  const promoText = f.promo_price.value.trim();
  const promo_price = promoText ? parsePrice(promoText) : null;
  const price2Text = $('price2-field').hidden ? '' : f.price2.value.trim();
  const price2 = price2Text ? parsePrice(price2Text) : null;
  if (price === null) return formError('Preço inválido. Use números, como 14,50.');
  if (price2Text && price2 === null) return formError('Segundo preço inválido. Deixe vazio se não tiver.');
  if (promoText && promo_price === null) return formError('Preço promocional inválido. Deixe vazio para tirar a promoção.');
  if (promo_price !== null && promo_price >= price) return formError('O preço promocional precisa ser menor que o preço normal.');

  const row = {
    name: f.name.value.trim(),
    detail: f.detail.value.trim(),
    description: f.description.value.trim(),
    price,
    price2,
    promo_price,
    badge: f.badge.value || null,
    category_id: f.category_id.value,
    available: f.available.checked,
    visible: f.visible.checked,
  };
  if (!row.name) return formError('Dê um nome ao item.');

  if (editing && editing.category_id !== row.category_id) {
    row.position = nextPosition(row.category_id);
  }
  if (!editing) row.position = nextPosition(row.category_id);

  const query = editing
    ? supabase.from('menu_items').update(row).eq('id', editing.id).select().single()
    : supabase.from('menu_items').insert(row).select().single();
  const { data, error } = await query;
  if (error) {
    console.error(error);
    return formError('Não salvou. Verifique a conexão e tente de novo.');
  }
  const saved = editing ? Object.assign(editing, data) : data;
  if (!editing) state.items.push(saved);
  const wasNew = !editing;
  editing = saved;
  submitButton.disabled = true;
  try {
    await savePhoto(saved);
  } catch (photoError) {
    console.error(photoError);
    submitButton.disabled = false;
    render();
    return formError('O item foi salvo, mas a foto não. Tente enviar a foto de novo.');
  }
  submitButton.disabled = false;
  dialog.close();
  toast(wasNew ? 'Item adicionado' : 'Item salvo');
  render();
});

function nextPosition(categoryId) {
  const list = itemsOf(categoryId);
  return list.length ? Math.max(...list.map((i) => i.position)) + 1 : 0;
}

$('item-delete').addEventListener('click', async () => {
  if (!editing || !confirm(`Excluir "${editing.name} ${editing.detail}"? Não dá para desfazer.`.replace(' "?', '"?'))) return;
  const { error } = await supabase.from('menu_items').delete().eq('id', editing.id);
  if (error) return formError('Não foi possível excluir.');
  const oldPaths = [photoPath(editing.image_url), photoPath(editing.thumb_url)].filter(Boolean);
  if (oldPaths.length) await supabase.storage.from(PHOTO_BUCKET).remove(oldPaths);
  state.items = state.items.filter((i) => i.id !== editing.id);
  dialog.close();
  toast('Item excluído');
  render();
});

start();
