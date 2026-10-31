import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Secret redaction: runs on every event before it is written to the local queue and again before it leaves the machine,
// and on every request body sent to the API.
// Two layers: this machine's own secret VALUES (sensitive environment variables, values in a project's .env files),
// removed wherever they appear whatever their shape; then patterns for common key formats and key=value secrets.
// ponytail: patterns don't catch every secret shape. Add them as we meet them; a generic high-entropy rule would also
// hit commit hashes and ids, so there is none.

const R = '[REDACTED]';

// --- exact values -------------------------------------------------------------------------------------------------
// auth but not GIT_AUTHOR_NAME; *_SCOPES lists permissions, not a secret
const SECRET_NAME = /^(?!.*_SCOPES?$).*(?:key|token|secret|passw(?:or)?d|pass\b|_pass|pwd|credential|auth(?!or)|dsn|private|cookie)/i;
// ids are not secrets, and events carry them (a session id redacted would split a run)
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{40}$/i;
const known = new Set<string>();
let longestFirst: string[] = []; // so a value that contains another known value goes whole
const read = new Set<string>();

/** Keeps a value to redact: under a secret-looking name, or (in .env files, `loose`) any long value mixing letters and digits. */
function keep(name: string, raw: string | undefined, loose: boolean): void {
  const v = raw?.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!v || v.length < 8 || /^(?:true|false|null|\d+)$/i.test(v) || ID.test(v) || known.has(v)) return;
  // a path or a URL without a login is config, not a secret (GIT_ASKPASS, KEYCHAIN_PATH, AUTH_URL)
  if (/^(?:[.~/\\]|[a-z]:[\\/]|[a-z][\w+.-]*:\/\/[^@\s]*$)/i.test(v)) return;
  const mixed = v.length >= 16 && /\d/.test(v) && /[a-z]/i.test(v);
  if (!SECRET_NAME.test(name) && !(loose && mixed)) return;
  known.add(v);
  longestFirst = [...known].sort((a, b) => b.length - a.length);
}

/** This process's sensitive environment variables (the agent passes the user's shell environment to its hooks). */
export function rememberEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [k, v] of Object.entries(env)) keep(k, v, false);
}
rememberEnv();

/** The values in a project's .env files (not .env.example and friends); each folder is read once per process. */
export function rememberSecrets(dir: unknown): void {
  if (typeof dir !== 'string' || !dir || read.has(dir)) return;
  read.add(dir);
  try {
    for (const f of readdirSync(dir)) {
      if (!/^\.env(?:\.|$)/.test(f) || /\.(?:example|sample|template|dist)$/.test(f)) continue;
      for (const line of readFileSync(join(dir, f), 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/);
        if (m) keep(m[1], m[2].replace(/\s+#.*$/, ''), true);
      }
    }
  } catch {
    // no folder or no access: patterns still apply
  }
}

// --- patterns -----------------------------------------------------------------------------------------------------
const TOKENS = [
  // private keys, also when a cut-off preview lost the END line
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /\b(?:sk-ant-[\w-]{10,}|sk-[\w-]{20,}|ar[ksi]_[\w-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[\w-]{35})/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|\bglpat-[\w-]{20,}|\bnpm_[A-Za-z0-9]{30,}|\bhf_[A-Za-z0-9]{30,}|\bya29\.[\w-]{20,}|\bSG\.[\w-]{16,}\.[\w-]{16,}/g,
  /https:\/\/hooks\.slack\.com\/services\/[\w/]+/g,
  // more provider formats (after gitleaks' rules): Shopify, Twilio, Mailgun, DigitalOcean, Linear, PyPI, Doppler, Postman, Databricks
  /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b|\bSK[0-9a-f]{32}\b|\bkey-[0-9a-f]{32}\b|\bdo[opr]_v1_[a-f0-9]{64}\b|\blin_api_[A-Za-z0-9]{40}\b/g,
  /\bpypi-AgEIcHlwaS5vcmc[\w-]{50,}|\bdp\.(?:pt|st|sa|ct|scim|audit)\.[A-Za-z0-9]{40,}|\bPMAK-[a-f0-9]{24}-[a-f0-9]{34}\b|\bdapi[a-f0-9]{32}\b/g,
  /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, // JWTs, including Supabase keys
];
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:)[^\s@"']+(@)/gi;
// NAME=value, "name": "value", also inside escaped JSON (\"password\": \"x\")
const KEY_VALUE =
  /\b((?:[\w-]*(?:password|passwd|pwd|_pass|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|_key|credentials?|accountkey|signature))(?:\\?["'])?\s*[:=]\s*(?:\\?["'])?)(?:Bearer\s+)?[^\s"'\\,;&]{6,}/gi;
// a secret written in words: "my password is hunter2", "pwd: abc", "the api key is …", "password hai Qwerty@12"; a word
// that only describes it ("password is required", "the token is expired") is left alone
const PROSE_SKIP = 'the|a|an|not|too|so|in|on|at|for|of|to|ok|fine|set|same|required|wrong|incorrect|correct|missing|empty|invalid|expired|changed|reset|stored|saved|weak|strong|long|short|needed|different|valid';
const PROSE = new RegExp(
  `(\\b(?:password|passwd|pwd|passcode|passphrase|secret|token|api[ -]?key|pin)\\s+(?:is|was|hai|he)\\s+|\\b(?:password|passwd|pwd|passcode|passphrase|pin)\\s*[:=]\\s*)` +
    `(?!\\[REDACTED\\])(?!(?:${PROSE_SKIP})\\b)["'\`]?[^\\s"'\`,;!?]{3,}`,
  'gi',
);
const BEARER = /\b(Bearer\s+)[\w.~+/-]{10,}=*/g;
const BASIC = /\b(Basic\s+)[A-Za-z0-9+/]{8,}=*/g;
const COOKIE = /(\b(?:Set-)?Cookie:\s*)[^\n"'\\]+/gi;
// secrets passed as command flags: mysql -pX, --password X, curl -u user:pass, X-Amz-Signature=…
const FLAGS = [
  /(\b(?:mysql|mysqldump|mariadb)\b[^\n]*?\s-p)(?!\s)[^\s"']+/g,
  /(--(?:password|pass|token|secret|api-key)[=\s]+)[^\s"']+/gi,
  /(\s(?:-u|--user)\s+[^\s:"']+:)[^\s"']+/g,
  /((?:X-Amz-Signature|X-Amz-Credential|sig)=)[^&\s"']+/g,
];
const SENSITIVE_KEY = /(?:^|[_-])(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie|credentials?)$/i;
/** Files whose contents are secrets: their reads, writes and command output are not kept at all. */
const SENSITIVE_FILE = /(?:^|[\\/\s"'=])(?:\.env(?:\.[\w.-]+)?|[^\\/\s"']*\.(?:pem|key|p12|pfx|keystore|jks)|id_(?:rsa|dsa|ecdsa|ed25519)|\.npmrc|\.netrc|\.pgpass|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml))(?:$|[\s"'|;&)])/i;

export const sensitiveFile = (text: unknown) => typeof text === 'string' && SENSITIVE_FILE.test(text) && !/\.env\.example\b/i.test(text);

export function redactText(text: string): string {
  let out = text;
  for (const v of longestFirst) if (out.includes(v)) out = out.split(v).join(R);
  for (const re of TOKENS) out = out.replace(re, R);
  for (const re of FLAGS) out = out.replace(re, `$1${R}`);
  return out
    .replace(URL_PASSWORD, `$1${R}$2`)
    .replace(KEY_VALUE, `$1${R}`)
    .replace(PROSE, `$1${R}`)
    .replace(BEARER, `$1${R}`)
    .replace(BASIC, `$1${R}`)
    .replace(COOKIE, `$1${R}`);
}

/** Redacts every string in a JSON-like value; a string under a sensitive key (or in a list under one) is dropped whole. */
export function redact<T>(value: T, key = ''): T {
  if (typeof value === 'string') return (SENSITIVE_KEY.test(key) ? R : redactText(value)) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, key)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)])) as T;
  }
  return value;
}
