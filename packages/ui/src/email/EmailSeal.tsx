import { Link, Text } from "react-email";
import { copy } from "../copy.ts";
import { assertVerifyUrl } from "../evidence/verifyUrl.ts";

// Mail has no origin to resolve against, so only the absolute canonical form is allowed.
function absoluteVerifyUrl(url: string): string {
  if (!/^https:\/\//i.test(url))
    throw new TypeError(`Not an absolute verification link: ${JSON.stringify(url)}`);
  return assertVerifyUrl(url);
}

export function EmailSeal({
  capturedAtLabel,
  cityLabel,
  verifyUrl,
}: {
  capturedAtLabel: string;
  cityLabel: string;
  verifyUrl: string;
}) {
  const href = absoluteVerifyUrl(verifyUrl);
  return (
    <Text className="m-0 mb-4 font-mono text-[13px] leading-5 text-ink">
      ✔ {copy.seal.inline(capturedAtLabel, cityLabel)}
      {" · "}
      <Link href={href} className="text-green underline">
        {copy.seal.verify}
      </Link>
    </Text>
  );
}
