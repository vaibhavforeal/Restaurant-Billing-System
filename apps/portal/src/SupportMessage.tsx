/** Only our connector URL becomes a download link; ordinary message content stays text. */
export function SupportMessage({ body }: { body: string }) {
  const chunks = body.split(/(https:\/\/[^\s]+\/support\/connector\?t=[A-Za-z0-9_-]{43})/g);
  return <>{chunks.map((text,index) => {
    try { const url = new URL(text); if (url.origin === location.origin && url.pathname === "/support/connector") return <a key={index} href={url.href} target="_blank" rel="noopener noreferrer">Download Support Connector</a>; } catch { /* plain text */ }
    return text;
  })}</>;
}
