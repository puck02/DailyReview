export type Row = Record<string, unknown>;

export async function first<T extends Row>(stmt: D1PreparedStatement): Promise<T | null> {
  return await stmt.first<T>();
}

export async function all<T extends Row>(stmt: D1PreparedStatement): Promise<T[]> {
  const result = await stmt.all<T>();
  return result.results || [];
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function boolFromDb(value: unknown): boolean {
  return value === 1 || value === true;
}

export function boolToDb(value: boolean): number {
  return value ? 1 : 0;
}
