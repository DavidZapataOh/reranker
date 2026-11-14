import { Column, Row, Section } from "react-email";
import { tokens } from "../tokens.ts";

export function EmailCode({ code }: { code: string }) {
  if (!/^\d{6}$/.test(code)) throw new TypeError("The sign-in code must be exactly six digits");
  // One unbroken word so a long press selects all of it and mail apps can offer to copy it.
  // The padding on the left balances the spacing that trails the last digit.
  return (
    <Section className="mb-6">
      <Row>
        <Column
          align="center"
          className="rr-code"
          style={{
            backgroundColor: tokens.color.greenLight,
            color: tokens.color.ink,
            fontFamily: tokens.fontStack.text,
            fontSize: 36,
            fontWeight: 700,
            lineHeight: "44px",
            letterSpacing: 8,
            paddingLeft: 8,
            paddingTop: 20,
            paddingBottom: 20,
            fontVariantNumeric: "tabular-nums",
            userSelect: "all",
            WebkitUserSelect: "all",
            borderRadius: tokens.radius.md,
          }}
        >
          {code}
        </Column>
      </Row>
    </Section>
  );
}
