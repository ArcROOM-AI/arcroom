// What to hand over before a prompt, and how much: every piece the Room found (steps or an answer, a playbook, team
// knowledge, the code map) gets a usefulness score, and they share one budget, best first.
//   score = value (how close, how proven, how fresh: set where the piece is made, 0..1)
//         × weight (what this kind of hand-over did for the turn after it in this team; learned by the database, 0030)
//         × route (what this prompt is about: "why" wants decisions, "who is editing" wants the code map)

export type Kind = 'recall' | 'playbook' | 'knowledge' | 'code';
/** title: one line naming the piece for `arcroom handed` (never sent, never handed to the agent) */
export type Piece = { kind: Kind; text: string; value: number; title?: string };
export type Cut = { kind: Kind; title?: string; chars: number; reason: string };

export const BUDGET = 2400; // characters, about 600 tokens, for everything handed over before a prompt
const MIN_PIECE = 240; // a piece clipped shorter than this says too little: left out instead

/** Which kinds of memory this prompt needs more of. */
export function route(prompt: string): Partial<Record<Kind, number>> {
  const p = prompt.toLowerCase();
  const r: Partial<Record<Kind, number>> = {};
  if (/\b(why|decid\w*|decision\w*|chose|choose|convention\w*|polic\w*|agreed|should we)\b/.test(p)) r.knowledge = 1.4;
  if (/\b(who|editing|conflicts?|branch\w*|merge\w*|folders?|where is|which files?)\b/.test(p)) r.code = 1.4;
  if (/\b(fix|bug|add|implement|refactor|tests?|rename|remove|change|update)\b|\w\.[a-z]{1,5}\b/.test(p)) r.recall = r.playbook = 1.2;
  return r;
}

/** The pieces worth handing over, best first, within the budget; the last one that does not fit is clipped. */
export function pack(pieces: Piece[], prompt: string, weights: Record<string, number> = {}, budget = BUDGET): Piece[] {
  const routed = route(prompt);
  const score = (p: Piece) => p.value * (Number(weights[p.kind]) || 1) * (routed[p.kind] ?? 1);
  const out: Piece[] = [];
  let left = budget;
  for (const p of [...pieces].sort((a, b) => score(b) - score(a))) {
    if (p.text.length <= left) {
      out.push(p);
      left -= p.text.length;
    } else if (left >= MIN_PIECE) {
      out.push({ ...p, text: `${p.text.slice(0, left - 1)}…` });
      left = 0;
    }
  }
  return out;
}

/** What pack() left out or cut short, with why: compares what went in with what came out (one piece per kind). */
export function cutsOf(pieces: Piece[], kept: Piece[]): Cut[] {
  return pieces.flatMap((p): Cut[] => {
    const k = kept.find((x) => x.kind === p.kind);
    if (!k) return [{ kind: p.kind, title: p.title, chars: p.text.length, reason: 'over budget' }];
    if (k.text.length < p.text.length) return [{ kind: p.kind, title: p.title, chars: p.text.length, reason: `cut to ${k.text.length} chars` }];
    return [];
  });
}
