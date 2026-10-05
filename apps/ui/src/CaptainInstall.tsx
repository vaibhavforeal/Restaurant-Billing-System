import { installCaptain, useCaptainPwa } from "./captain-pwa";

export function CaptainInstall() {
  const pwa = useCaptainPwa();
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return <section className="captain-install" aria-label="Install Captain">
    <h3>{pwa.installed ? "Captain is installed" : "Install on this tablet"}</h3>
    {!window.isSecureContext ? <p>Open the restaurant's trusted HTTPS Captain address to install this app.</p>
      : pwa.installable ? <button className="primary" onClick={() => void installCaptain()}>Install Captain</button>
      : !pwa.installed ? <p>{ios ? "In Safari, tap Share → Add to Home Screen. Enable Open as Web App if shown." : "In your browser menu, choose Install app or Add to Home screen."}</p> : null}
    <p>{pwa.ready ? "App interface saved on this tablet. Orders and kitchen confirmation need the POS connection." : "Keep the POS PC on and use the restaurant Wi-Fi."}</p>
    {pwa.error && <p role="status">{pwa.error}</p>}
    {pwa.updateReady && <p role="status">An update is ready. Finish your order, then close all Captain windows and reopen the app.</p>}
  </section>;
}

export function CaptainReconnect() {
  return <main className="captain-offline"><h1>Reconnect to your POS</h1><p>Join the restaurant Wi-Fi and check that the POS PC is running.</p><p>Your saved drafts and queued actions stay on this tablet. A connection is needed to sign in, load tables, and confirm kitchen orders.</p><button className="primary" onClick={() => location.reload()}>Try again</button></main>;
}
