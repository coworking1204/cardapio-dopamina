-- Cardápio online: tabelas, permissões e dados iniciais.
-- Rode este arquivo inteiro no SQL Editor do Supabase (uma vez).

create extension if not exists pgcrypto;
create schema if not exists private;

-- Configurações gerais (sempre uma única linha, id = 1)
create table if not exists public.menu_settings (
  id int primary key default 1 check (id = 1),
  bar_name text not null default 'Dopamina',
  tagline text not null default '',
  notice_text text not null default '',
  notice_active boolean not null default false,
  footer_text text not null default '',
  updated_at timestamptz not null default now()
);

insert into public.menu_settings (id) values (1) on conflict (id) do nothing;

-- Quem pode editar o cardápio
create table if not exists public.menu_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  position int not null default 0,
  visible boolean not null default true,
  -- Nomes das colunas de preço; com price2_label preenchido a aba mostra dois preços
  price_label text not null default '',
  price2_label text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.menu_items (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.menu_categories (id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  detail text not null default '',
  description text not null default '',
  price numeric(10, 2) not null default 0 check (price >= 0),
  price2 numeric(10, 2) check (price2 >= 0),
  image_url text,
  thumb_url text,
  promo_price numeric(10, 2) check (promo_price >= 0),
  badge text check (badge in ('novo', 'mais_pedido', 'promo')),
  available boolean not null default true,
  visible boolean not null default true,
  position int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists menu_items_category_position_idx
  on public.menu_items (category_id, position);

-- Chave do link secreto de edição (admin.html#chave=...). Ninguém lê esta tabela pela API.
create table if not exists public.menu_secret (
  id int primary key default 1 check (id = 1),
  key text not null
);
alter table public.menu_secret enable row level security;
revoke all on public.menu_secret from anon, authenticated;
drop policy if exists "menu_secret_no_direct_access" on public.menu_secret;
create policy "menu_secret_no_direct_access" on public.menu_secret
  for all to anon, authenticated using (false) with check (false);
insert into public.menu_secret (id, key) values (1, encode(gen_random_bytes(18), 'hex')) on conflict (id) do nothing;

-- A página de edição manda a chave no cabeçalho x-menu-key
create or replace function private.has_menu_key()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.menu_secret s
    where s.key = (nullif(current_setting('request.headers', true), '')::json ->> 'x-menu-key')
  );
$$;

create or replace function public.has_menu_key()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$ select private.has_menu_key(); $$;

-- Chave independente para a equipe de retirada. Ela não permite editar o cardápio.
create table if not exists private.staff_secret (
  id int primary key default 1 check (id = 1),
  key text not null
);
revoke all on private.staff_secret from public, anon, authenticated;
insert into private.staff_secret (id, key)
values (1, encode(extensions.gen_random_bytes(18), 'hex'))
on conflict (id) do nothing;

create or replace function private.has_staff_key()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_menu_key() or exists (
    select 1 from private.staff_secret s
    where s.key = (nullif(current_setting('request.headers', true), '')::json ->> 'x-scanner-key')
  );
$$;

create or replace function public.has_staff_key()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$ select private.has_staff_key(); $$;

-- Pode editar quem tem a chave do link (ou um usuário em menu_admins)
create or replace function private.is_menu_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_menu_key()
    or exists (select 1 from public.menu_admins where user_id = (select auth.uid()));
$$;

create or replace function public.is_menu_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$ select private.is_menu_admin(); $$;

-- Qualquer mudança em abas/itens "carimba" menu_settings.updated_at.
-- A página pública escuta só essa linha e recarrega o cardápio,
-- inclusive quando um item é escondido (o que o Realtime não entregaria).
create or replace function public.touch_menu()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.menu_settings set updated_at = now() where id = 1;
  return null;
end;
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists menu_items_set_updated_at on public.menu_items;
create trigger menu_items_set_updated_at
  before update on public.menu_items
  for each row execute function public.set_updated_at();

drop trigger if exists menu_settings_set_updated_at on public.menu_settings;
create trigger menu_settings_set_updated_at
  before update on public.menu_settings
  for each row execute function public.set_updated_at();

drop trigger if exists menu_items_touch on public.menu_items;
create trigger menu_items_touch
  after insert or update or delete on public.menu_items
  for each statement execute function public.touch_menu();

drop trigger if exists menu_categories_touch on public.menu_categories;
create trigger menu_categories_touch
  after insert or update or delete on public.menu_categories
  for each statement execute function public.touch_menu();

-- Segurança (RLS): o público só lê o que está visível; só admins editam
alter table public.menu_settings enable row level security;
alter table public.menu_admins enable row level security;
alter table public.menu_categories enable row level security;
alter table public.menu_items enable row level security;

drop policy if exists "settings_read" on public.menu_settings;
create policy "settings_read" on public.menu_settings
  for select to anon, authenticated using (true);

drop policy if exists "settings_admin_update" on public.menu_settings;
create policy "settings_admin_update" on public.menu_settings
  for update to anon, authenticated
  using (public.is_menu_admin()) with check (public.is_menu_admin());

drop policy if exists "admins_read_self" on public.menu_admins;
create policy "admins_read_self" on public.menu_admins
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists "categories_read" on public.menu_categories;
create policy "categories_read" on public.menu_categories
  for select to anon, authenticated
  using (visible or public.is_menu_admin());

drop policy if exists "categories_admin_write" on public.menu_categories;
create policy "categories_admin_write" on public.menu_categories
  for all to anon, authenticated
  using (public.is_menu_admin()) with check (public.is_menu_admin());

drop policy if exists "items_read" on public.menu_items;
create policy "items_read" on public.menu_items
  for select to anon, authenticated
  using (
    public.is_menu_admin()
    or (
      visible
      and exists (
        select 1 from public.menu_categories c
        where c.id = category_id and c.visible
      )
    )
  );

drop policy if exists "items_admin_write" on public.menu_items;
create policy "items_admin_write" on public.menu_items
  for all to anon, authenticated
  using (public.is_menu_admin()) with check (public.is_menu_admin());

grant select on public.menu_settings, public.menu_categories, public.menu_items to anon, authenticated;
grant update on public.menu_settings to anon, authenticated;
grant insert, update, delete on public.menu_categories, public.menu_items to anon, authenticated;
grant select on public.menu_admins to authenticated;
grant execute on function public.is_menu_admin() to anon, authenticated;
grant execute on function public.has_menu_key() to anon, authenticated;
grant execute on function public.has_staff_key() to anon, authenticated;
grant usage on schema private to anon, authenticated;
grant execute on function private.is_menu_admin() to anon, authenticated;
grant execute on function private.has_menu_key() to anon, authenticated;
grant execute on function private.has_staff_key() to anon, authenticated;
-- Funções de gatilho não devem ser chamáveis pela API
revoke execute on function public.touch_menu() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- Atualização em tempo real da página pública
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'menu_settings'
  ) then
    alter publication supabase_realtime add table public.menu_settings;
  end if;
end;
$$;

-- Dados iniciais (só entram se o cardápio estiver vazio)
do $$
declare
  cervejas uuid;
  nao_alcoolicas uuid;
begin
  if exists (select 1 from public.menu_categories) then
    return;
  end if;

  insert into public.menu_categories (name, position) values ('Cervejas', 0) returning id into cervejas;
  insert into public.menu_categories (name, position) values ('Não alcoólicas', 1) returning id into nao_alcoolicas;
  insert into public.menu_categories (name, position) values
    ('Drinks', 2), ('Copões', 3), ('Doses', 4), ('Comidas', 5);

  insert into public.menu_items (category_id, name, detail, price, position) values
    (cervejas, 'Antartica Boa', 'Litrão', 14.50, 0),
    (cervejas, 'Budweiser', '600ml', 15.00, 1),
    (cervejas, 'Budweiser', 'Litrão', 18.00, 2),
    (cervejas, 'Brahma', '600ml', 14.00, 3),
    (cervejas, 'Corona', 'Longneck', 13.00, 4),
    (cervejas, 'Corona Long', 'Zero', 13.00, 5),
    (cervejas, 'Stella', 'Longneck', 13.00, 6),
    (cervejas, 'Budweiser', 'Longneck', 13.00, 7),
    (nao_alcoolicas, 'Água', 'Sem gás', 3.50, 0),
    (nao_alcoolicas, 'Água', 'Com gás', 4.00, 1),
    (nao_alcoolicas, 'Coca', 'Lata', 7.00, 2),
    (nao_alcoolicas, 'Coca Zero', 'Lata', 7.00, 3),
    (nao_alcoolicas, 'Pepsi', 'Lata', 7.00, 4),
    (nao_alcoolicas, 'Guaraná', 'Lata', 7.00, 5),
    (nao_alcoolicas, 'Guaraná Zero', 'Lata', 7.00, 6),
    (nao_alcoolicas, 'H2O', 'Limão/Limoneto', 9.00, 7),
    (nao_alcoolicas, 'Água Tônica', '', 8.00, 8);
end;
$$;

-- Fotos dos itens: leitura pública; enviar, trocar e apagar só com a chave de edição
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-photos', 'menu-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "menu_photos_select" on storage.objects;
create policy "menu_photos_select" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'menu-photos' and public.is_menu_admin());

drop policy if exists "menu_photos_insert" on storage.objects;
create policy "menu_photos_insert" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'menu-photos' and public.is_menu_admin());

drop policy if exists "menu_photos_update" on storage.objects;
create policy "menu_photos_update" on storage.objects
  for update to anon, authenticated
  using (bucket_id = 'menu-photos' and public.is_menu_admin())
  with check (bucket_id = 'menu-photos' and public.is_menu_admin());

drop policy if exists "menu_photos_delete" on storage.objects;
create policy "menu_photos_delete" on storage.objects
  for delete to anon, authenticated
  using (bucket_id = 'menu-photos' and public.is_menu_admin());

-- Promoções programadas (repetem toda semana; horários no fuso de Brasília)
create table if not exists public.menu_promotions (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  price numeric(10, 2) not null check (price >= 0),
  -- 0 = domingo ... 6 = sábado
  days int[] not null default '{}' check (days <@ array[0, 1, 2, 3, 4, 5, 6]),
  start_time time not null,
  end_time time not null,
  category_id uuid not null references public.menu_categories (id) on delete cascade,
  -- null = todos os itens da aba
  item_ids uuid[],
  active boolean not null default true,
  -- imagem de fundo do card (1500 × 500)
  image_url text,
  created_at timestamptz not null default now()
);

create index if not exists menu_promotions_category_id_idx
  on public.menu_promotions (category_id);

alter table public.menu_promotions enable row level security;

drop policy if exists "promotions_read" on public.menu_promotions;
create policy "promotions_read" on public.menu_promotions
  for select to anon, authenticated
  using (active or public.is_menu_admin());

drop policy if exists "promotions_admin_write" on public.menu_promotions;
create policy "promotions_admin_write" on public.menu_promotions
  for all to anon, authenticated
  using (public.is_menu_admin()) with check (public.is_menu_admin());

grant select, insert, update, delete on public.menu_promotions to anon, authenticated;

drop trigger if exists menu_promotions_touch on public.menu_promotions;
create trigger menu_promotions_touch
  after insert or update or delete on public.menu_promotions
  for each statement execute function public.touch_menu();
