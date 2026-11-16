begin;

create schema kinotix_private;
revoke all on schema kinotix_private from public, anon, authenticated;
grant usage on schema kinotix_private to service_role;

create table kinotix_private.tv_pairings (
    id text primary key check (id ~ '^[A-Za-z0-9_-]{22}$'),
    read_hash text not null check (read_hash ~ '^[A-Za-z0-9_-]{43}$'),
    write_hash text not null check (write_hash ~ '^[A-Za-z0-9_-]{43}$'),
    challenge text not null check (challenge ~ '^[A-Za-z0-9_-]{43}$'),
    expires_at timestamptz not null,
    poll_after timestamptz not null,
    status text not null default 'pending' check (status in ('pending', 'ready', 'error')),
    code text check (octet_length(code) between 8 and 512 and code ~ '^[A-Za-z0-9._~-]+$'),
    check ((status = 'ready') = (code is not null))
);

create index tv_pairings_expiry on kinotix_private.tv_pairings (expires_at);

create table kinotix_private.tv_pairing_starts (
    minute timestamptz primary key,
    starts integer not null check (starts between 1 and 120)
);

alter table kinotix_private.tv_pairings enable row level security;
alter table kinotix_private.tv_pairing_starts enable row level security;
revoke all on all tables in schema kinotix_private from public, anon, authenticated;
grant select, insert, update, delete on kinotix_private.tv_pairings, kinotix_private.tv_pairing_starts
    to service_role;

create function public.kinotix_tv_pair_start(
    p_id text, p_read_hash text, p_write_hash text, p_challenge text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
    instant timestamptz;
    minute_bucket timestamptz;
    accepted integer;
begin
    -- Creation, cleanup and the global cap must be consistent across edge instances.
    perform pg_catalog.pg_advisory_xact_lock(1667752303, 921047);
    instant := pg_catalog.clock_timestamp();
    minute_bucket := pg_catalog.date_trunc('minute', instant);

    delete from kinotix_private.tv_pairings
        where expires_at <= instant;
    delete from kinotix_private.tv_pairing_starts
        where minute < minute_bucket - interval '1 minute';

    if (select count(*) from kinotix_private.tv_pairings) >= 600 then
        return false;
    end if;

    insert into kinotix_private.tv_pairing_starts as budget (minute, starts)
        values (minute_bucket, 1)
        on conflict (minute) do update set starts = budget.starts + 1
            where budget.starts < 120
        returning starts into accepted;
    if accepted is null then
        return false;
    end if;

    insert into kinotix_private.tv_pairings (id, read_hash, write_hash, challenge, expires_at, poll_after)
        values (p_id, p_read_hash, p_write_hash, p_challenge, instant + interval '5 minutes', instant)
        on conflict (id) do nothing;
    return found;
end;
$$;

create function public.kinotix_tv_pair_challenge(p_id text, p_write_hash text)
returns text
language sql
security invoker
set search_path = ''
as $$
    select pairing.challenge
    from kinotix_private.tv_pairings as pairing
    where pairing.id = p_id and pairing.write_hash = p_write_hash
        and pairing.status = 'pending' and pairing.expires_at > pg_catalog.statement_timestamp();
$$;

create function public.kinotix_tv_pair_complete(p_id text, p_write_hash text, p_code text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
    update kinotix_private.tv_pairings
        set status = case when p_code is null then 'error' else 'ready' end,
            code = p_code
        where id = p_id and write_hash = p_write_hash
            and status = 'pending' and expires_at > pg_catalog.clock_timestamp();

    return found;
end;
$$;

create function public.kinotix_tv_pair_poll(p_id text, p_read_hash text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    pairing kinotix_private.tv_pairings%rowtype;
    instant timestamptz;
begin
    select *
        into pairing
        from kinotix_private.tv_pairings
        where id = p_id and read_hash = p_read_hash
        for update;
    if not found then
        return pg_catalog.jsonb_build_object('status', 'expired');
    end if;

    instant := pg_catalog.clock_timestamp();
    if pairing.expires_at <= instant then
        delete from kinotix_private.tv_pairings where id = pairing.id;
        return pg_catalog.jsonb_build_object('status', 'expired');
    end if;
    if pairing.status = 'ready' then
        delete from kinotix_private.tv_pairings where id = pairing.id;
        return pg_catalog.jsonb_build_object('status', 'ready', 'code', pairing.code);
    end if;
    if pairing.status = 'error' then
        delete from kinotix_private.tv_pairings where id = pairing.id;
        return pg_catalog.jsonb_build_object('status', 'error');
    end if;
    if pairing.poll_after > instant then
        return pg_catalog.jsonb_build_object('status', 'rate_limited');
    end if;

    update kinotix_private.tv_pairings
        set poll_after = instant + interval '2 seconds'
        where id = pairing.id;
    return pg_catalog.jsonb_build_object('status', 'pending');
end;
$$;

revoke all on function public.kinotix_tv_pair_start(text, text, text, text) from public, anon, authenticated;
revoke all on function public.kinotix_tv_pair_challenge(text, text) from public, anon, authenticated;
revoke all on function public.kinotix_tv_pair_complete(text, text, text) from public, anon, authenticated;
revoke all on function public.kinotix_tv_pair_poll(text, text) from public, anon, authenticated;
grant execute on function public.kinotix_tv_pair_start(text, text, text, text) to service_role;
grant execute on function public.kinotix_tv_pair_challenge(text, text) to service_role;
grant execute on function public.kinotix_tv_pair_complete(text, text, text) to service_role;
grant execute on function public.kinotix_tv_pair_poll(text, text) to service_role;

commit;
