import { Landing, landingMetadata } from "@/components/Landing";

export const metadata = landingMetadata;

export default function Page() {
  return <Landing currency="eur" />;
}
