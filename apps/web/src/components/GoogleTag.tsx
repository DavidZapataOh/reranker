import Script from "next/script";
import { GA_ID } from "@/lib/analytics-config";

/**
 * GA4 with Consent Mode v2 defaulting to "denied". Rendered from the root layout
 * (a server component) so the injected tags never cause a hydration mismatch.
 * Analytics.tsx flips analytics_storage to "granted" when the visitor accepts.
 */
export function GoogleTag() {
  if (!GA_ID) return null;
  return (
    <>
      <Script id="rr-ga-consent" strategy="lazyOnload">
        {`window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}window.gtag=gtag;
gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied'});
gtag('js',new Date());gtag('config','${GA_ID}');`}
      </Script>
      <Script
        id="rr-ga"
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
        strategy="lazyOnload"
      />
    </>
  );
}
