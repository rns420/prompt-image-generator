CREATE TABLE public.jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TABLE public.job_items (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  storage_path TEXT,
  error TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX job_items_job_id_idx ON public.job_items(job_id);
CREATE UNIQUE INDEX job_items_job_number_idx ON public.job_items(job_id, number);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.jobs TO anon, authenticated;
GRANT ALL ON public.jobs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_items TO anon, authenticated;
GRANT ALL ON public.job_items TO service_role;

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can manage jobs" ON public.jobs FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Public can manage job items" ON public.job_items FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE POLICY "Public can read generations" ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = 'generations');
CREATE POLICY "Public can upload generations" ON storage.objects FOR INSERT TO anon, authenticated WITH CHECK (bucket_id = 'generations');
CREATE POLICY "Public can update generations" ON storage.objects FOR UPDATE TO anon, authenticated USING (bucket_id = 'generations') WITH CHECK (bucket_id = 'generations');