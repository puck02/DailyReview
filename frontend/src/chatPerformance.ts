export function isNearScrollBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold = 80
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
