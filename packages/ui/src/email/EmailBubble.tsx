import { Section, Text } from "react-email";

// Text only: the web engine marks live behind the app, which mail clients cannot reach.
export function EmailBubble({ engineLabel, text }: { engineLabel: string; text: string }) {
  return (
    <Section className="mb-4 rounded-lg bg-bubble px-4 py-3">
      <Text className="m-0 mb-1 text-[13px] leading-5 font-semibold text-ink-soft">
        {engineLabel}
      </Text>
      <Text className="m-0 text-base leading-6 whitespace-pre-wrap text-ink">{text}</Text>
    </Section>
  );
}
