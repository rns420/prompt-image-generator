import { supabase } from "@/integrations/supabase/client";
import { padNumber, type ParsedPrompt } from "./prompts";
import { base64ToBytes, buildZip } from "./zip";

export type Job = {
  id: string;
  title: string;
  total: number;
  completed: number;
  failed: number;
  status: string;
  created_at: string;
};

export type JobItem = {
  id: string;
  job_id: string;
  number: number;
  prompt: string;
  status: string;
  storage_path: string | null;
  error: string | null;
};

const BUCKET = "generations";
const MAX_CONCURRENCY = 6;
const MIN_CONCURRENCY = 1;
const MAX_ATTEMPTS = 8;

export async function createJob(title: string, prompts: ParsedPrompt[]): Promise<Job> {
  const { data: job, error } = await supabase
    .from("jobs")
    .insert({ title, total: prompts.length, status: "running" })
    .select()
    .single();
  if (error || !job) throw new Error(error?.message ?? "Could not create job");

  for (let i = 0; i < prompts.length; i += 200) {
    const chunk = prompts.slice(i, i + 200).map((p) => ({
      job_id: job.id,
      number: p.number,
      prompt: p.prompt,
    }));
    const { error: itemsError } = await supabase.from("job_items").insert(chunk);
    if (itemsError) throw new Error(itemsError.message);
  }

  return job as Job;
}

export async function listJobs(): Promise<Job[]> {
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as Job[];
}

export async function listJobItems(jobId: string): Promise<JobItem[]> {
  const all: JobItem[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from("job_items")
      .select("*")
      .eq("job_id", jobId)
      .order("number", { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    all.push(...((data ?? []) as JobItem[]));
    if (!data || data.length < page) break;
  }
  return all;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class RetryableError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** Shared throttle: all workers respect one pause window and one active limit. */
class Throttle {
  limit = MAX_CONCURRENCY;
  private pauseUntil = 0;
  private successStreak = 0;

  async gate() {
    for (;;) {
      const wait = this.pauseUntil - Date.now();
      if (wait <= 0) return;
      await sleep(Math.min(wait, 1000));
    }
  }

  onRateLimit(retryAfterMs?: number) {
    this.successStreak = 0;
    this.limit = Math.max(MIN_CONCURRENCY, Math.floor(this.limit / 2));
    const cool = retryAfterMs ?? 5000;
    this.pauseUntil = Math.max(this.pauseUntil, Date.now() + cool);
  }

  onSuccess() {
    this.successStreak++;
    if (this.successStreak >= 15 && this.limit < MAX_CONCURRENCY) {
      this.limit++;
      this.successStreak = 0;
    }
  }
}

async function requestImage(prompt: string): Promise<string> {
  const res = await fetch("/api/public/generate-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; retryAfter?: number };
    const header = res.headers.get("retry-after");
    const retryAfterMs = body.retryAfter
      ? body.retryAfter * 1000
      : header
        ? Number(header) * 1000
        : undefined;
    const msg = (body.error ?? `Generation failed (${res.status})`).slice(0, 300);
    if (res.status === 429 || res.status >= 500) {
      throw new RetryableError(`${res.status}: ${msg}`, retryAfterMs);
    }
    throw new Error(`${res.status}: ${msg}`);
  }
  const { b64 } = (await res.json()) as { b64: string };
  if (!b64) throw new RetryableError("Empty image response");
  return b64;
}

/** Generates one image with bounded auto-retry on 429/5xx/network errors. */
async function generateOne(item: JobItem, jobId: string, throttle: Throttle) {
  let lastError = "Generation failed";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await throttle.gate();
    try {
      const b64 = await requestImage(item.prompt);
      const bytes = base64ToBytes(b64);
      const path = `${jobId}/${padNumber(item.number)}.png`;
      const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
        contentType: "image/png",
        upsert: true,
      });
      if (error) throw new RetryableError(error.message);
      throttle.onSuccess();
      return path;
    } catch (e) {
      const err = e as Error;
      lastError = err.message;
      const retryable = err instanceof RetryableError || err.name === "TypeError";
      if (!retryable || attempt === MAX_ATTEMPTS) throw new Error(lastError);
      const retryAfterMs = err instanceof RetryableError ? err.retryAfterMs : undefined;
      if (/^429/.test(lastError) || retryAfterMs) throttle.onRateLimit(retryAfterMs);
      const backoff = Math.min(30000, 1500 * 2 ** (attempt - 1));
      await sleep((retryAfterMs ?? backoff) + Math.random() * 750);
    }
  }
  throw new Error(lastError);
}

export async function runJob(
  job: Job,
  items: JobItem[],
  onProgress: (done: number, failed: number, last?: string) => void,
) {
  const queue = items.filter((i) => i.status !== "done");
  let done = items.length - queue.length;
  let failed = 0;
  let cursor = 0;
  let active = 0;
  const throttle = new Throttle();

  const worker = async () => {
    while (cursor < queue.length) {
      // respect the adaptive concurrency limit
      if (active >= throttle.limit) {
        await sleep(250);
        continue;
      }
      const item = queue[cursor++]!;
      active++;
      try {
        const path = await generateOne(item, job.id, throttle);
        await supabase
          .from("job_items")
          .update({ status: "done", storage_path: path, error: null })
          .eq("id", item.id);
        done++;
        onProgress(done, failed, `${padNumber(item.number)}.png`);
      } catch (e) {
        failed++;
        await supabase
          .from("job_items")
          .update({ status: "failed", error: (e as Error).message.slice(0, 500) })
          .eq("id", item.id);
        onProgress(done, failed, `${padNumber(item.number)} failed`);
      } finally {
        active--;
      }
      if ((done + failed) % 10 === 0) {
        await supabase.from("jobs").update({ completed: done, failed }).eq("id", job.id);
      }
    }
  };

  await Promise.all(Array.from({ length: MAX_CONCURRENCY }, worker));

  // Final sweep: one slow, sequential pass over anything still failed.
  const stragglers = queue.filter((i) => !queue.some(() => false));
  void stragglers;
  const stillFailed = await listJobItems(job.id).then((all) =>
    all.filter((i) => i.status !== "done"),
  );
  if (stillFailed.length) {
    throttle.limit = 1;
    for (const item of stillFailed) {
      try {
        const path = await generateOne(item, job.id, throttle);
        await supabase
          .from("job_items")
          .update({ status: "done", storage_path: path, error: null })
          .eq("id", item.id);
        done++;
        failed = Math.max(0, failed - 1);
        onProgress(done, failed, `${padNumber(item.number)}.png`);
      } catch {
        /* keep as failed */
      }
      await sleep(400);
    }
  }

  const finalItems = await listJobItems(job.id);
  done = finalItems.filter((i) => i.status === "done").length;
  failed = finalItems.length - done;

  await supabase
    .from("jobs")
    .update({
      completed: done,
      failed,
      status: failed === 0 ? "completed" : "completed_with_errors",
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id);

  return { done, failed };
}

/** Rebuilds and downloads the full ZIP for a job from stored images. */
export async function downloadJobZip(job: Job, onProgress?: (done: number, total: number) => void) {
  const items = (await listJobItems(job.id)).filter((i) => i.storage_path);
  const files: Record<string, Uint8Array> = {};
  let done = 0;

  const paths = items.map((i) => i.storage_path!);
  const signed: Record<string, string> = {};
  for (let i = 0; i < paths.length; i += 100) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUrls(paths.slice(i, i + 100), 3600);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      if (row.path && row.signedUrl) signed[row.path] = row.signedUrl;
    }
  }

  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      const url = signed[item.storage_path!];
      if (url) {
        const res = await fetch(url);
        if (res.ok) {
          files[`${padNumber(item.number)}.png`] = new Uint8Array(await res.arrayBuffer());
        }
      }
      done++;
      onProgress?.(done, items.length);
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));

  const blob = await buildZip(files);
  const safe = job.title.replace(/[^\w.-]+/g, "_").slice(0, 40) || "images";
  return { blob, filename: `${safe}.zip`, count: Object.keys(files).length };
}
