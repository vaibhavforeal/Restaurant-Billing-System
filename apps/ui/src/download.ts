/** Download a generated file in both the desktop shell and ordinary browsers. */
export function downloadText(text: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  try {
    const link = document.createElement("a");
    link.href = url; link.download = filename;
    document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); }
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}
