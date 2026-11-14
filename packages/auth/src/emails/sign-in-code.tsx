import type { Locale } from "@reranker/i18n";
import { COUNTRIES } from "@reranker/i18n/countries";
import {
  EmailBrandMark,
  EmailCode,
  EmailFooter,
  EmailHeading,
  EmailLayout,
  EmailText,
} from "@reranker/ui/email";
import { Hr } from "react-email";
import { SIGN_IN_CODE_TTL_SECONDS } from "../sign-in-code";
import { signInCodeCopy } from "./sign-in-code-copy";

export { signInCodeCopy };

const { legalEntity, name: country } = COUNTRIES.CO;
const minutes = SIGN_IN_CODE_TTL_SECONDS / 60;

// 902091972-5 is how the registry stores it; invoices and footers group the thousands.
const nit = legalEntity.taxId.value.replace(/^(\d{1,3})(\d{3})(\d{3})/, "$1.$2.$3");

export type RequestedFrom = { city: string; country: string };

export function SignInCodeEmail({
  otp,
  locale,
  requestedFrom,
}: {
  otp: string;
  locale: Locale;
  requestedFrom?: RequestedFrom | undefined;
}) {
  const copy = signInCodeCopy[locale];
  return (
    <EmailLayout
      lang={locale}
      preview={copy.preheader(minutes)}
      footer={
        <EmailFooter
          legal={copy.legal(legalEntity.name, nit, legalEntity.city, country)}
          links={[
            { label: copy.terms, href: "https://reranker.co/terminos" },
            { label: copy.privacy, href: "https://reranker.co/politica-de-datos" },
          ]}
        />
      }
    >
      <EmailBrandMark />
      <EmailHeading>{copy.heading}</EmailHeading>
      <EmailCode code={otp} />
      <EmailText>{copy.instruction(minutes)}</EmailText>
      {requestedFrom?.city && requestedFrom.country ? (
        <EmailText tone="soft" small>
          {copy.requestedFrom(requestedFrom.city, requestedFrom.country)}
        </EmailText>
      ) : null}
      <Hr className="rr-line my-6 border-0 border-t border-solid border-line" />
      <EmailText tone="soft" small>
        {copy.doNotShare}
      </EmailText>
      <EmailText tone="soft" small last>
        {copy.ignoreIfNotYou}
      </EmailText>
    </EmailLayout>
  );
}
