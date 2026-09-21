export default function Home() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 font-sans text-zinc-50">
      <main className="flex w-full max-w-2xl flex-col items-center gap-8 px-8 py-24 text-center">
        <p className="rounded-full border border-zinc-800 px-4 py-1.5 text-xs uppercase tracking-widest text-zinc-400">
          Open source &middot; AGPLv3
        </p>
        <h1 className="text-5xl font-bold tracking-tight">
          Marketr
        </h1>
        <p className="max-w-xl text-lg leading-8 text-zinc-400">
          The open-source marketing &amp; SEO workspace that replaces your
          $400/mo tool sprawl — keyword research, competitor gap analysis, an
          AI content engine, rank tracking, and white-label client reporting
          in one self-serve OS.
        </p>
        <div className="flex flex-col gap-3 text-sm text-zinc-500">
          <p>
            <span className="font-mono text-zinc-300">docker compose up</span>{" "}
            to self-host. Bring your own DataForSEO + LLM keys.
          </p>
          <p>
            Foundation scaffold is live. Feature build starts in milestone 2 —
            see <span className="font-mono text-zinc-300">SPEC.md</span>.
          </p>
        </div>
      </main>
    </div>
  );
}
