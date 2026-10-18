# SightLine

**A self-organizing graph of visual references, sorted by *how* images look rather than *what* they show.**

Reference libraries are usually filed by subject or by vibe: "posters", "editorial", "stuff I like". SightLine files by **formal visual language** instead. Drop in posters, graphics, and illustrations, and every image is scored on the vocabulary taught in a design foundations course: line, shape, form, space, color, value, texture, balance, contrast, emphasis, movement, rhythm, and unity.

Pick a category and the collection rearranges itself. Under **Line**, straight-line images gather at one anchor and shade toward jagged, then curved. Nothing is tagged by hand. The scores come from pixel measurements and an image/text model, and each one is a percentile across the whole collection, so "0.9 curved" means *more curved than 90% of your references*.

## Why it exists

Artists and designers collect constantly, and a reference folder almost always outgrows whatever system it started in. You can feel that the pieces you save have something in common, but the through-line stays a hunch — you cannot point at it, and you certainly cannot apply it on purpose.

SightLine makes that pattern explicit. It is a taxonomy of visual technique applied uniformly to everything you have collected, so the trends in your own taste become legible: two thirds of what you saved is high-contrast and asymmetric, your "energetic" pile is really diagonal movement, the covers you keep returning to share a shallow, flattened sense of space. Those are concrete observations rather than vague impressions, and they name specific techniques and features you can carry into the next project.

## What you'll see

- **No filter (None).** Every image is placed by UMAP over all of its scores, so overall visual language decides which images sit near one another. Faint gray lines link each image to its two closest matches.
- **A category filter.** That category's subclasses become anchors arranged in a ring, or along a left–right axis for two-sided spectrums such as Value. Each image is pulled toward the anchors in proportion to its scores, so pure examples land on an anchor and mixed ones float between. Colored threads run from each anchor to the images that strongly show that quality, and every anchor has its own color, matched by the score bars in the detail card.
- **Blend ↔ Separate.** How hard each image commits to its strongest quality. Blend preserves nuance and draws the collection inward; Separate exaggerates the dominant quality and pulls the clusters apart.
- **Hover or click an image** to see its scores. Scroll to zoom, drag to pan, use ← and → to change filter, and press Esc to unpin.

> **New to the project?** Jump to [Quick start](#quick-start). The app takes about five minutes to get running.

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

- **Supabase** is the single shared source of truth: image files, scores, embeddings, and taxonomy.
- **The Python pipeline** turns image files into numbers and writes them to Supabase. It runs on the machine of whoever is adding images.
- **The web app** only reads from Supabase and draws the graph. It does not analyze anything itself.

---

## Quick start

Most people only need role A.

| Role | Who | Needs | Key required |
|---|---|---|---|
| **A. Run the app** | everyone | Node.js | **anon key**, which is safe to share in team chat |
| **B. Add images** | whoever is curating | Node.js and uv | **service role key**, by private message only |

Docker, a Supabase account, and a separate Python installation are all unnecessary.

### A. Run the app

**1. Install Node.js 20.9 or newer**, which includes npm. Check what you have:

```bash
node -v
```

If Node is missing or older, install the LTS build from [nodejs.org](https://nodejs.org). Use **npm** for this project rather than yarn, pnpm, or bun; the lockfile is `package-lock.json`.

**2. Get the code and create your environment file.**

```bash
git clone https://github.com/Felix-Chang/sightline.git
cd sightline/web
cp .env.example .env.local
```

> **Note.** On Windows Command Prompt, use `copy .env.example .env.local`. PowerShell accepts `cp`.

**3. Paste the anon key.** Open `web/.env.local` and put the key immediately after `NEXT_PUBLIC_SUPABASE_ANON_KEY=`, with no quotes, no spaces, and no trailing characters. The URL above it is already filled in.

```
NEXT_PUBLIC_SUPABASE_URL=https://bogtxitqyhkxutysrvhg.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<paste the anon key here>
```

**4. Install dependencies and start the app.**

```bash
npm install
npm run dev
```

Open **http://localhost:3000**.

> **Check.** It worked if the panel on the left shows "SightLine", a reference count, and thumbnails drifting into place. *No images yet* means the app is healthy and nobody has ingested anything; it is not an error.

> **Note.** `npm install` may warn that `unrs-resolver` install scripts were blocked. Ignore it, as lint and build both work regardless. Environment files are read only at startup, so restart `npm run dev` after editing `.env.local`.

### B. Add images (curators only)

**1. Install uv**, which manages Python for you. Check with `uv --version`. If it is missing:

```bash
# macOS and Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

```powershell
# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

Open a new terminal afterward so that `uv` is on your PATH.

**2. Create the pipeline's environment file.** Run everything in this section from the **repo root** (`sightline/`, not `sightline/web/`).

```bash
cd sightline
cp .env.example .env
```

Paste the **service role key** after `SUPABASE_SERVICE_ROLE_KEY=`.

> **Warning.** That key can write and delete everything in the project. It belongs only in `.env`, which is git-ignored. Never paste it into chat, a screenshot, `.env.example`, or code.

**3. Install dependencies and create a drop folder.**

```bash
uv sync
mkdir -p data/images
```

> **Note.** On Windows, use `mkdir data\images`.

**4. Add images and ingest them.** Put files in `data/images/`. Subfolders are fine, and jpg, png, webp, gif, and heic all work.

```bash
uv run python pipeline/batch.py data/images
```

> **Check.** It worked if the run prints `[1/N] + filename` for each image and ends with `added N … combined …`. Teammates will see the images on their next refresh.

Before the first run:

- **The first run downloads roughly 5 GB of models** (SigLIP 2 and DINOv2) into `~/.cache/huggingface`. Do this on good wifi ahead of time; later runs start in seconds.
- **Expect about 1.5 seconds per image** on an M-series Mac or an NVIDIA GPU, and 5–10 seconds on CPU-only laptops.

Worth knowing:

- **Re-running is safe.** Images already stored are skipped by file hash, so overlapping folders do not create duplicates.
- **Interrupted runs repair themselves.** If a run dies, whether from Ctrl+C or a dropped connection, run the same command again. Half-saved images are re-ingested, and anything missing combined scores is recombined. Force a recombine with `--recombine`.
- **Phone photos are rotated upright automatically.** Files larger than 50 MB and unreadable files are skipped with a message, and the batch continues.
- **`data/` is git-ignored.** Images live in Supabase Storage, not in the repo.

### Troubleshooting

| Symptom | Fix |
|---|---|
| *supabaseUrl is required* or *Couldn't load data* in the browser | `web/.env.local` is missing or the key is wrong. Correct it, then stop and restart `npm run dev`, because environment files are read only at startup. |
| The app loads but shows nothing, or requests hang | The free Supabase project pauses after a week of inactivity. Ask the project owner to select **Restore** in the dashboard. |
| `Another next dev server is already running` | Next 16 allows one dev server per project folder. Stop the existing one using the `kill <PID>` command it prints, or open the URL it points you to. |
| Port 3000 is taken by another program | Next selects the next free port and prints it. |
| `KeyError: 'SUPABASE_URL'` from `batch.py` | `.env` is missing from the repo root. It must sit beside `pyproject.toml`, and it is a different file from `web/.env.local`. |
| `can't open file … pipeline/batch.py` | You are in `web/`. Run `cd ..` to return to the repo root. |
| `uv: command not found` immediately after installing | Open a new terminal window. |
| `batch.py` prints `!` for some files | Those files could not be read, because they are corrupt or unsupported. The rest of the batch continues. |
| Images were ingested but do not appear in the app | Run `uv run python pipeline/batch.py data/images --recombine`. The app only shows images that have combined scores. |
| Local Docker only: uploads fail with `database error, code: 42P10` after `supabase db reset` | The reset left local Storage out of sync. Run `supabase stop --no-backup`, then `supabase start`. This wipes local data only. |

---

## Project administration

### One-time setup of the hosted project

This has already been done for the shared project and is recorded here for reference.

1. Create a project at [supabase.com/dashboard](https://supabase.com/dashboard). The free tier is sufficient.
2. Install the CLI with `brew install supabase/tap/supabase`, then run:
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>   # the ref appears in the dashboard URL
   supabase db push                                  # creates tables, functions, and the "images" bucket
   uv run python -c "import sys; sys.path.insert(0,'pipeline'); from db import seed_taxonomy; seed_taxonomy()"
   ```
3. In the dashboard, open **Project Settings → API** and copy the URL, the **anon** key for everyone, and the **service_role** key for curators.

`batch.py` seeds the taxonomy on every run, so the last line of step 2 matters only if you want the filters to appear before any images exist.

### Changing the schema or the taxonomy

- **Taxonomy** (`seed/taxonomy.yaml`): edit it, commit, and the next `batch.py` run will upsert the changes. Re-scoring existing images after changing prompts or metrics means deleting their scores first, so ask before doing that on the shared database.
- **Tables and functions:** add a new file in `supabase/migrations/`, never editing an existing one, then commit and have one person run `supabase db push`.

### Optional: work offline against a local copy

`supabase start`, which requires Docker, runs Postgres and Storage locally at `http://127.0.0.1:54321`. `supabase status -o env` prints local keys for your environment files. Local data is yours alone. Keep the cloud keys in `.env` and `web/.env.local`, keep the local ones in a copy such as `.env.docker-local`, and swap the files to switch. All `.env*` files are git-ignored.

---

## How the pipeline works

For each image, `batch.py` calls `Scorer.ingest()` in `pipeline/score_image.py`:

| # | Step | Code | Stored where |
|---|---|---|---|
| 1 | Hash the file (SHA-256) and skip it if it is already stored | `score_image.py` | `images.sha256` |
| 2 | Upload the original and a 256px WebP thumbnail | `score_image.py` | Storage bucket `images` |
| 3 | **Measure:** roughly 40 pixel metrics, including brightness, hue histogram, mirror symmetry, Hough lines, edge orientation, saliency, and FFT repetition | `pixel.py` | `images.metrics` (JSON), `scores` with `source='pixel'` |
| 4 | **Perceive:** SigLIP 2 image embedding, compared against text prompts for every subclass | `models.py` | `images.siglip` (vector), `scores` with `source='siglip'` |
| 5 | **Embed:** DINOv2 image embedding | `models.py` | `images.dino` (vector) |
| 6 | **Combine**, once per batch, across the whole collection | `combine.py` | `scores` with `source='combined'`, `images.umap_x/y` |

**Why combining is collection-wide.** Raw numbers live on different scales, with brightness running 0–1 and cosine similarity around 0.05–0.15. Each raw score therefore becomes a percentile across all images, so "0.9 contrast" means "more contrast than 90% of the collection". The pixel and SigLIP percentiles are then blended using each subclass's `weight` in `taxonomy.yaml`, where 1.0 is pure pixel math and 0 is pure SigLIP. Because the result is relative, every new batch reruns it for all images.

### What the models do

There is **no LLM and no text generation** anywhere in the project. Both models turn an image into a list of numbers, known as an embedding.

- **SigLIP 2** (`google/siglip2-so400m-patch14-384`, by Google) was trained on hundreds of millions of image and caption pairs, so images and sentences land in the *same* number space. Each subclass's prompts are embedded once, for example Line → Jagged as *"a graphic made of sharp zigzag lines"*, and an image is scored by how close its embedding sits to those prompt embeddings. This captures perceptual qualities that pixel math cannot, such as implied line or swirling movement, **without training anything**. Editing the prompts in `taxonomy.yaml` changes what it looks for.
- **DINOv2** (`facebook/dinov2-base`, by Meta) is image-only and self-supervised, and it is strong on structure and composition. It does not produce scores yet; it is stored so that structurally similar neighbors can be found through `match_images`.
- **Pixel math** (`pixel.py`, using OpenCV and numpy) is not a model. It is deterministic arithmetic, so it is used wherever a quality is directly measurable, such as brightness, color temperature, symmetry, and texture.

Models run locally, using the Apple Silicon GPU through MPS, CUDA, or the CPU. Nothing is sent to an external AI API.

---

## Is there a REST API?

Yes. Supabase auto-generates one from the database through PostgREST. There is no custom backend; the web app calls these endpoints directly through `@supabase/supabase-js`. Every request needs the `apikey` header.

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

Scoring is **not** exposed as an API. Analyzing an image requires the Python models, so it happens only through `batch.py`. The stretch goal described in DESIGN.md is a small FastAPI `/upload` endpoint (`pipeline/server.py`) that calls the same `Scorer.ingest()`.

**Permissions.** Row-level security is defined in `supabase/migrations/`. The anon key can read every table, and everything else requires the service role key.

---

## Repo map

```
seed/taxonomy.yaml        categories, subclasses, prompts, pixel metric and weight
pipeline/                 Python: pixel.py, models.py, score_image.py, batch.py, combine.py, db.py
supabase/migrations/      schema, RLS policies, storage bucket, match_images()
web/src/lib/              data.ts (Supabase queries), layout.ts (anchor, UMAP, and kNN math),
                          graph-engine.ts (PixiJS and d3-force), theme.ts (canvas colors, anchor palette)
web/src/components/       Explorer.tsx (UI), Graph.tsx (canvas wrapper)
web/src/app/              layout.tsx, globals.css (design tokens), icon.svg (browser tab)
```

`web/AGENTS.md` is generated by `next build` and can be ignored.
