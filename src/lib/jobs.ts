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
const CONCURRENCY = 8;

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

async function generateOne(item: JobItem, jobId: string) {
  const res = await fetch("/api/public/generate-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: item.prompt }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Generation failed (${res.status})`);
  }
  const { b64 } = (await res.json()) as { b64: string };
  const bytes = base64ToBytes(b64);
  const path = `${jobId}/${padNumber(item.number)}.png`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
    contentType: "image/png",
    upsert: true,
  });
  if (error) throw new Error(error.message);
  return path;
}

export async function runJob(
  job: Job,
  items: JobItem[],
  onProgress: (done: number, failed: number, last?: string) => void,
) {
  const pending = items.filter((i) => i.status !== "done");
  let done = items.length - pending.length;
  let failed = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < pending.length) {
      const item = pending[cursor++]!;
      try {
        const path = await generateOne(item, job.id);
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
      }
      if ((done + failed) % 10 === 0) {
        await supabase.from("jobs").update({ completed: done, failed }).eq("id", job.id);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

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
