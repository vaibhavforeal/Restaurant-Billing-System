import { useState } from "react";
import { PinPrompt } from "./PinPrompt";

/**
 * Runs an action only after the owner PIN is entered. Render `prompt` once in the screen and call `confirm(action)`.
 * Used for changes that move money or tax: the UPI payee, GST settings, the bill series.
 */
export function useOwnerConfirm(title: string) {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const prompt = (
    <PinPrompt visible={pending !== null} title={title} onClose={() => setPending(null)}
      onSuccess={() => { const action = pending; setPending(null); action?.(); }} />
  );
  return { confirm: (action: () => void) => setPending(() => action), prompt };
}
