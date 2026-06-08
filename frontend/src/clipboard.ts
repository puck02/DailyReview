type ClipboardItemLike = {
  kind: string;
  type: string;
  getAsFile: () => File | null;
};

type ClipboardImageSource = {
  items?: ArrayLike<ClipboardItemLike> | null;
  files?: ArrayLike<File> | null;
};

const imageExtensions = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
const genericClipboardTypes = new Set(["", "application/octet-stream"]);

function hasImageExtension(name: string) {
  const lower = name.toLowerCase();
  return imageExtensions.some((extension) => lower.endsWith(extension));
}

function isClipboardImageCandidate(file: File, itemType = file.type) {
  const type = itemType || file.type || "";
  if (type.startsWith("image/")) return true;
  if (!genericClipboardTypes.has(type)) return false;
  return hasImageExtension(file.name) || file.size > 0;
}

export function firstClipboardImage(source: ClipboardImageSource | null | undefined): File | null {
  if (!source) return null;

  for (const item of Array.from(source.items || [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && isClipboardImageCandidate(file, item.type)) return file;
  }

  return Array.from(source.files || []).find((file) => isClipboardImageCandidate(file)) || null;
}
