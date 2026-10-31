// Shared by the offline Electron startup document and the React loading state.
// All markup and copy are application-owned constants; no user content is interpolated.
export const startupStyles = `
.ff-startup { --startup-bg: #f6f7f9; --startup-ink: #24262d; --startup-muted: #5d6572; --startup-line: #e7e8ec; --startup-accent: #b92335;
  box-sizing: border-box; min-height: 100vh; min-height: 100svh; display: grid; grid-template-rows: 1fr auto 1fr; justify-items: center; padding: 24px;
  background: var(--startup-bg); color: var(--startup-ink); font: 13px/1.5 "Segoe UI Variable", "Segoe UI", system-ui, sans-serif; font-synthesis: none; }
.ff-startup * { box-sizing: border-box; }
.ff-startup-main { grid-row: 2; width: min(100%, 360px); display: flex; flex-direction: column; align-items: center; text-align: center; }
.ff-startup .ff-startup-name { font-size: 32px; line-height: 1.2; font-weight: 600; letter-spacing: -.6px; margin: 0 0 8px; color: inherit; }
.ff-startup-masala { color: #e58a00; }
.ff-startup .ff-startup-descriptor { font-size: 16px; line-height: 1.5; color: var(--startup-muted); margin: 0; }
.ff-startup-status { width: 100%; margin-top: 48px; display: flex; flex-direction: column; align-items: center; }
.ff-startup .ff-startup-title { font-size: 13px; font-weight: 500; line-height: 1.5; margin: 0 0 16px; }
.ff-startup-line { position: relative; width: min(100%, 240px); height: 2px; overflow: hidden; background: var(--startup-line); border-radius: 4px; }
.ff-startup-line::after { content: ""; position: absolute; inset: 0 auto 0 0; width: 50%; background: var(--startup-accent); transform: translateX(-100%); animation: ff-startup-loading 1.6s ease-in-out infinite; }
.ff-startup .ff-startup-support { font-size: 12px; line-height: 1.5; color: var(--startup-muted); margin: 16px 0 0; }
.ff-startup-footer { grid-row: 3; align-self: end; display: flex; align-items: center; justify-content: center; gap: 16px; padding-top: 24px; color: var(--startup-muted); font-size: 12px; line-height: 1.5; }
.ff-startup-dot { width: 3px; height: 3px; border-radius: 50%; background: var(--startup-accent); }
:root[data-theme="dark"] .ff-startup { --startup-bg: #14171d; --startup-ink: #e8eaf0; --startup-muted: #b3bbc8; --startup-line: #363c48; --startup-accent: #ff8995; }
@keyframes ff-startup-loading { to { transform: translateX(200%); } }
@media (max-height: 460px) { .ff-startup { padding: 16px; } .ff-startup-status { margin-top: 24px; } }
@media (prefers-reduced-motion: reduce) { .ff-startup-line::after { animation: none; transform: translateX(50%); } }
`;

export function startupMarkup(mode: "opening" | "restoring" = "opening") {
  const restoring = mode === "restoring";
  return `<div class="ff-startup">
    <main class="ff-startup-main" aria-label="MasalaPOS startup">
      <h1 class="ff-startup-name"><span class="ff-startup-masala">Masala</span>POS</h1><p class="ff-startup-descriptor">A little masala. A lot of business.</p>
      <div class="ff-startup-status" role="status" aria-live="polite">
        <p class="ff-startup-title">${restoring ? "Restoring your backup…" : "Preparing your workspace…"}</p>
        <div class="ff-startup-line" aria-hidden="true"></div>
        <p class="ff-startup-support">${restoring ? "Please keep MasalaPOS open while your data is restored" : "Getting things ready for service"}</p>
      </div>
    </main>
    <footer class="ff-startup-footer"><span>Orders</span><span class="ff-startup-dot" aria-hidden="true"></span><span>Billing</span><span class="ff-startup-dot" aria-hidden="true"></span><span>Kitchen</span></footer>
  </div>`;
}

export function startupDocument(mode: "opening" | "restoring" = "opening") {
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>MasalaPOS</title><style>html,body{margin:0;background:#f6f7f9}${startupStyles}</style></head><body>${startupMarkup(mode)}</body></html>`;
}
