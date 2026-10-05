const INPUT_LIMIT = 10 * 1024 * 1024;
const JPEG_LIMIT = 400 * 1024;
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function jpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (blob?.type === "image/jpeg") resolve(blob);
    else reject(new Error("This browser could not prepare the photo. Try another image."));
  }, "image/jpeg", quality));
}

function asDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the prepared photo."));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read the prepared photo."));
    reader.readAsDataURL(blob);
  });
}

/** Normalizes a local upload before it enters a product draft or API request. */
export async function prepareProductPhoto(file: File): Promise<string> {
  if (!TYPES.has(file.type)) throw new Error("Choose a JPEG, PNG, or WebP photo.");
  if (file.size === 0 || file.size > INPUT_LIMIT) throw new Error("Choose a photo no larger than 10 MB.");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("This photo could not be opened. Choose a valid JPEG, PNG, or WebP image."); }
  try {
    if (!bitmap.width || !bitmap.height) throw new Error("The photo has no usable image content.");
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not prepare the photo.");
    let longest = Math.min(1200, Math.max(bitmap.width, bitmap.height));
    for (let resize = 0; resize < 7; resize++) {
      const scale = longest / Math.max(bitmap.width, bitmap.height);
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.86, 0.74, 0.62, 0.5]) {
        const jpeg = await jpegBlob(canvas, quality);
        if (jpeg.size <= JPEG_LIMIT) return asDataUrl(jpeg);
      }
      longest = Math.max(1, Math.floor(longest * 0.8));
    }
    throw new Error("This photo is too detailed to save. Choose a simpler or smaller image.");
  } finally { bitmap.close(); }
}
