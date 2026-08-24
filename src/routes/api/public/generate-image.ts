import { createFileRoute } from "@tanstack/react-router";

const MODEL = "google/gemini-3.1-flash-lite-image";

export const Route = createFileRoute("/api/public/generate-image")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = process.env["LOVABLE_API_KEY"];
        if (!key) {
          return Response.json({ error: "Missing LOVABLE_API_KEY" }, { status: 500 });
        }

        const { prompt } = (await request.json()) as { prompt?: string };
        if (!prompt || !prompt.trim()) {
          return Response.json({ error: "Missing prompt" }, { status: 400 });
        }

        const upstream = await fetch("https://ai.gateway.lovable.dev/v1/images/generations", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: MODEL,
            contents: [
              {
                role: "user",
                parts: [{ text: `${prompt}\n\nRender as a 16:9 landscape image.` }],
              },
            ],
            generationConfig: {
              responseModalities: ["TEXT", "IMAGE"],
              imageConfig: { aspectRatio: "16:9" },
            },
          }),
        });

        if (!upstream.ok) {
          const text = await upstream.text().catch(() => "");
          return Response.json(
            { error: text || `Image generation failed (${upstream.status})` },
            { status: upstream.status },
          );
        }

        const json = (await upstream.json()) as {
          data?: { b64_json?: string }[];
          candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[];
        };

        const b64 =
          json.data?.[0]?.b64_json ??
          json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;

        if (!b64) {
          return Response.json({ error: "No image returned" }, { status: 502 });
        }

        return Response.json({ b64 });
      },
    },
  },
});
