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

export async function insertAndReturnId(result: D1Result): Promise<number> {
  const meta = result.meta as { last_row_id?: number; lastRowId?: number } | undefined;
  const id = meta?.last_row_id ?? meta?.lastRowId;
  if (typeof id !== "number") {
    throw new Error("D1 insert did not return last row id");
  }
  return id;
}
