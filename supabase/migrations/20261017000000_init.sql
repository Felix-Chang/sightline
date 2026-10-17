-- SightLine schema: taxonomy (seeded), images + scores (pipeline), corrections (you).
create extension if not exists vector;

-- Taxonomy -------------------------------------------------------------------

create table categories (
  id text primary key,                 -- 'line', 'value', ...
  name text not null,
  kind text not null check (kind in ('spectrum', 'tags')),
  description text,
  enabled boolean not null default true, -- validate.py turns off categories that fail the gate
  sort int not null default 0
);

create table subclasses (
  id text primary key,                 -- 'line.jagged'
  category_id text not null references categories on delete cascade,
  name text not null,
  definition text not null,
  prompts text[] not null default '{}', -- SigLIP prompt ensemble
  anchor_order int not null default 0   -- position around the anchor ring (gradient order)
);

-- Images ---------------------------------------------------------------------

create table images (
  id uuid primary key default gen_random_uuid(),
  sha256 text unique not null,         -- dedupe on re-ingest
  storage_path text not null,          -- bucket 'images', original file
  thumb_path text not null,            -- bucket 'images', 256px thumbnail
  filename text,
  source_url text,
  width int,
  height int,
  metrics jsonb not null default '{}', -- raw pixel measurements (hover/debug)
  siglip vector(1152),                 -- SigLIP 2 so400m image embedding
  dino vector(768),                    -- DINOv2 base CLS embedding
  umap_x real,                         -- "All" view layout
  umap_y real,
  created_at timestamptz not null default now()
);

create table scores (
  image_id uuid not null references images on delete cascade,
  subclass_id text not null references subclasses on delete cascade,
  source text not null check (source in ('pixel', 'siglip', 'combined', 'probe')),
  value real not null,                 -- raw for pixel/siglip; 0..1 percentile for combined/probe
  primary key (image_id, subclass_id, source)
);
create index scores_source_idx on scores (source, subclass_id);

create table corrections (
  id bigserial primary key,
  image_id uuid not null references images on delete cascade,
  subclass_id text not null references subclasses on delete cascade,
  label text not null check (label in ('absent', 'present', 'dominant')),
  origin text not null default 'ui' check (origin in ('ui', 'handlabel')),
  created_at timestamptz not null default now()
);

create index images_siglip_idx on images using hnsw (siglip vector_cosine_ops);
create index images_dino_idx on images using hnsw (dino vector_cosine_ops);

-- Nearest neighbors by embedding ("more like this").
create function match_images(query_id uuid, space text default 'dino', k int default 12)
returns table (id uuid, distance real)
language sql stable as $$
  select i.id,
    (case when space = 'siglip' then i.siglip <=> q.siglip else i.dino <=> q.dino end)::real
  from images i, images q
  where q.id = query_id and i.id <> query_id
  order by 2
  limit k;
$$;

-- Access: the browser (anon) reads everything and may add corrections.
-- The Python pipeline uses the service role, which bypasses RLS.
alter table categories enable row level security;
alter table subclasses enable row level security;
alter table images enable row level security;
alter table scores enable row level security;
alter table corrections enable row level security;

create policy "public read" on categories for select using (true);
create policy "public read" on subclasses for select using (true);
create policy "public read" on images for select using (true);
create policy "public read" on scores for select using (true);
create policy "public read" on corrections for select using (true);
create policy "public insert" on corrections for insert with check (true);

-- Storage bucket for originals and thumbnails.
insert into storage.buckets (id, name, public)
values ('images', 'images', true)
on conflict (id) do nothing;

create policy "public read images" on storage.objects
  for select using (bucket_id = 'images');
