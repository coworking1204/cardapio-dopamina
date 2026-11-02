-- Pedidos beta do Dopamina.
-- O cliente não precisa de conta. As tabelas ficam fechadas pela RLS e o público
-- acessa apenas as operações mínimas expostas por funções validadas.

create schema if not exists private;

create sequence if not exists public.order_number_seq start with 1000;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  pickup_token_hash bytea not null unique,
  customer_name text not null check (char_length(customer_name) between 2 and 80),
  customer_phone text not null check (customer_phone ~ '^[0-9]{10,13}$'),
  status text not null default 'created' check (status in ('created', 'redeemed', 'cancelled', 'expired')),
  payment_status text not null default 'sandbox' check (payment_status in ('sandbox', 'pending', 'paid', 'failed', 'refunded')),
  item_count integer not null check (item_count between 1 and 200),
  subtotal numeric(10, 2) not null check (subtotal >= 0),
  total numeric(10, 2) not null check (total >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '12 hours'),
  redeemed_at timestamptz,
  check (expires_at > created_at)
);

create table if not exists public.order_items (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders (id) on delete cascade,
  menu_item_id uuid references public.menu_items (id) on delete set null,
  item_name text not null,
  item_detail text not null default '',
  variant text not null check (variant in ('price', 'price2')),
  variant_label text not null default '',
  unit_price numeric(10, 2) not null check (unit_price >= 0),
  quantity integer not null check (quantity between 1 and 20),
  line_total numeric(10, 2) generated always as (unit_price * quantity) stored
);

create index if not exists order_items_order_id_idx on public.order_items (order_id);
create index if not exists order_items_menu_item_id_idx on public.order_items (menu_item_id);
create index if not exists orders_status_created_at_idx on public.orders (status, created_at desc);
create index if not exists orders_expires_at_created_idx on public.orders (expires_at) where status = 'created';

alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.orders force row level security;
alter table public.order_items force row level security;

drop policy if exists "orders_no_direct_access" on public.orders;
create policy "orders_no_direct_access" on public.orders
  for all to anon, authenticated
  using (false) with check (false);

drop policy if exists "order_items_no_direct_access" on public.order_items;
create policy "order_items_no_direct_access" on public.order_items
  for all to anon, authenticated
  using (false) with check (false);

revoke all on public.orders, public.order_items from public, anon, authenticated;
revoke all on sequence public.order_number_seq from public, anon, authenticated;

-- Preço oficial calculado no servidor. Promoções programadas usam o horário de Brasília.
create or replace function private.menu_item_price(
  p_item_id uuid,
  p_variant text
)
returns table (
  item_name text,
  item_detail text,
  variant_label text,
  unit_price numeric
)
language sql
stable
security definer
set search_path = ''
as $$
  with clock as (
    select
      extract(dow from now() at time zone 'America/Sao_Paulo')::integer as weekday,
      (now() at time zone 'America/Sao_Paulo')::time as local_time
  ), valid_item as (
    select
      i.id,
      i.category_id,
      i.name,
      i.detail,
      i.price,
      i.price2,
      i.promo_price,
      c.price_label,
      c.price2_label
    from public.menu_items i
    join public.menu_categories c on c.id = i.category_id
    where i.id = p_item_id
      and i.visible
      and i.available
      and c.visible
  ), scheduled as (
    select min(p.price) as price
    from public.menu_promotions p
    join valid_item i on i.category_id = p.category_id
    cross join clock c
    where p.active
      and c.weekday = any (p.days)
      and (
        (p.start_time <= p.end_time and c.local_time >= p.start_time and c.local_time < p.end_time)
        or (p.start_time > p.end_time and (c.local_time >= p.start_time or c.local_time < p.end_time))
      )
      and (p.item_ids is null or i.id = any (p.item_ids))
  )
  select
    i.name,
    i.detail,
    case
      when p_variant = 'price2' then coalesce(nullif(trim(i.price2_label), ''), 'Opção 2')
      else coalesce(nullif(trim(i.price_label), ''), 'Unidade')
    end,
    case
      when p_variant = 'price2' then i.price2
      else least(i.price, coalesce(i.promo_price, i.price), coalesce(s.price, i.price))
    end
  from valid_item i
  cross join scheduled s
  where p_variant = 'price'
     or (p_variant = 'price2' and i.price2 is not null);
$$;

create or replace function private.create_guest_order(
  p_customer_name text,
  p_customer_phone text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := trim(regexp_replace(coalesce(p_customer_name, ''), '\s+', ' ', 'g'));
  v_phone text := regexp_replace(coalesce(p_customer_phone, ''), '\D', '', 'g');
  v_order_id uuid;
  v_code text;
  v_token text := encode(extensions.gen_random_bytes(24), 'hex');
  v_item jsonb;
  v_item_id uuid;
  v_variant text;
  v_quantity integer;
  v_name_snapshot text;
  v_detail_snapshot text;
  v_variant_label text;
  v_unit_price numeric(10, 2);
  v_item_count integer := 0;
  v_total numeric(10, 2) := 0;
  v_created_at timestamptz;
  v_expires_at timestamptz;
begin
  if char_length(v_name) not between 2 and 80 then
    raise exception 'Nome inválido';
  end if;
  if v_phone !~ '^[0-9]{10,13}$' then
    raise exception 'WhatsApp inválido';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 30 then
    raise exception 'Pedido vazio ou muito grande';
  end if;

  v_code := 'D' || lpad(nextval('public.order_number_seq')::text, 6, '0');
  insert into public.orders (
    code, pickup_token_hash, customer_name, customer_phone, item_count, subtotal, total
  ) values (
    v_code, extensions.digest(v_token, 'sha256'), v_name, v_phone, 1, 0, 0
  ) returning id, created_at, expires_at into v_order_id, v_created_at, v_expires_at;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    begin
      v_item_id := (v_item ->> 'item_id')::uuid;
      v_variant := coalesce(v_item ->> 'variant', 'price');
      v_quantity := (v_item ->> 'quantity')::integer;
    exception when others then
      raise exception 'Item inválido';
    end;

    if v_variant not in ('price', 'price2') or v_quantity not between 1 and 20 then
      raise exception 'Item inválido';
    end if;

    select p.item_name, p.item_detail, p.variant_label, p.unit_price
      into v_name_snapshot, v_detail_snapshot, v_variant_label, v_unit_price
    from private.menu_item_price(v_item_id, v_variant) p;

    if v_unit_price is null then
      raise exception 'Produto indisponível';
    end if;

    insert into public.order_items (
      order_id, menu_item_id, item_name, item_detail, variant,
      variant_label, unit_price, quantity
    ) values (
      v_order_id, v_item_id, v_name_snapshot, v_detail_snapshot, v_variant,
      v_variant_label, v_unit_price, v_quantity
    );

    v_item_count := v_item_count + v_quantity;
    v_total := v_total + (v_unit_price * v_quantity);
  end loop;

  if v_item_count > 200 then
    raise exception 'Pedido muito grande';
  end if;

  update public.orders
  set item_count = v_item_count, subtotal = v_total, total = v_total
  where id = v_order_id;

  return jsonb_build_object(
    'code', v_code,
    'token', v_token,
    'status', 'created',
    'payment_status', 'sandbox',
    'quantity', v_item_count,
    'total', v_total,
    'created_at', v_created_at,
    'expires_at', v_expires_at
  );
end;
$$;

create or replace function private.get_guest_order(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'code', o.code,
    'status', case when o.status = 'created' and o.expires_at <= now() then 'expired' else o.status end,
    'payment_status', o.payment_status,
    'customer_name', o.customer_name,
    'quantity', o.item_count,
    'total', o.total,
    'created_at', o.created_at,
    'expires_at', o.expires_at,
    'redeemed_at', o.redeemed_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', i.item_name,
        'detail', i.item_detail,
        'variant', i.variant_label,
        'quantity', i.quantity,
        'unit_price', i.unit_price,
        'line_total', i.line_total
      ) order by i.id)
      from public.order_items i
      where i.order_id = o.id
    ), '[]'::jsonb)
  )
  from public.orders o
  where char_length(coalesce(p_token, '')) = 48
    and o.pickup_token_hash = extensions.digest(p_token, 'sha256')
  limit 1;
$$;

create or replace function private.redeem_guest_order(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  if not public.has_menu_key() then
    raise exception 'Acesso não autorizado';
  end if;

  update public.orders
  set status = 'redeemed', redeemed_at = now()
  where char_length(coalesce(p_token, '')) = 48
    and pickup_token_hash = extensions.digest(p_token, 'sha256')
    and status = 'created'
    and expires_at > now()
  returning * into v_order;

  if found then
    return jsonb_build_object(
      'ok', true,
      'code', v_order.code,
      'status', v_order.status,
      'redeemed_at', v_order.redeemed_at
    );
  end if;

  select * into v_order
  from public.orders
  where char_length(coalesce(p_token, '')) = 48
    and pickup_token_hash = extensions.digest(p_token, 'sha256')
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  elsif v_order.status = 'redeemed' then
    return jsonb_build_object('ok', false, 'reason', 'already_redeemed', 'code', v_order.code, 'redeemed_at', v_order.redeemed_at);
  elsif v_order.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired', 'code', v_order.code);
  else
    return jsonb_build_object('ok', false, 'reason', v_order.status, 'code', v_order.code);
  end if;
end;
$$;

create or replace function private.list_open_orders(p_limit integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.has_menu_key() then
    raise exception 'Acesso não autorizado';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'code', q.code,
      'customer_name', q.customer_name,
      'quantity', q.item_count,
      'total', q.total,
      'created_at', q.created_at,
      'expires_at', q.expires_at
    ) order by q.created_at desc)
    from (
      select o.code, o.customer_name, o.item_count, o.total, o.created_at, o.expires_at
      from public.orders o
      where o.status = 'created'
        and o.expires_at > now()
      order by o.created_at desc
      limit least(greatest(coalesce(p_limit, 30), 1), 100)
    ) q
  ), '[]'::jsonb);
end;
$$;

create or replace function private.get_staff_order(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not public.has_menu_key() then
    raise exception 'Acesso não autorizado';
  end if;

  select jsonb_build_object(
    'code', o.code,
    'status', case when o.status = 'created' and o.expires_at <= now() then 'expired' else o.status end,
    'payment_status', o.payment_status,
    'customer_name', o.customer_name,
    'customer_phone', o.customer_phone,
    'quantity', o.item_count,
    'total', o.total,
    'created_at', o.created_at,
    'expires_at', o.expires_at,
    'redeemed_at', o.redeemed_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', i.item_name,
        'detail', i.item_detail,
        'variant', i.variant_label,
        'quantity', i.quantity,
        'unit_price', i.unit_price,
        'line_total', i.line_total
      ) order by i.id)
      from public.order_items i
      where i.order_id = o.id
    ), '[]'::jsonb)
  ) into v_result
  from public.orders o
  where upper(o.code) = upper(trim(coalesce(p_code, '')))
  limit 1;

  return v_result;
end;
$$;

create or replace function private.redeem_guest_order_by_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
begin
  if not public.has_menu_key() then
    raise exception 'Acesso não autorizado';
  end if;

  update public.orders
  set status = 'redeemed', redeemed_at = now()
  where upper(code) = upper(trim(coalesce(p_code, '')))
    and status = 'created'
    and expires_at > now()
  returning * into v_order;

  if found then
    return jsonb_build_object(
      'ok', true,
      'code', v_order.code,
      'status', v_order.status,
      'redeemed_at', v_order.redeemed_at
    );
  end if;

  select * into v_order
  from public.orders
  where upper(code) = upper(trim(coalesce(p_code, '')))
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  elsif v_order.status = 'redeemed' then
    return jsonb_build_object('ok', false, 'reason', 'already_redeemed', 'code', v_order.code, 'redeemed_at', v_order.redeemed_at);
  elsif v_order.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired', 'code', v_order.code);
  else
    return jsonb_build_object('ok', false, 'reason', v_order.status, 'code', v_order.code);
  end if;
end;
$$;

-- Wrappers do Data API: sem privilégios elevados; toda a lógica privilegiada fica fora do schema exposto.
create or replace function public.create_guest_order(
  p_customer_name text,
  p_customer_phone text,
  p_items jsonb
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.create_guest_order(p_customer_name, p_customer_phone, p_items); $$;

create or replace function public.get_guest_order(p_token text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$ select private.get_guest_order(p_token); $$;

create or replace function public.redeem_guest_order(p_token text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.redeem_guest_order(p_token); $$;

create or replace function public.list_open_orders(p_limit integer default 30)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$ select private.list_open_orders(p_limit); $$;

create or replace function public.get_staff_order(p_code text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$ select private.get_staff_order(p_code); $$;

create or replace function public.redeem_guest_order_by_code(p_code text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.redeem_guest_order_by_code(p_code); $$;

revoke all on function private.menu_item_price(uuid, text) from public;
revoke all on function private.create_guest_order(text, text, jsonb) from public;
revoke all on function private.get_guest_order(text) from public;
revoke all on function private.redeem_guest_order(text) from public;
revoke all on function private.list_open_orders(integer) from public;
revoke all on function private.get_staff_order(text) from public;
revoke all on function private.redeem_guest_order_by_code(text) from public;
revoke all on function public.create_guest_order(text, text, jsonb) from public;
revoke all on function public.get_guest_order(text) from public;
revoke all on function public.redeem_guest_order(text) from public;
revoke all on function public.list_open_orders(integer) from public;
revoke all on function public.get_staff_order(text) from public;
revoke all on function public.redeem_guest_order_by_code(text) from public;

grant usage on schema private to anon, authenticated;
grant execute on function private.create_guest_order(text, text, jsonb) to anon, authenticated;
grant execute on function private.get_guest_order(text) to anon, authenticated;
grant execute on function private.redeem_guest_order(text) to anon, authenticated;
grant execute on function private.list_open_orders(integer) to anon, authenticated;
grant execute on function private.get_staff_order(text) to anon, authenticated;
grant execute on function private.redeem_guest_order_by_code(text) to anon, authenticated;
grant execute on function public.create_guest_order(text, text, jsonb) to anon, authenticated;
grant execute on function public.get_guest_order(text) to anon, authenticated;
grant execute on function public.redeem_guest_order(text) to anon, authenticated;
grant execute on function public.list_open_orders(integer) to anon, authenticated;
grant execute on function public.get_staff_order(text) to anon, authenticated;
grant execute on function public.redeem_guest_order_by_code(text) to anon, authenticated;

-- Função interna de cálculo: só as rotinas privilegiadas precisam chamá-la.
revoke all on function private.menu_item_price(uuid, text) from anon, authenticated;

