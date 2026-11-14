import { Link, Text } from "react-email";
import { copy } from "../copy.ts";

export function EmailFooter({
  legal,
  links = [],
  unsubscribeUrl,
}: {
  legal: string;
  links?: readonly { label: string; href: string }[];
  unsubscribeUrl?: string;
}) {
  return (
    <>
      <Text className="rr-soft m-0 text-center text-[13px] leading-5 text-ink-soft">{legal}</Text>
      {links.length > 0 ? (
        <Text className="rr-soft m-0 mt-1 text-center text-[13px] leading-5 text-ink-soft">
          {links.map((link, i) => (
            <span key={link.href}>
              {i > 0 ? " · " : null}
              <Link href={link.href} className="rr-soft text-ink-soft underline">
                {link.label}
              </Link>
            </span>
          ))}
        </Text>
      ) : null}
      {unsubscribeUrl ? (
        <Text className="rr-soft m-0 mt-1 text-center text-[13px] leading-5">
          <Link href={unsubscribeUrl} className="rr-soft text-ink-soft underline">
            {copy.email.unsubscribe}
          </Link>
        </Text>
      ) : null}
    </>
  );
}
