/**
 * Spread and ratio expressions over symbols: "ZN-ZNH7", "ZN/ZB", "2*ZN-ZB", "100*(US10Y-US2Y)".
 * Numbers, symbols (letters, digits, _ and ., with at least one letter), + - * /, unary minus, parentheses.
 */

type Node = { k: 'num'; v: number } | { k: 'sym'; s: string } | { k: 'neg'; a: Node } | { k: 'bin'; op: string; a: Node; b: Node };

export interface Expr {
  text: string;
  legs: string[];
  eval(value: (sym: string) => number): number;
}

export const isExpression = (s: string) => /[-+*/()]/.test(s);

export function parseExpr(text: string): Expr {
  const src = text.replace(/\s+/g, '').toUpperCase();
  const toks = src.match(/\d+(?:\.\d+)?(?![A-Z_])|[A-Z0-9_.]*[A-Z][A-Z0-9_.]*|[-+*/()]/g) ?? [];
  if (toks.join('') !== src) throw new Error(`can't read "${text}"`);
  let i = 0;
  const peek = () => toks[i];
  const take = () => toks[i++];
  const legs = new Set<string>();
  const primary = (): Node => {
    const t = take();
    if (t === undefined) throw new Error(`"${text}" ends too soon`);
    if (t === '(') {
      const n = sum();
      if (take() !== ')') throw new Error(`"${text}": a ( is not closed`);
      return n;
    }
    if (t === '-') return { k: 'neg', a: primary() };
    if (/^\d/.test(t) && !/[A-Z]/.test(t)) return { k: 'num', v: Number(t) };
    if (/[A-Z]/.test(t)) {
      legs.add(t);
      return { k: 'sym', s: t };
    }
    throw new Error(`"${text}": unexpected ${t}`);
  };
  const product = (): Node => {
    let a = primary();
    while (peek() === '*' || peek() === '/') {
      const op = take();
      a = { k: 'bin', op, a, b: primary() };
    }
    return a;
  };
  const sum = (): Node => {
    let a = product();
    while (peek() === '+' || peek() === '-') {
      const op = take();
      a = { k: 'bin', op, a, b: product() };
    }
    return a;
  };
  const root = sum();
  if (i < toks.length) throw new Error(`"${text}": unexpected ${toks[i]}`);
  if (!legs.size) throw new Error(`"${text}" has no symbols`);
  const ev = (n: Node, v: (s: string) => number): number => {
    switch (n.k) {
      case 'num':
        return n.v;
      case 'sym':
        return v(n.s);
      case 'neg':
        return -ev(n.a, v);
      case 'bin': {
        const a = ev(n.a, v);
        const b = ev(n.b, v);
        return n.op === '+' ? a + b : n.op === '-' ? a - b : n.op === '*' ? a * b : a / b;
      }
    }
  };
  return { text: src, legs: [...legs], eval: v => ev(root, v) };
}
