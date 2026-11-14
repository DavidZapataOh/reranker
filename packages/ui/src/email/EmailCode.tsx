import { Text } from "react-email";

export function EmailCode({ code }: { code: string }) {
  if (!/^\d{6}$/.test(code)) throw new TypeError("The sign-in code must be exactly six digits");
  // A real space keeps the code readable, and the code field strips it on paste.
  const grouped = `${code.slice(0, 3)} ${code.slice(3)}`;
  return (
    <Text className="m-0 mb-4 font-mono text-[32px] leading-10 font-bold tracking-[0.12em] text-ink">
      {grouped}
    </Text>
  );
}
