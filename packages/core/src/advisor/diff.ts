const MAX_LINES = 4000;
const CONTEXT = 3;

interface Op {
  op: ' ' | '-' | '+';
  line: string;
  /** Position in the old (`a`) and new (`b`) file where this line sits. */
  a: number;
  b: number;
}

/**
 * A unified diff, for reviewing a change before it is written. Small and dependency-free;
 * very large files fall back to showing the whole new content.
 */
export function unifiedDiff(path: string, before: string | null, after: string): string {
  const a = before === null ? [] : splitLines(before);
  const b = splitLines(after);
  const header = `--- ${before === null ? '/dev/null' : `a/${path}`}\n+++ b/${path}\n`;
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return `${header}@@ whole file @@\n${b.map((l) => `+${l}`).join('\n')}\n`;
  }
  const ops = diffOps(a, b);
  const hunks: string[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.op === ' ') {
      i++;
      continue;
    }
    const start = Math.max(0, i - CONTEXT);
    // Extend the hunk over later changes that are close by.
    let end = i;
    for (;;) {
      while (end < ops.length && ops[end]!.op !== ' ') end++;
      let next = end;
      while (next < ops.length && ops[next]!.op === ' ') next++;
      if (next < ops.length && next - end <= CONTEXT * 2) {
        end = next;
      } else {
        end = Math.min(ops.length, end + CONTEXT);
        break;
      }
    }
    const slice = ops.slice(start, end);
    const aCount = slice.filter((o) => o.op !== '+').length;
    const bCount = slice.filter((o) => o.op !== '-').length;
    const aStart = aCount ? slice[0]!.a + 1 : slice[0]!.a;
    const bStart = bCount ? slice[0]!.b + 1 : slice[0]!.b;
    hunks.push(
      `@@ -${aStart},${aCount} +${bStart},${bCount} @@\n` +
        slice.map((o) => `${o.op}${o.line}`).join('\n'),
    );
    i = end;
  }
  return `${header}${hunks.join('\n')}\n`;
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function diffOps(a: string[], b: string[]): Op[] {
  // Longest common subsequence of the middle part, after trimming the common prefix and suffix.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const n = am.length;
  const m = bm.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        am[i] === bm[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const ops: Op[] = [];
  for (let k = 0; k < pre; k++) ops.push({ op: ' ', line: a[k]!, a: k, b: k });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      ops.push({ op: ' ', line: am[i]!, a: pre + i, b: pre + j });
      i++;
      j++;
    } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      ops.push({ op: '-', line: am[i]!, a: pre + i, b: pre + j });
      i++;
    } else {
      ops.push({ op: '+', line: bm[j]!, a: pre + i, b: pre + j });
      j++;
    }
  }
  for (let k = 0; k < suf; k++) {
    const ai = a.length - suf + k;
    ops.push({ op: ' ', line: a[ai]!, a: ai, b: b.length - suf + k });
  }
  return ops;
}
