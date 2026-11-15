begin;

create table public.kinotix_sync (
    user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
    kind text not null check (kind in ('catalog', 'progress')),
    item_id text not null,
    updated_at bigint not null check (updated_at > 0),
    value jsonb not null check (jsonb_typeof(value) = 'object' and octet_length(value::text) <= 20000),
    primary key (user_id, kind, item_id),
    check (
        (kind = 'catalog' and item_id ~ '^[a-z0-9][a-z0-9-]{0,30}$') or
        (kind = 'progress' and item_id ~ '^media:[a-f0-9]{64}$')
    )
);

alter table public.kinotix_sync enable row level security;
revoke all on public.kinotix_sync from public, anon, authenticated;
grant select, insert, update on public.kinotix_sync to authenticated;
create policy "KinoTix users read their own items"
    on public.kinotix_sync for select to authenticated
    using ((select auth.uid()) = user_id);
create policy "KinoTix users insert their own items"
    on public.kinotix_sync for insert to authenticated
    with check ((select auth.uid()) = user_id);
create policy "KinoTix users update their own items"
    on public.kinotix_sync for update to authenticated
    using ((select auth.uid()) = user_id)
    with check ((select auth.uid()) = user_id);

create index kinotix_sync_recent on public.kinotix_sync (user_id, kind, updated_at desc);

create function public.kinotix_merge(p_items jsonb)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
    if auth.uid() is null then
        raise exception 'Authentication required' using errcode = '28000';
    end if;
    if jsonb_typeof(p_items) is distinct from 'array' then
        raise exception 'Expected a list' using errcode = '22023';
    end if;
    if jsonb_array_length(p_items) > 100 then
        raise exception 'Batch exceeds 100 items' using errcode = '22023';
    end if;
    insert into public.kinotix_sync (user_id, kind, item_id, updated_at, value)
        select auth.uid(), item.kind, item.item_id, item.updated_at, item.value
        from jsonb_to_recordset(p_items) as item(kind text, item_id text, updated_at bigint, value jsonb)
        where item.updated_at <= extract(epoch from statement_timestamp() + interval '5 minutes') * 1000
    on conflict (user_id, kind, item_id) do update
        set updated_at = excluded.updated_at, value = excluded.value
        where public.kinotix_sync.updated_at < excluded.updated_at;
end;
$$;

revoke all on function public.kinotix_merge(jsonb) from public, anon, authenticated;
grant execute on function public.kinotix_merge(jsonb) to authenticated;

commit;
