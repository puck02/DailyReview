export type PreparedImage = {
  file: File;
  dataUrl: string;
};

const maxImageDimension = 1600;
const jpegQuality = 0.82;
const compressionThresholdBytes = 900 * 1024;
const genericClipboardTypes = new Set(["", "application/octet-stream"]);

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("图片压缩失败"));
    }, type, quality);
  });
}

function compressedFileName(name: string, type: string): string {
  const extension = type === "image/png" ? ".png" : ".jpg";
  return (name || "image").replace(/\.[^.]+$/, "") + extension;
}

function isLikelyImage(file: File): boolean {
  if (file.type.startsWith("image/")) return true;
  if (!genericClipboardTypes.has(file.type)) return false;
  return file.size > 0;
}

function loadHtmlImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片加载失败"));
    };
    image.src = url;
  });
}

function drawToCanvas(image: { width: number; height: number }, file: File): { canvas: HTMLCanvasElement; type: string } | null {
  const scale = Math.min(1, maxImageDimension / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image as CanvasImageSource, 0, 0, width, height);
  const type = "image/jpeg";
  return { canvas, type };
}

export async function prepareImageForUpload(file: File): Promise<PreparedImage> {
  if (!isLikelyImage(file) || file.type === "image/gif" || file.size <= compressionThresholdBytes) {
    return { file, dataUrl: await readAsDataUrl(file) };
  }

  let image: ImageBitmap | HTMLImageElement;
  try {
    image = "createImageBitmap" in window ? await createImageBitmap(file) : await loadHtmlImage(file);
  } catch {
    image = await loadHtmlImage(file);
  }

  const drawn = drawToCanvas(image, file);
  if (!drawn) {
    if ("close" in image && typeof image.close === "function") image.close();
    return { file, dataUrl: await readAsDataUrl(file) };
  }

  const { canvas, type } = drawn;
  const blob = await canvasBlob(canvas, type, type === "image/jpeg" ? jpegQuality : undefined);
  if ("close" in image && typeof image.close === "function") image.close();
  const output = blob.size < file.size ? new File([blob], compressedFileName(file.name, type), { type }) : file;
  return { file: output, dataUrl: await readAsDataUrl(output) };
}
