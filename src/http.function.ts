export function bearerMatches(header: string | null, key: string | undefined): boolean {
  if (!key || !header?.startsWith("Bearer ")) return false;
  const given = new TextEncoder().encode(header.slice("Bearer ".length).trim());
  const wanted = new TextEncoder().encode(key);
  let diff = given.length ^ wanted.length;
  for (let i = 0; i < wanted.length; i++) diff |= (given[i] ?? 0) ^ (wanted[i] as number);
  return diff === 0;
}

export function agentIdFrom(header: string | null): string | undefined {
  const trimmed = header?.trim();
  return trimmed ? trimmed : undefined;
}
