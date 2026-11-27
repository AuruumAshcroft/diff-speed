// Fast drop-in for makefun-diff 1.0.0 (make.fun's own line diff, MIT, derived from jsdiff 9.0.0).
// run(input) returns byte-for-byte the same patch string makefun-diff 1.0.0's diffPatch returns
// for the same input { old, new }, but much faster.
//
// The rule, exactly as the reference states it: a text is cut after every "\n" (the only separator;
// a last line with no "\n" is a line too); two lines are equal only when they are the same code
// units, newline or its absence included. The common prefix of lines is kept, then the common
// suffix of the lines left; between them, Myers's greedy search from the first lines, which keeps
// on each diagonal the path reaching furthest into the old text and, when a deletion and an
// insertion reach the same point, the deletion's, never moves past either text's end, prunes no
// edge diagonal, and follows every run of lines equal in both as far as it goes; the first path
// to reach both ends is the script. The patch is "makefun-diff/1 old=N new=M hunks=H deleted=D
// inserted=I", then per hunk "@ os ol ns nl" and one line per line it covers ("=" kept, "-" deleted,
// "+" inserted; deletions before insertions in one change run; up to 3 kept lines before and after
// each run; two runs at most 6 kept lines apart share a hunk). A line with no trailing newline is
// written with one and followed by a line "%". Identical texts are the first line alone.
//
// How this is faster than the reference: the reference builds a fresh path object (plus a fresh
// component object) for every (d, k) cell of the search, millions of allocations per case. This
// module instead keeps the furthest x per diagonal in one flat Int32Array "trace" (offset(d) = d*d),
// writes each depth's V row into it, and backtracks from the first reaching cell by recomputing
// each step's move from the stored V rows with the very same tie-break and validity rules, so the
// script it rebuilds is exactly the reference's. Lines are interned to integer ids once (one Map
// shared by both texts), so every comparison in the prefix, suffix and snakes is a single int
// compare instead of a string compare, and no line string is ever rebuilt with a "\n" appended.

const FORMAT = 'makefun-diff/1';
const CONTEXT = 3;
const KEEP = '=';
const DELETE = '-';
const INSERT = '+';

// ---------------------------------------------------------------- scratch state
// Reused across cases; every cell read in a run was written in that same run, so no
// answer data ever carries from one case to the next. trace holds depth d at flat
// offset d*d, diagonal k at d*d + (k + d), storing x + 1 (x = old lines consumed after
// the snake), so 0 means "no path on that diagonal" and a fresh array needs no fill.
let trace = new Int32Array(0);
let traceCap = 0; // trace holds depths 0..traceCap-1, length traceCap * traceCap

function ensureTrace(d) {
  if (d < traceCap) return;
  let cap = traceCap === 0 ? 4096 : traceCap;
  while (cap <= d) cap *= 2;
  const next = new Int32Array(cap * cap);
  if (traceCap > 0) next.set(trace.subarray(0, traceCap * traceCap));
  trace = next;
  traceCap = cap;
}

// ---------------------------------------------------------------- tokenize + intern
// A text's lines: strs[i] is the line's content without its "\n", nl[i] is 1 when the line
// ends with "\n" (every line but possibly the last), ids[i] is (mapId << 1) | nl[i], so one
// int compare decides line equality exactly as the reference's string compare does.
function tokenize(text, map) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const hasLast = parts[last] !== '';
  const count = last + (hasLast ? 1 : 0);
  const strs = new Array(count);
  const nl = new Uint8Array(count);
  const ids = new Int32Array(count);
  for (let i = 0; i < last; i++) {
    const s = parts[i];
    let id = map.get(s);
    if (id === undefined) { id = map.size; map.set(s, id); }
    strs[i] = s;
    nl[i] = 1;
    ids[i] = (id << 1) | 1;
  }
  if (hasLast) {
    const s = parts[last];
    let id = map.get(s);
    if (id === undefined) { id = map.size; map.set(s, id); }
    strs[last] = s;
    nl[last] = 0;
    ids[last] = id << 1;
  }
  return { strs, nl, ids, count };
}

// ---------------------------------------------------------------- the patch
/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, line, hasNl) {
  return hasNl ? `${op}${line}\n` : `${op}${line}\n%\n`;
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const map = new Map();
  const A = tokenize(input.old, map);
  // Identical texts share one tokenization; the lines are then trivially identical.
  const B = input.old === input.new ? A : tokenize(input.new, map);
  const n = A.count;
  const m = B.count;
  const aIds = A.ids;
  const bIds = B.ids;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && aIds[prefix] === bIds[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && aIds[n - 1 - suffix] === bIds[m - 1 - suffix]) suffix++;

  const n2 = n - prefix - suffix; // middle old lines
  const m2 = m - prefix - suffix; // middle new lines
  const aMid = aIds.subarray(prefix, prefix + n2);
  const bMid = bIds.subarray(prefix, prefix + m2);

  // ---------------------------------------------------------- Myers's search
  // V[d][k] (x + 1, x = old lines consumed, after the snake; 0 = no path on that diagonal)
  // lives at trace[d*d + (k + d)].
  // Candidates from depth d-1: deletion reaches vDown (vDown stored x + 1, needs vDown <= n2),
  // insertion reaches vUp - 1 (needs vUp - k - 2 < m2); the deletion wins when both reach one point.
  let D = -1;
  let kEnd = 0;
  ensureTrace(0);
  let x = 0;
  let y = 0;
  while (x < n2 && y < m2 && aMid[x] === bMid[y]) { x++; y++; }
  trace[0] = x + 1;
  if (x === n2 && y === m2) {
    D = 0;
  } else {
    outer:
    for (let d = 1; d <= n2 + m2; d++) {
      ensureTrace(d);
      const base = d * d;
      const prev = (d - 1) * (d - 1);
      // Running trace indices: vDown's index grows by 2 per k, vUp's too, the write index too.
      // vDown/vUp store x + 1 (0 = no path); the deletion reaches vDown, the insertion vUp - 1.
      let iDown = prev - 2;
      let iUp = prev;
      let iWrite = base;
      for (let k = -d; k <= d; k += 2) {
        const vDown = k === -d ? 0 : trace[iDown];
        const vUp = k === d ? 0 : trace[iUp];
        iDown += 2;
        iUp += 2;
        const canDel = vDown !== 0 && vDown <= n2;
        const canAdd = vUp !== 0 && vUp - k - 2 < m2;
        if (!canDel && !canAdd) { iWrite += 2; continue; }
        const xDel = canDel ? vDown : -2;
        const xIns = canAdd ? vUp - 1 : -2;
        let xx = xDel >= xIns ? xDel : xIns;
        let yy = xx - k;
        while (xx < n2 && yy < m2 && aMid[xx] === bMid[yy]) { xx++; yy++; }
        trace[iWrite] = xx + 1;
        iWrite += 2;
        if (xx === n2 && yy === m2) { D = d; kEnd = k; break outer; }
      }
    }
  }
  if (D < 0) throw new Error('makefun-diff: the search ended without reaching both ends');

  // ---------------------------------------------------------- backtrack the script
  // Recompute each step's move from the stored V rows with the same rules, so the
  // rebuilt script is the reference's own. ops come out in reverse order.
  const rev = [];
  let d = D;
  let k = kEnd;
  let xx = trace[D * D + kEnd + D] - 1;
  while (d > 0) {
    const prev = (d - 1) * (d - 1);
    const vDown = k === -d ? 0 : trace[prev + (k - 1) + (d - 1)];
    const vUp = k === d ? 0 : trace[prev + (k + 1) + (d - 1)];
    const canDel = vDown !== 0 && vDown <= n2;
    const canAdd = vUp !== 0 && vUp - k - 2 < m2;
    const xDel = canDel ? vDown : -2;
    const xIns = canAdd ? vUp - 1 : -2;
    let xStep;
    let move;
    if (xDel >= xIns) { xStep = xDel; move = DELETE; } else { xStep = xIns; move = INSERT; }
    const snakeLen = xx - xStep;
    if (snakeLen > 0) rev.push({ kind: KEEP, count: snakeLen });
    rev.push({ kind: move, count: 1 });
    xx = (move === DELETE ? vDown : vUp) - 1;
    k = move === DELETE ? k - 1 : k + 1;
    d--;
  }
  const x0 = trace[0] - 1;
  if (x0 > 0) rev.push({ kind: KEEP, count: x0 });
  // Reverse and coalesce consecutive runs of one kind into the middle's runs.
  const midRuns = [];
  for (let i = rev.length - 1; i >= 0; i--) {
    const op = rev[i];
    const last = midRuns[midRuns.length - 1];
    if (last !== undefined && last.kind === op.kind) last.count += op.count;
    else midRuns.push({ kind: op.kind, count: op.count });
  }

  // The full runs: the kept prefix, the middle's runs, the kept suffix.
  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  for (const r of midRuns) runs.push(r);
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  const aStrs = A.strs;
  const aNl = A.nl;
  const bStrs = B.strs;
  const bNl = B.nl;
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written(KEEP, aStrs[at], aNl[at]));
      for (let i = 0; i < c.dels; i++) out.push(written(DELETE, aStrs[c.o + i], aNl[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written(INSERT, bStrs[c.p + i], bNl[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written(KEEP, aStrs[at], aNl[at]));
  }
  return out.join('');
}
