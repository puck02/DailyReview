type ClipboardItemLike = {
  kind: string;
  type: string;
  getAsFile: () => File | null;
};

type ClipboardImageSource = {
  items?: ArrayLike<ClipboardItemLike> | null;
  files?: ArrayLike<File> | null;
};

export function firstClipboardImage(source: ClipboardImageSource | null | undefined): File | null {
  if (!source) return null;

  for (const item of Array.from(source.items || [])) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }

  return Array.from(source.files || []).find((file) => file.type.startsWith("image/")) || null;
}
