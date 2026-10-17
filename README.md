# SightLine

**A self-organizing graph of visual references, sorted by *how* images look rather than *what* they show.**

Reference libraries are usually filed by subject or vibe — "posters", "editorial", "stuff I like". SightLine files by **formal visual language** instead. Drop in posters, graphics and illustrations, and every image is scored on the vocabulary taught in a design foundations course: line, shape, form, space, color, value, texture, balance, contrast, emphasis, movement, rhythm and unity.

Pick a category and the collection rearranges itself. Under **Line**, straight-line images gather at one anchor and shade toward jagged, then curved. Nothing is tagged by hand — the scores come from pixel measurements and an image/text model, and each score is a percentile across the whole collection, so "0.9 curved" means *more curved than 90% of your references*.

### What you'll see

- **No filter (None)** — every image placed by UMAP over all of its scores, so overall visual language decides who sits near whom. Faint grey lines link each image to its two closest matches.
- **A category filter** — that category's subclasses become anchors in a ring (or a left–right axis for two-sided spectrums like Value). Each image is pulled toward the anchors in proportion to its scores, so pure examples land on an anchor and mixed ones float between. Colored threads run from each anchor to the images that strongly show that quality, and **every anchor has its own color** — matched by the score bars in the detail card.
- **Blend ↔ Separate** — how hard each image commits to its strongest quality. Blend keeps the nuance and clumps the collection; Separate exaggerates the winner and pulls clusters apart.
- **Hover or click an image** for its scores. Scroll to zoom, drag to pan, ← → to change filter, Esc to unpin.

> **New to the project?** Jump to [Quick start](#quick-start) — about 5 minutes to get the app running.

Design rationale: [DESIGN.md](DESIGN.md).

---

## How the pieces fit

```
                 ┌──────────────────────────── Supabase (hosted, shared by the team) ───────────────────────────┐
  your laptop    │                                                                                               │
  ┌───────────┐  │  Storage bucket "images"        Postgres + pgvector                Auto-generated REST API   │
  │ data/     │  │  originals/…  thumbs/…          categories, subclasses (taxonomy)   /rest/v1/<table>         │
  │  images/  │──┼─▶ (files)                        images (metrics, embeddings)        /rest/v1/rpc/<function>  │
  └───────────┘  │                                 scores                             /storage/v1/object/…     │
   pipeline/     │                                                                                               │
   batch.py ─────┼── writes with the SERVICE ROLE key (secret)                                                   │
                 └───────────────────────────────────────────────────────────────▲───────────────────────────────┘
                                                                                 │ reads
                                                                                 │ with the ANON key (public)
                                                                    web/ (Next.js + PixiJS + d3-force)
                                                                    runs on each teammate's machine
```

- **Supabase** is the single shared source of truth: image files, scores, embeddings, taxonomy.
- **The Python pipeline** turns image files into numbers and writes them to Supabase. It runs on whoever's laptop is adding images.
- **The web app** only reads from Supabase and draws the graph. It doesn't analyze anything itself.

---

## Quick start

**Which role are you?** Most people only need A.

| | Who | Needs | Key (ask Felix) |
|---|---|---|---|
| **A. Run the app** | everyone | Node.js | **anon key** — fine to share in team chat |
| **B. Add images** | whoever is curating | Node.js + uv | **service role key** — private DM only |

You do **not** need Docker, a Supabase account, or a separate Python install.

### A. Run the app

**1 — Install Node.js 20.9 or newer** (includes npm). Check what you have:

```bash
node -v
```

If it's missing or older, install the LTS build from [nodejs.org](https://nodejs.org). Use **npm** for this project, not yarn, pnpm or bun — the lockfile is `package-lock.json`.

**2 — Get the code and make your env file:**

```bash
git clone https://github.com/Felix-Chang/sightline.git
cd sightline/web
cp .env.example .env.local
```

<sub>Windows Command Prompt: use `copy .env.example .env.local`. PowerShell accepts `cp`.</sub>

**3 — Paste the anon key.** Open `web/.env.local` and put the key straight after `NEXT_PUBLIC_SUPABASE_ANON_KEY=` — no quotes, no spaces, no trailing blank. The URL above it is already filled in.

```
NEXT_PUBLIC_SUPABASE_URL=https://bogtxitqyhkxutysrvhg.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<paste the anon key here>
```

**4 — Install and run:**

```bash
npm install
npm run dev
```

Open **http://localhost:3000**.

> ✅ **It worked if** the panel on the left shows "SightLine", a reference count, and thumbnails drifting into place. *No images yet* means the app is fine and nobody has ingested anything — not an error.

<sub>`npm install` may warn that `unrs-resolver` install scripts were blocked. Ignore it; lint and build work regardless. Env files are read **only at startup**, so restart `npm run dev` after editing `.env.local`.</sub>

### B. Add images (curators only)

**1 — Install uv**, which manages Python for you. Check with `uv --version`; if it's missing:

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Open a new terminal afterwards so `uv` is on your PATH.

**2 — Make the pipeline's env file.** Run everything below from the **repo root** (`sightline/`, not `sightline/web/`):

```bash
cd sightline
cp .env.example .env
```

Paste the **service role key** after `SUPABASE_SERVICE_ROLE_KEY=`.

> ⚠️ **That key can write and delete everything.** It belongs only in `.env`, which is git-ignored. Never paste it into chat, a screenshot, `.env.example`, or code.

**3 — Install dependencies and make a drop folder:**

```bash
uv sync
mkdir -p data/images
```

<sub>Windows: `mkdir data\images`.</sub>

**4 — Add images and ingest.** Put files in `data/images/` — subfolders are fine; jpg, png, webp, gif and heic all work. Then:

```bash
uv run python pipeline/batch.py data/images
```

> ✅ **It worked if** it prints `[1/N] + filename` per image and ends with `added N … combined …`. Teammates see them on their next refresh.

**Before you run it the first time:**

- **The first run downloads about 5 GB of models** (SigLIP 2 + DINOv2) into `~/.cache/huggingface`. Do this on good wifi ahead of the event; later runs start in seconds.
- **Speed:** roughly 1.5 s per image on an M-series Mac or NVIDIA GPU, 5–10 s on CPU-only laptops.

**Good to know:**

- **Re-running is safe.** Images already stored are skipped by file hash, so overlapping folders don't duplicate.
- **Interrupted runs fix themselves.** If a run dies (Ctrl+C, wifi drop), run the same command again. Half-saved images are re-ingested and anything missing combined scores is recombined. Force a recombine with `--recombine`.
- **Phone photos** are rotated upright automatically. Files over 50 MB and unreadable files are skipped with a message; the batch continues.
- `data/` is git-ignored. Images live in Supabase Storage, not in the repo.

### Troubleshooting

| Symptom | Fix |
|---|---|
| *supabaseUrl is required* or *Couldn't load data* in the browser | `web/.env.local` is missing or the key is wrong. Fix it, then **stop and restart `npm run dev`** — env files are only read at startup. |
| App loads but shows nothing / requests hang | The free Supabase project pauses after a week idle. Ask Felix to hit **Restore** in the dashboard. |
| `Another next dev server is already running` | Next 16 allows one dev server per project folder. Stop the old one with the `kill <PID>` command it prints, or just use the URL it points you at. |
| Port 3000 taken by something else | Next picks the next free port and prints it. |
| `KeyError: 'SUPABASE_URL'` from `batch.py` | `.env` is missing at the repo root — it must sit next to `pyproject.toml`, and is a different file from `web/.env.local`. |
| `can't open file … pipeline/batch.py` | You're in `web/`. `cd ..` to the repo root. |
| `uv: command not found` right after installing | Open a new terminal window. |
| `batch.py` prints `!` for some files | Those files couldn't be read (corrupt or unsupported). The rest of the batch continues. |
| Images ingested but missing from the app | `uv run python pipeline/batch.py data/images --recombine`. The app only shows images that have combined scores. |
| Local Docker only: uploads fail with `database error, code: 42P10` after `supabase db reset` | Reset left local Storage out of sync. Run `supabase stop --no-backup` then `supabase start` (wipes local data only). |

---

## Project admin

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

`batch.py` seeds the taxonomy on every run, so step 2's last line only matters if you want the filters to show before any images exist.

### Changing the schema or taxonomy

- **Taxonomy** (`seed/taxonomy.yaml`): edit, commit, and the next `batch.py` run upserts it. Re-scoring existing images after changing prompts or metrics means deleting their scores first — ask before doing that on the shared DB.
- **Tables / functions:** add a new file in `supabase/migrations/` (never edit an old one), commit, and one person runs `supabase db push`.

### Optional: work offline against a local copy

`supabase start` (needs Docker) runs Postgres + Storage locally at `http://127.0.0.1:54321`. `supabase status -o env` prints local keys for your `.env` files. Local data is yours alone. Keep the cloud keys in `.env` / `web/.env.local` and the local ones in a copy like `.env.docker-local` (all `.env*` files are git-ignored), then swap files to switch.

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

**Why combine is collection-wide:** raw numbers live on different scales (brightness 0–1, cosine similarity ~0.05–0.15). Each raw score becomes a **percentile across all images**, so "0.9 contrast" means "more contrast than 90% of the collection". The pixel and SigLIP percentiles are then blended using each subclass's `weight` in `taxonomy.yaml`: 1.0 = pure pixel math, 0 = pure SigLIP. Because it's relative, every new batch reruns it for all images.

### What the models do

There's **no LLM and no text generation** anywhere. Both models turn an image into a list of numbers (an embedding).

- **SigLIP 2** (`google/siglip2-so400m-patch14-384`, by Google) was trained on hundreds of millions of image + caption pairs, so images and sentences land in the *same* number space. We embed each subclass's prompts once (e.g. Line → Jagged: *"a graphic made of sharp zigzag lines"*), then score an image by how close its embedding sits to those prompt embeddings. That catches perceptual qualities ("implied line", "swirling movement") pixel math can't, **without training anything**. Editing the prompts in `taxonomy.yaml` changes what it looks for.
- **DINOv2** (`facebook/dinov2-base`, by Meta) is image-only and self-supervised, and strong on structure and composition. It doesn't produce scores yet; it's stored so we can find structurally similar neighbors via `match_images`.
- **Pixel math** (`pixel.py`, OpenCV + numpy) isn't a model. It's deterministic arithmetic, so it's used wherever a quality is directly measurable (brightness, color temperature, symmetry, texture).

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

# image files are public URLs
$URL/storage/v1/object/public/images/<thumb_path>
```

What's **not** an API yet: scoring. Analyzing an image needs the Python models, so it only happens through `batch.py`. The stretch goal in DESIGN.md is a small FastAPI `/upload` endpoint (`pipeline/server.py`) calling the same `Scorer.ingest()`.

**Permissions** (row-level security, see `supabase/migrations/`): anon can read every table. Everything else needs the service role key.

---

## Repo map

```
seed/taxonomy.yaml        categories, subclasses, prompts, pixel metric + weight
pipeline/                 Python: pixel.py, models.py, score_image.py, batch.py, combine.py, db.py
supabase/migrations/      schema, RLS policies, storage bucket, match_images()
web/src/lib/              data.ts (Supabase queries), layout.ts (anchor/UMAP/kNN math),
                          graph-engine.ts (PixiJS + d3-force), theme.ts (canvas colors + anchor palette)
web/src/components/       Explorer.tsx (UI), Graph.tsx (canvas wrapper)
web/src/app/              layout.tsx, globals.css (design tokens), icon.svg (browser tab)
```

<sub>`web/AGENTS.md` is generated by `next build` and can be ignored.</sub>
