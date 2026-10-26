/**
 * Android back button in the Captain app: close the top dialog first, then leave
 * the current screen. Returns false when nothing is left, so the app may exit.
 */
export function androidBack(openDialogs: ArrayLike<Pick<HTMLDialogElement, "dispatchEvent" | "close">>, navigate: () => boolean): boolean {
  const top = openDialogs[openDialogs.length - 1];
  if (!top) return navigate();
  // Same path as the Escape key, so busy dialogs can refuse to close.
  if (top.dispatchEvent(new Event("cancel", { cancelable: true }))) top.close();
  return true;
}

export function listenForAndroidBack(navigate: () => boolean) {
  (window as Window & { forkflowBack?: () => boolean }).forkflowBack = () => androidBack(document.querySelectorAll<HTMLDialogElement>("dialog[open]"), navigate);
}
