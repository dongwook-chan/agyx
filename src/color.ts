const codes = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
} as const;

function enabled(): boolean {
  return process.env.AGYX_NO_COLOR === undefined
    && process.env.TERM !== "dumb"
    && process.stdout.isTTY;
}

function wrap(code: string, value: string): string {
  return enabled() ? `${code}${value}${codes.reset}` : value;
}

export const color = {
  dim: (value: string) => wrap(codes.dim, value),
  red: (value: string) => wrap(codes.red, value),
  green: (value: string) => wrap(codes.green, value),
  yellow: (value: string) => wrap(codes.yellow, value),
  cyan: (value: string) => wrap(codes.cyan, value),
  gray: (value: string) => wrap(codes.gray, value),
};
