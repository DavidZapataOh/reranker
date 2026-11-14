import { Img, Section } from "react-email";

// A copy that never changes under this URL: mail already sent keeps requesting it for years.
export const BRAND_MARK_URL = "https://reranker.co/email/reranker-symbol-96.png";

export function EmailBrandMark() {
  return (
    <Section className="mb-6">
      <Img
        src={BRAND_MARK_URL}
        width={40}
        height={40}
        alt="Reranker"
        style={{ display: "block", borderRadius: 10 }}
      />
    </Section>
  );
}
