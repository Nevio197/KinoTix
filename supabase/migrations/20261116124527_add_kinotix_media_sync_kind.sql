begin;

alter table public.kinotix_sync
    drop constraint kinotix_sync_kind_check,
    drop constraint kinotix_sync_check,
    add constraint kinotix_sync_kind_check check (kind in ('catalog', 'progress', 'media')),
    add constraint kinotix_sync_check check (
        (kind = 'catalog' and item_id ~ '^[a-z0-9][a-z0-9-]{0,30}$') or
        (kind in ('progress', 'media') and item_id ~ '^media:[a-f0-9]{64}$')
    ),
    add constraint kinotix_sync_media_value_check check (
        kind <> 'media' or (
            value = '{"removed":true}'::jsonb or (
                (not (value ? 'removed') or value -> 'removed' = 'false'::jsonb)
                and (value - array['url', 'title', 'removed']) = '{}'::jsonb
                and jsonb_typeof(value -> 'url') = 'string'
                and char_length(value ->> 'url') <= 4096
                and (value ->> 'url') ~ '^https://[^/?@[:space:][:cntrl:]#]+([/?][^[:space:][:cntrl:]#]*)?$'
                and (value ->> 'url') !~* '%(0[0-9a-f]|1[0-9a-f]|7f)'
                and strpos(value ->> 'url', chr(92)) = 0
                and jsonb_typeof(value -> 'title') = 'string'
                and char_length(value ->> 'title') <= 150
                and (value ->> 'title') !~ '(^[[:space:]]*$|[[:cntrl:]])'
            )
        ) is true
    );

commit;
