# SightLine

A self-organizing graph of visual references. Drop in posters, graphics and illustrations, and SightLine scores each one on formal visual language (line, shape, color, value, balance, movement…). Pick a filter and every image drifts into a web of clusters: straight-line images group together and shade toward jagged, then curved.

**New to the project?** Jump to [Team setup](#team-setup). Running the app takes about 5 minutes.

Design rationale: [DESIGN.md](DESIGN.md).

---

## How the pieces fit

```
                 ┌──────────────────────────── Supabase (hosted, shared by the team) ───────────────────────────┐
  your laptop    │                                                                                               │
  ┌───────────┐  │  Storage bucket "images"        Postgres + pgvector                Auto-generated REST API   │
  │ data/     │  │  originals/…  thumbs/…          categories, subclasses (taxonomy)   /rest/v1/<table>         │
  │  images/  │──┼─▶ (files)                        images (metrics, embeddings)        /rest/v1/rpc/<function>  │
  └───────────┘  │                                 scores, corrections                 /storage/v1/object/…     │
   pipeline/     │                                                                                               │
   batch.py ─────┼── writes with the SERVICE ROLE key (secret)                                                   │
                 └───────────────────────────────────────────────────────────────▲───────────────────────────────┘
                                                                                 │ reads + corrections
                                                                                 │ with the ANON key (public)
                                                                    web/ (Next.js + PixiJS + d3-force)
                                                                    runs on each teammate's machine
```

- **Supabase** is the single shared source of truth: image files, scores, embeddings, your labels.
- **The Python pipeline** turns image files into numbers and writes them to Supabase. It runs on whoever's laptop is adding images.
- **The web app** only reads from Supabase and draws the graph. It doesn't analyze anything itself.

---

## Team setup

There are two roles:

| Role | Who | What you need | Key you need (ask Felix) |
|---|---|---|---|
| **A. Run the app** | everyone | Node.js | **anon key** (shared in team chat) |
| **B. Add images** | whoever is curating | Node.js + uv | **service role key** (private DM only) |

You do **not** need Docker, a Supabase account, or Python installed separately.

### Step 0: install the tools

**Node.js 20 or newer** (includes npm). Check with `node -v`. If it's missing or older than v20, install the LTS version from [nodejs.org](https://nodejs.org).

> Use **npm** for this project, not yarn, pnpm or bun. The lockfile is `package-lock.json`.

**uv** (role B only). It manages Python for you. Check with `uv --version`; if it's missing:

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Open a new terminal afterwards so `uv` is on your PATH.

### A. Run the web app (everyone)

```bash
git clone https://github.com/Felix-Chang/sightline.git
cd sightline/web
cp .env.example .env.local
```

On Windows Command Prompt, use `copy .env.example .env.local` instead of `cp` (PowerShell accepts `cp`).

Open `web/.env.local` in your editor and paste the **anon key** after `NEXT_PUBLIC_SUPABASE_ANON_KEY=` (no quotes, no spaces). The URL is already filled in. Then:

```bash
npm install
npm run dev
```

Open **http://localhost:3000**.

**It worked if** you see the SightLine panel with "N references" and thumbnails. If it says *No images yet*, the app is fine; nobody has added images yet.

The anon key is safe to share in team chat: it can only read and add corrections. `npm install` may warn that `unrs-resolver` install scripts were blocked (npm 12+). Ignore that; lint and build work without it.

### B. Add images (curators)

Run these from the **repo root** (`sightline/`, not `sightline/web/`):

```bash
cd sightline
cp .env.example .env
```

Open `.env` and paste the **service role key** after `SUPABASE_SERVICE_ROLE_KEY=`. Then:

```bash
uv sync
mkdir -p data/images
```

(`mkdir data\images` on Windows.) Put images in `data/images/`. Subfolders are fine; jpg, png, webp, gif and heic all work. Then:

```bash
uv run python pipeline/batch.py data/images
```

**It worked if** it prints `[1/N] + filename` per image, ends with `added N … combined …`, and the images appear when teammates refresh the app.

- **The first run downloads about 5 GB of AI models** (SigLIP 2 + DINOv2, cached in `~/.cache/huggingface`). Do this on good wifi before the event. Later runs start in seconds.
- **Speed:** about 1.5 s per image on an M-series Mac or NVIDIA GPU, 5–10 s on CPU-only laptops.
- **The service role key is a secret.** It can write and delete everything. Keep it in `.env` only (git-ignored), and never paste it in chat, screenshots or code.
- **Re-running is safe:** images already in the database are skipped (matched by file hash), so curators can ingest overlapping folders.
- `data/` is git-ignored. Images live in Supabase Storage, not in the repo.

### Troubleshooting

| Symptom | Fix |
|---|---|
| Browser shows *supabaseUrl is required* or *Couldn't load data* | `web/.env.local` is missing or the key is wrong. Fix it, then **stop and restart `npm run dev`** (env files are only read at startup). |
| App loads but shows nothing / requests time out | The free Supabase project may be paused after a week idle. Tell Felix to click **Restore** in the dashboard. |
| `KeyError: 'SUPABASE_URL'` from `batch.py` | `.env` is missing at the repo root (it must sit next to `pyproject.toml`). |
| `can't open file … pipeline/batch.py` | You're in `web/`. `cd ..` to the repo root first. |
| `batch.py` prints `!` errors for some files | That file couldn't be read (corrupt or unsupported). The rest of the batch continues. |
| Port 3000 already in use | Next.js picks 3001 automatically; use the URL it prints. |
| `uv: command not found` right after installing | Open a new terminal window. |

### One-time: create the hosted project (already done by Felix; for reference)

1. Create a project at [supabase.com/dashboard](https://supabase.com/dashboard). The free tier is enough.
2. Install the CLI (`brew install supabase/tap/supabase`), then:
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>   # the ref is in the dashboard URL
   supabase db push                                  # creates tables, functions, the "images" bucket
   uv run python -c "import sys; sys.path.insert(0,'pipeline'); from db import seed_taxonomy; seed_taxonomy()"
   ```
3. Dashboard → **Project Settings → API**: copy the URL, the **anon** key (for everyone) and the **service_role** key (for curators).

`batch.py` also seeds the taxonomy on every run, so step 2's last line only matters if you want the filters to show before any images exist.

### Changing the schema or taxonomy

- **Taxonomy** (`seed/taxonomy.yaml`): edit, commit, and the next `batch.py` run upserts it. Re-scoring existing images after changing prompts or metrics requires deleting their scores (ask before doing this on the shared DB).
- **Tables / functions:** add a new file in `supabase/migrations/` (never edit an old one), commit, and one person runs `supabase db push`.

### Optional: work offline against a local copy

`supabase start` (needs Docker) runs Postgres + Storage locally at `http://127.0.0.1:54321`. `supabase status -o env` prints local keys for your `.env` files. Local data is yours alone and isn't shared with the team. Keep the cloud keys in `.env` / `web/.env.local` and the local ones in a copy like `.env.docker-local` (all `.env*` files are git-ignored), then swap files to switch.

---

## How the pipeline works

For each image, `batch.py` calls `Scorer.ingest()` in `pipeline/score_image.py`:

| # | Step | Code | Stored where |
|---|---|---|---|
| 1 | Hash the file (SHA-256) and skip it if already stored | `score_image.py` | `images.sha256` |
| 2 | Upload the original + a 256px WebP thumbnail | `score_image.py` | Storage bucket `images` |
| 3 | **Measure**: ~40 pixel metrics (brightness, hue histogram, mirror symmetry, Hough lines, edge orientation, saliency, FFT repetition…) | `pixel.py` | `images.metrics` (JSON), `scores` with `source='pixel'` |
| 4 | **Perceive**: SigLIP 2 image embedding, compared with text prompts for every subclass | `models.py` | `images.siglip` (vector), `scores` with `source='siglip'` |
| 5 | **Embed**: DINOv2 image embedding | `models.py` | `images.dino` (vector) |
| 6 | **Combine** (once per batch, over the whole collection) | `combine.py` | `scores` with `source='combined'`, `images.umap_x/y` |

**Why combine is collection-wide:** raw numbers live on different scales (brightness 0–1, cosine similarity ~0.05–0.15). Each raw score is converted to a **percentile across all images**, so "0.9 contrast" means "more contrast than 90% of the collection". Then the pixel and SigLIP percentiles are blended using each subclass's `weight` in `taxonomy.yaml`: 1.0 = pure pixel math, 0 = pure SigLIP. Because it's relative, every new batch reruns it for all images.

**Validation gate** (`validate.py`): you hand-label a sample (`absent / present / dominant`). For each subclass it measures agreement as AUC (0.5 = coin flip, 1.0 = perfect), and categories averaging ≥ 0.75 stay visible in the app. See *Hand labels* below.

### What the models do

There's **no LLM and no text generation** anywhere. Both models turn an image into a list of numbers (an embedding).

- **SigLIP 2** (`google/siglip2-so400m-patch14-384`, by Google) was trained on hundreds of millions of image + caption pairs, so images and sentences land in the *same* number space. We embed each subclass's prompts once (e.g. Line → Jagged: *"a graphic made of sharp zigzag lines"*), then score an image by how close its embedding is to those prompt embeddings. This lets us detect perceptual qualities ("implied line", "swirling movement") that pixel math can't, **without training anything**. Editing the prompts in `taxonomy.yaml` changes what it looks for.
- **DINOv2** (`facebook/dinov2-base`, by Meta) is image-only and self-supervised, and it's strong on structure and composition. It doesn't produce scores yet. It's stored so we can (a) find "structurally similar" neighbors via `match_images`, and (b) later train small per-subclass classifiers ("probes") on your corrections, so SightLine learns your eye.
- **Pixel math** (`pixel.py`, OpenCV + numpy) isn't a model. It's deterministic arithmetic and always gives the same answer, so it's used wherever a quality is directly measurable (brightness, color temperature, symmetry, texture).

Models run locally (Apple Silicon GPU via MPS, CUDA, or CPU). Nothing is sent to an AI API.

---

## Is there a REST API?

**Yes, Supabase auto-generates one** from the database (PostgREST). There's no custom backend: the web app calls these endpoints directly through `@supabase/supabase-js`. Every request needs the `apikey` header.

```bash
URL=https://<ref>.supabase.co
KEY=<anon key>

# all images (paged: 1000 rows max per request; use Range or limit/offset)
curl "$URL/rest/v1/images?select=id,filename,thumb_path&order=created_at" -H "apikey: $KEY"

# combined scores for one category
curl "$URL/rest/v1/scores?select=image_id,subclass_id,value&source=eq.combined&subclass_id=like.line.*" -H "apikey: $KEY"

# taxonomy
curl "$URL/rest/v1/subclasses?select=id,name,definition&category_id=eq.color" -H "apikey: $KEY"

# 12 nearest neighbors by DINOv2 embedding (Postgres function exposed as RPC)
curl -X POST "$URL/rest/v1/rpc/match_images" -H "apikey: $KEY" -H "Content-Type: application/json" \
  -d '{"query_id": "<image uuid>", "space": "dino", "k": 12}'

# add a correction (the only write the anon key allows)
curl -X POST "$URL/rest/v1/corrections" -H "apikey: $KEY" -H "Content-Type: application/json" \
  -d '{"image_id": "<uuid>", "subclass_id": "line.jagged", "label": "dominant"}'

# image files are public URLs
$URL/storage/v1/object/public/images/<thumb_path>
```

What's **not** an API yet: scoring. Analyzing an image needs the Python models, so it only happens through `batch.py`. The stretch goal in DESIGN.md is a small FastAPI `/upload` endpoint (`pipeline/server.py`) that calls the same `Scorer.ingest()`.

**Permissions** (row-level security, see `supabase/migrations/`): anon can read every table and insert into `corrections`. Everything else needs the service role key. Corrections are open to anyone who has the anon key, which is fine for a hackathon. Add auth before sharing the URL publicly.

---

## Hand labels → validation gate

```bash
# data/labels.csv: filename,subclass_id,label   (label = absent | present | dominant)
#   poster_01.jpg,line.jagged,dominant
#   poster_01.jpg,value.high_key,absent
uv run python pipeline/validate.py --labels data/labels.csv --dry-run   # report only
uv run python pipeline/validate.py --labels data/labels.csv             # also turn categories on/off
```

Subclass ids are `category.subclass` from the YAML. Labels made in the app (pin an image → absent/present/dominant) land in the same `corrections` table, so `validate.py` with no `--labels` re-evaluates using everything collected. Each subclass needs ≥ 6 labels with at least one positive and one negative.

## Using the app

- **All**: UMAP of every enabled score, so images with similar overall visual language sit together.
- **Filter pills**: the category's subclasses become anchors (a ring, or a left–right axis for spectrums like Value), and each image is pulled toward anchors in proportion to its scores. Red threads connect anchors to images that strongly have that quality.
- **Blend ↔ Separate**: how strongly images commit to their strongest quality.
- **measured / perceived** badges: whether a subclass uses pixel math or only SigLIP.
- Hover for scores. Click to pin and correct. Scroll to zoom, drag to pan, ← → to switch filters, Esc to unpin.

## Repo map

```
seed/taxonomy.yaml        categories, subclasses, prompts, pixel metric + weight
pipeline/                 Python: pixel.py, models.py, score_image.py, batch.py, combine.py, validate.py, db.py
supabase/migrations/      schema, RLS policies, storage bucket, match_images()
web/src/lib/              data.ts (Supabase queries), layout.ts (anchor/UMAP/kNN math), graph-engine.ts (PixiJS + d3-force)
web/src/components/       Explorer.tsx (UI), Graph.tsx (canvas wrapper)
```
