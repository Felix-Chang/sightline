import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

/**
 * Module-level, so it also covers a second browser tab: two batches at once would each load a
 * full copy of the models, and both would finish by rewriting every image's combined scores.
 */
let scoring = false;

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
  const credentials = await credentialProblem(repoRoot);
  if (credentials) return NextResponse.json(credentials, { status: 412 });

  if (scoring) {
    return fail(
      409,
      "Already scoring a drop",
      "Wait for the batch in progress to finish. Two at once would load the models twice and race on the combined scores, which are recomputed across the whole collection.",
    );
  }
  scoring = true;

  const dir = await mkdtemp(path.join(tmpdir(), "sightline-upload-"));
  try {
    // Flatten to safe names: batch.py walks the folder, so the originals' paths don't matter, and
    // the index keeps two drops of the same filename apart. Kept so messages can be read back.
    const names = files.map((file, i) => ({
      safe: `${i}-${path.basename(file.name).replace(/[^\w.-]+/g, "_")}`,
      original: file.name,
    }));
    await Promise.all(
      files.map(async (file, i) => writeFile(path.join(dir, names[i].safe), Buffer.from(await file.arrayBuffer()))),
    );
    // The pipeline reports the temp paths it was handed; show people the files they dropped.
    const readable = (text: string) =>
      names.reduce((acc, n) => acc.split(n.safe).join(n.original), text.split(`${dir}/`).join("").split(dir).join(""));

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
      const output = `${run.stdout}\n${run.stderr}`;
      if (/\b401\b|invalid api key|invalid jwt|not authorized|unauthorized/i.test(output)) {
        return fail(
          500,
          "Supabase rejected the service role key",
          `It is set but wrong, or it belongs to a different project. Check SUPABASE_SERVICE_ROLE_KEY in .env against Project Settings → API.\n\n${readable(tail(run.stderr || run.stdout, 4))}`,
        );
      }
      return fail(500, `The pipeline exited with code ${run.code}`, tail(run.stderr || run.stdout));
    }

    const summary = /added (\d+), skipped (\d+), failed (\d+)/.exec(run.stdout);
    const perFile = run.stdout
      .split("\n")
      .filter((line) => /^\[\d+\/\d+] ! /.test(line))
      .map((line) => readable(line.replace(/^\[\d+\/\d+] ! /, "")));
    return NextResponse.json({
      ok: true,
      added: summary ? Number(summary[1]) : 0,
      skipped: summary ? Number(summary[2]) : 0,
      failed: summary ? Number(summary[3]) : perFile.length,
      perFile,
      log: readable(tail(run.stdout)),
    });
  } catch (e) {
    return fail(500, "Upload failed", String(e));
  } finally {
    scoring = false;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * What the pipeline will read: a real environment variable wins, because load_dotenv() in db.py
 * does not override one. Returns null when the credentials look usable.
 */
async function credentialProblem(repoRoot: string): Promise<Failure | null> {
  let file: Record<string, string> = {};
  let hasEnvFile = true;
  try {
    file = parseEnv(await readFile(path.join(repoRoot, ".env"), "utf8"));
  } catch {
    hasEnvFile = false;
  }
  const url = process.env.SUPABASE_URL?.trim() || file.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || file.SUPABASE_SERVICE_ROLE_KEY;

  if (!hasEnvFile && !key) {
    return {
      ok: false,
      title: "No .env at the repo root",
      detail: "Ingesting writes with the service role key. Copy .env.example to .env beside pyproject.toml and paste the key in.",
    };
  }
  if (!key) {
    return {
      ok: false,
      title: "The service role key is blank",
      detail: "SUPABASE_SERVICE_ROLE_KEY is empty in .env. Paste the key from Project Settings → API — it is the secret one, shared by private message only.",
    };
  }
  if (!url) {
    return { ok: false, title: "SUPABASE_URL is missing", detail: "Add it to .env beside the service role key; .env.example has the project's URL." };
  }
  // A JWT-style key carries its role; the usual slip is pasting the public anon key here.
  const role = jwtRole(key);
  if (role && role !== "service_role") {
    return {
      ok: false,
      title: `That is the ${role} key, not the service role key`,
      detail: "The anon key can only read. Ingesting needs the service role key from Project Settings → API, which must stay out of chat and out of .env.example.",
    };
  }
  return null;
}

/** Enough of the dotenv format for this check: KEY=value, ignoring comments and quotes. */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** The `role` claim of a Supabase JWT key, or null for the newer sb_secret_* format. */
function jwtRole(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    return typeof claims.role === "string" ? claims.role : null;
  } catch {
    return null;
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
