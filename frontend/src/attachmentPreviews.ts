export type PreviewRef = {
  id: number;
  previewUrl: string;
};

export function removeAttachmentPreview<T extends PreviewRef>(
  previews: T[],
  id: number
): { remaining: T[]; removed: T | null } {
  const removed = previews.find((preview) => preview.id === id) || null;
  if (!removed) return { remaining: previews, removed };
  return {
    remaining: previews.filter((preview) => preview.id !== id),
    removed
  };
}
