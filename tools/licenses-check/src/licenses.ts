export type LicensedPackage = { name: string; versions: string[]; license: string };
export type LicensesReport = Record<string, LicensedPackage[]>;
export type LicenseViolation = { name: string; versions: string[]; license: string };

export const ALLOWED_LICENSES: ReadonlySet<string> = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "Python-2.0",
  "Unlicense",
  "Zlib",
]);

export const LICENSE_EXCEPTIONS: ReadonlyArray<{
  packagePattern: string;
  license: string;
  reason: string;
}> = [
  {
    packagePattern: "@img/sharp-libvips-*",
    license: "LGPL-3.0-or-later",
    reason: "prebuilt libvips loaded dynamically by sharp (next/image)",
  },
];

const matchesPattern = (pattern: string, name: string): boolean =>
  new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`).test(name);

const escapeRegExp = (value: string): string => value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

const isIdentifierAllowed = (identifier: string, packageName: string): boolean =>
  ALLOWED_LICENSES.has(identifier) ||
  LICENSE_EXCEPTIONS.some(
    (exception) =>
      exception.license === identifier && matchesPattern(exception.packagePattern, packageName),
  );

// Recursive descent over SPDX expressions: OR < AND < parenthesized/identifier.
export function isLicenseAllowed(expression: string, packageName: string): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let position = 0;

  const parseOr = (): boolean => {
    let result = parseAnd();
    while (tokens[position] === "OR") {
      position++;
      const operand = parseAnd();
      result = result || operand;
    }
    return result;
  };

  const parseAnd = (): boolean => {
    let result = parsePrimary();
    while (tokens[position] === "AND") {
      position++;
      const operand = parsePrimary();
      result = result && operand;
    }
    return result;
  };

  const parsePrimary = (): boolean => {
    const token = tokens[position++];
    if (token === undefined || token === ")" || token === "AND" || token === "OR") {
      throw new SyntaxError(`Invalid license expression: ${expression}`);
    }
    if (token === "(") {
      const result = parseOr();
      if (tokens[position++] !== ")") {
        throw new SyntaxError(`Invalid license expression: ${expression}`);
      }
      return result;
    }
    return isIdentifierAllowed(token, packageName);
  };

  try {
    const result = parseOr();
    return position === tokens.length && result;
  } catch {
    return false;
  }
}

export function evaluateLicenses(report: LicensesReport): LicenseViolation[] {
  const violations: LicenseViolation[] = [];
  for (const packages of Object.values(report)) {
    for (const { name, versions, license } of packages) {
      if (!isLicenseAllowed(license, name)) {
        violations.push({ name, versions, license });
      }
    }
  }
  return violations;
}
