import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { downloadJobZip, listJobItems, listJobs, runJob, type Job } from "@/lib/jobs";
import { downloadBlob } from "@/lib/zip";

export const Route = createFileRoute("/history")({
  head: () => ({
    meta: [
      { title: "Batch History — Download Generated Image ZIPs" },
      {
        name: "description",
        content:
          "Every image generation batch is saved here. Anyone can re-download the complete ZIP of 16:9 images at any time, with no sign-in.",
      },
      { property: "og:title", content: "Batch History — Download Image ZIPs" },
      {
        property: "og:description",
        content: "Re-download any past batch of generated 16:9 images as a single ZIP file.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: History,
});

function History() {
  const { data: jobs, isLoading, refetch } = useQuery({ queryKey: ["jobs"], queryFn: listJobs });
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(job: Job) {
    setBusy(job.id);
    setError(null);
    try {
      const { blob, filename, count } = await downloadJobZip(job, (d, t) =>
        setStatus(`Packing ${job.title}… ${d}/${t}`),
      );
      downloadBlob(blob, filename);
      setStatus(`ZIP ready with ${count} images.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function resume(job: Job) {
    setBusy(job.id);
    setError(null);
    try {
      const items = await listJobItems(job.id);
      const res = await runJob(job, items, (done, failed) =>
        setStatus(`${job.title}: ${done} done · ${failed} failed`),
      );
      setStatus(`${job.title}: finished with ${res.done} images.`);
      void refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="border-b border-border" style={{ backgroundImage: "var(--gradient-hero)" }}>
        <div className="mx-auto flex max-w-4xl items-center justify-between px-5 py-5">
          <span className="text-sm font-semibold tracking-[0.2em] text-primary uppercase">
            History
          </span>
          <Link
            to="/"
            className="rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:bg-secondary"
          >
            New batch
          </Link>
        </div>
      </div>

      <div className="mx-auto max-w-4xl px-5 py-10">
        <h1 className="text-3xl font-bold">Past batches</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Anyone can download the complete ZIP for any batch, any time.
        </p>

        {status && <p className="mt-4 text-sm text-muted-foreground">{status}</p>}
        {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

        <div className="mt-6 space-y-3">
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!isLoading && (jobs ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">No batches yet.</p>
          )}
          {(jobs ?? []).map((job) => (
            <article
              key={job.id}
              className="rounded-2xl border border-border bg-card p-4 sm:flex sm:items-center sm:justify-between"
            >
              <div>
                <h2 className="font-semibold">{job.title}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {new Date(job.created_at).toLocaleString()} · {job.completed}/{job.total} images
                  {job.failed > 0 ? ` · ${job.failed} failed` : ""} · {job.status}
                </p>
              </div>
              <div className="mt-3 flex gap-2 sm:mt-0">
                {job.completed + job.failed < job.total && (
                  <button
                    onClick={() => void resume(job)}
                    disabled={busy === job.id}
                    className="rounded-xl border border-border px-3 py-2 text-sm transition-colors hover:bg-secondary disabled:opacity-50"
                  >
                    Resume
                  </button>
                )}
                <button
                  onClick={() => void download(job)}
                  disabled={busy === job.id}
                  className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {busy === job.id ? "Working…" : "Download ZIP"}
                </button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </main>
  );
}
