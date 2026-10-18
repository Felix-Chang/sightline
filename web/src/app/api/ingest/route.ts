import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";

// child_process and the filesystem: this route only ever runs on the machine serving the app.
export const runtime = "nodejs";

/** Mirrors EXTS in pipeline/batch.py; anything else is rejected before a subprocess starts. */
const EXTS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic"];
/** batch.py skips anything larger, so refuse it here rather than copying it around first. */
const MAX_BYTES = 50 * 1024 * 1024;

type Failure = { ok: false; title: string; detail?: string };

const fail = (status: number, title: string, detail?: string) =>
  NextResponse.json<Failure>({ ok: false, title, detail }, { status });

/**
 * Runs the existing pipeline over dropped files: writes them to a temp folder and calls
 * `uv run python pipeline/batch.py <folder>`, which ingests, skips duplicates by hash, and
 * recombines the collection. Nothing is reimplemented here.
 *
 * Local-only by design. The host needs the models, uv, and the service role key in the repo's
 * .env, so a deployed instance could not do this even if it were allowed to.
 */
export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return fail(
      403,
      "Upload only runs locally",
      "This endpoint shells out to the Python pipeline, which needs the models and the service role key on the machine serving the app. Run the app with `npm run dev` to use it.",
    );
  }

  let files: File[];
  try {
    const form = await req.formData();
    files = form.getAll("files").filter((f): f is File => f instanceof File);
  } catch {
    return fail(400, "Couldn't read the dropped files");
  }
  if (!files.length) return fail(400, "No files were dropped");

  const rejected = files.filter((f) => !EXTS.includes(path.extname(f.name).toLowerCase()));
  if (rejected.length) {
    return fail(
      415,
      rejected.length === files.length ? "That file type isn't supported" : "Some files aren't supported",
      `${rejected.map((f) => f.name).join(", ")} — SightLine reads ${EXTS.join(", ")}.`,
    );
  }
  const oversized = files.filter((f) => f.size > MAX_BYTES);
  if (oversized.length) {
    return fail(413, "Too large", `${oversized.map((f) => f.name).join(", ")} — the pipeline skips anything over 50 MB.`);
  }

  // next dev runs with web/ as its cwd; the pipeline and its .env live one level up.
  const repoRoot = path.resolve(process.cwd(), "..");
  try {
    await access(path.join(repoRoot, ".env"));
  } catch {
    return fail(
      412,
      "No .env at the repo root",
      "Ingesting writes with the service role key. Copy .env.example to .env beside pyproject.toml and paste the key in.",
    );
  }

  const dir = await mkdtemp(path.join(tmpdir(), "sightline-upload-"));
  try {
    await Promise.all(
      files.map(async (file, i) => {
        // Flatten to a safe name: batch.py walks the folder, so the originals' paths don't matter,
        // and the index keeps two drops of the same filename apart.
        const safe = `${i}-${path.basename(file.name).replace(/[^\w.-]+/g, "_")}`;
        await writeFile(path.join(dir, safe), Buffer.from(await file.arrayBuffer()));
      }),
    );

    const run = await spawnPipeline(repoRoot, dir);
    if (run.spawnError) {
      const missing = (run.spawnError as NodeJS.ErrnoException).code === "ENOENT";
      return fail(
        500,
        missing ? "uv isn't installed, or isn't on this terminal's PATH" : "Couldn't start the pipeline",
        missing
          ? "Install it with `curl -LsSf https://astral.sh/uv/install.sh | sh`, then restart `npm run dev` from a new terminal so it picks up the PATH."
          : String(run.spawnError),
      );
    }
    if (run.code !== 0) {
      return fail(500, `The pipeline exited with code ${run.code}`, tail(run.stderr || run.stdout));
    }

    const summary = /added (\d+), skipped (\d+), failed (\d+)/.exec(run.stdout);
    const perFile = run.stdout
      .split("\n")
      .filter((line) => /^\[\d+\/\d+] ! /.test(line))
      .map((line) => line.replace(/^\[\d+\/\d+] ! /, ""));
    return NextResponse.json({
      ok: true,
      added: summary ? Number(summary[1]) : 0,
      skipped: summary ? Number(summary[2]) : 0,
      failed: summary ? Number(summary[3]) : perFile.length,
      perFile,
      log: tail(run.stdout),
    });
  } catch (e) {
    return fail(500, "Upload failed", String(e));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function spawnPipeline(cwd: string, folder: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: Error }>((resolve) => {
    // No timeout on purpose: the first run downloads ~5 GB of models before scoring anything.
    const child = spawn("uv", ["run", "python", "pipeline/batch.py", folder], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (spawnError) => resolve({ code: null, stdout, stderr, spawnError }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Last few lines, so an error message stays readable on screen. */
const tail = (text: string, lines = 8) => text.trimEnd().split("\n").slice(-lines).join("\n");
