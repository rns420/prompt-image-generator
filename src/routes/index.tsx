import { createFileRoute, Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { parsePrompts, padNumber, type ParsedPrompt } from "@/lib/prompts";
import { createJob, listJobItems, runJob, downloadJobZip, type Job } from "@/lib/jobs";
import { downloadBlob } from "@/lib/zip";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Bulk Prompt to Image Generator — 16:9 Batch Renders" },
      {
        name: "description",
        content:
          "Upload a .txt file with 400-500 numbered prompts and generate every image in 16:9 landscape, named 001.png, 002.png, then download them all as one ZIP.",
      },
      { property: "og:title", content: "Bulk Prompt to Image Generator" },
      {
        property: "og:description",
        content:
          "Batch-generate hundreds of 16:9 images from a numbered prompt list and download them as a single ZIP.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const [fileName, setFileName] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<ParsedPrompt[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, failed: 0, total: 0 });
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState<Job | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onFile(file: File) {
    setError(null);
    setFinished(null);
    const text = await file.text();
    const parsed = parsePrompts(text);
    setFileName(file.name);
    setPrompts(parsed);
    if (parsed.length === 0) {
      setError(
        "No numbered prompts found. Each prompt should start with its number, e.g. “65. a red fox in snow”.",
      );
    }
  }

  async function start() {
    if (!prompts.length) return;
    setRunning(true);
    setError(null);
    setStatus("Creating job…");
    setProgress({ done: 0, failed: 0, total: prompts.length });
    try {
      const job = await createJob(fileName ?? "prompt batch", prompts);
      const items = await listJobItems(job.id);
      setStatus("Generating images…");
      const res = await runJob(job, items, (done, failed, last) => {
        setProgress({ done, failed, total: prompts.length });
        if (last) setStatus(`Latest: ${last}`);
      });
      setFinished({ ...job, completed: res.done, failed: res.failed });
      setStatus(`Done — ${res.done} generated, ${res.failed} failed.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function download(job: Job) {
    setStatus("Packing ZIP…");
    try {
      const { blob, filename, count } = await downloadJobZip(job, (d, t) =>
        setStatus(`Packing ZIP… ${d}/${t}`),
      );
      downloadBlob(blob, filename);
      setStatus(`ZIP ready with ${count} images.`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const pct = progress.total
    ? Math.round(((progress.done + progress.failed) / progress.total) * 100)
    : 0;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div
        className="border-b border-border"
        style={{ backgroundImage: "var(--gradient-hero)" }}
      >
        <div className="mx-auto flex max-w-4xl items-center justify-between px-5 py-5">
          <span className="text-sm font-semibold tracking-[0.2em] text-primary uppercase">
            Batch Render
          </span>
          <Link
            to="/history"
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-secondary"
          >
            History
          </Link>
        </div>
      </div>

      <div className="mx-auto max-w-4xl px-5 py-10">
        <h1 className="text-3xl leading-tight font-bold sm:text-4xl">
          Turn a numbered prompt list into hundreds of 16:9 images
        </h1>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground sm:text-base">
          Upload a .txt file with 400–500 numbered prompts. Each image is named after its prompt
          number (prompt 65 → <span className="text-foreground">065.png</span>), rendered in 16:9
          landscape, and packed into one ZIP you can re-download any time from History — no account
          needed.
        </p>

        <section
          className="mt-8 rounded-2xl border border-border bg-card p-5"
          style={{ boxShadow: "var(--shadow-panel)" }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".txt,text/plain"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
          <button
            onClick={() => inputRef.current?.click()}
            disabled={running}
            className="w-full rounded-xl border border-dashed border-border px-4 py-10 text-center transition-colors hover:border-primary disabled:opacity-50"
          >
            <span className="block text-base font-medium">
              {fileName ?? "Choose your prompts .txt file"}
            </span>
            <span className="mt-1 block text-sm text-muted-foreground">
              One prompt per numbered line
            </span>
          </button>

          {prompts.length > 0 && (
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <Stat label="Prompts found" value={String(prompts.length)} />
              <Stat label="First file" value={`${padNumber(prompts[0]!.number)}.png`} />
              <Stat
                label="Last file"
                value={`${padNumber(prompts[prompts.length - 1]!.number)}.png`}
              />
            </div>
          )}

          <button
            onClick={() => void start()}
            disabled={running || prompts.length === 0}
            className="mt-5 w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {running ? "Generating…" : `Generate ${prompts.length || ""} images`}
          </button>

          {(running || progress.done > 0) && (
            <div className="mt-5">
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="mt-2 text-sm text-muted-foreground">
                {progress.done} done · {progress.failed} failed · {progress.total} total ({pct}%)
              </p>
            </div>
          )}

          {status && <p className="mt-3 text-sm text-muted-foreground">{status}</p>}
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

          {finished && (
            <button
              onClick={() => void download(finished)}
              className="mt-5 w-full rounded-xl border border-primary px-4 py-3 text-sm font-semibold text-primary transition-colors hover:bg-secondary"
            >
              Download ZIP
            </button>
          )}
        </section>

        <p className="mt-6 text-xs text-muted-foreground">
          Keep this tab open while a batch runs — images are saved as they finish, and any partial
          batch can be resumed or downloaded later from History.
        </p>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-secondary/40 px-4 py-3">
      <p className="text-xs tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="mt-1 font-semibold">{value}</p>
    </div>
  );
}
