export type PreparedImage = {
  file: File;
  dataUrl: string;
};

const maxImageDimension = 1600;
const jpegQuality = 0.82;
const compressionThresholdBytes = 900 * 1024;

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

export async function prepareImageForUpload(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith("image/") || file.type === "image/gif" || file.size <= compressionThresholdBytes || !("createImageBitmap" in window)) {
    return { file, dataUrl: await readAsDataUrl(file) };
  }

  const image = await createImageBitmap(file);
  const scale = Math.min(1, maxImageDimension / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    image.close();
    return { file, dataUrl: await readAsDataUrl(file) };
  }

  context.drawImage(image, 0, 0, width, height);
  image.close();
  const type = file.type === "image/png" ? "image/png" : "image/jpeg";
  const blob = await canvasBlob(canvas, type, type === "image/jpeg" ? jpegQuality : undefined);
  const output = blob.size < file.size ? new File([blob], compressedFileName(file.name, type), { type }) : file;
  return { file: output, dataUrl: await readAsDataUrl(output) };
}
