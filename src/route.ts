// Model router: which Claude model a (sub)task should run on.
// A replay uses the cheapest model that already passed with these steps; a new task is routed by the kind of work.
// ponytail: verb-based tiers; learn from outcomes (cost + done-check results per model) once enough runs exist.

export type Tier = 'haiku' | 'sonnet' | 'opus';
export type Route = { model: Tier; why: string };

const TIERS: [RegExp, Tier, string][] = [
  [/^(list|find|look ?up|fetch|read|summari[sz]e|count|check|search|scan|extract|classify|translate|format|compare)\b/, 'haiku', 'lookup or summary'],
  [/^(write|implement|fix|patch|refactor|add|update|create|test|migrate|convert|rename|remove)\b/, 'sonnet', 'writing or changing code'],
  [/^(plan|design|architect|decide|review|debug|investigate|split|evaluate|choose)\b/, 'opus', 'planning or judgment'],
];

const alias = (model: string | undefined): Tier | undefined =>
  model?.includes('haiku') ? 'haiku' : model?.includes('sonnet') ? 'sonnet' : model?.includes('opus') ? 'opus' : undefined;

export function routeFor(intent: string, provenModel?: string): Route | undefined {
  const proven = alias(provenModel);
  if (proven) return { model: proven, why: 'cheapest model that did these steps before' };
  const verb = intent.trim().toLowerCase();
  for (const [re, model, why] of TIERS) if (re.test(verb)) return { model, why };
  return undefined;
}

/** Adds `route` to lookups that still need work (replay or new). Reuse needs no model: the answer is already there. */
export function withRoute<T extends Record<string, any>>(r: T, intent: string): T & { route?: Route } {
  if (r?.match !== 'replay' && r?.match !== 'none') return r;
  const route = routeFor(r.intent ?? intent, r.procedure?.model);
  return route ? { ...r, route } : r;
}
