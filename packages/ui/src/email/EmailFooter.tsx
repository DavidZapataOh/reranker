import { Link, Section, Text } from "react-email";
import { copy } from "../copy.ts";

export function EmailFooter({
  legalName,
  unsubscribeUrl,
}: {
  legalName: "GLEMO S.A.S.";
  unsubscribeUrl?: string;
}) {
  return (
    <Section className="mt-6 border-0 border-t border-solid border-line pt-4">
      <Text className="m-0 text-[13px] leading-5 text-ink-soft">{legalName}</Text>
      {unsubscribeUrl ? (
        <Text className="m-0 mt-1 text-[13px] leading-5">
          <Link href={unsubscribeUrl} className="text-ink-soft underline">
            {copy.email.unsubscribe}
          </Link>
        </Text>
      ) : null}
    </Section>
  );
}
