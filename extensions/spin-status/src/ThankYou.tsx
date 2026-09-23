/**
 * purchase.thank-you.block.render: the full flow.
 *
 * 1. Not eligible: an encouraging banner.
 * 2. Eligible, not yet spun: a button that links to the signed spin URL.
 * 3. Already spun: the stored reward with its expiry.
 *
 * Renders nothing when the campaign is closed for this customer.
 */
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { SpinResult, TestBadge } from "./shared/SpinResult";
import { appUrlFromSettings, useSpinStatus } from "./shared/useSpinStatus";

declare const shopify: import("@shopify/ui-extensions/purchase.thank-you.block.render").Api;

export default function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  const orderId = shopify.orderConfirmation.value?.order.id ?? null;
  const appUrl = appUrlFromSettings(shopify.settings.value as Record<string, unknown> | undefined);
  const { state, reload } = useSpinStatus({
    orderId,
    appUrl,
    getSessionToken: () => shopify.sessionToken.get(),
  });

  switch (state.kind) {
    case "closed":
      return null;

    case "loading":
    case "pending":
      return (
        <s-banner heading="GreenTee Spin to Win">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-spinner size="small" accessibilityLabel="Checking your order" />
            <s-text>Just a moment while we check your order…</s-text>
          </s-stack>
        </s-banner>
      );

    case "ineligible":
      return (
        <s-banner tone="info" heading="GreenTee Spin to Win">
          <s-stack direction="block" gap="small">
            <s-paragraph>{state.message}</s-paragraph>
            {state.testMode ? <TestBadge /> : null}
          </s-stack>
        </s-banner>
      );

    case "eligible":
      return (
        <s-banner tone="success" heading="You've unlocked a spin on the GreenTee wheel!">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              This order qualifies for one spin. Win a discount code for your next purchase or a
              complimentary GFJ gift.
            </s-paragraph>
            {state.spinUrl ? (
              <s-button variant="primary" href={state.spinUrl}>
                Spin the wheel
              </s-button>
            ) : (
              <s-paragraph color="subdued">
                Your spin link is being prepared. Refresh in a moment.
              </s-paragraph>
            )}
            {state.testMode ? <TestBadge /> : null}
          </s-stack>
        </s-banner>
      );

    case "spun":
      return <SpinResult result={state.result} testMode={state.testMode} surface="thank-you" />;

    case "error":
      // A misconfiguration (bad URL, rejected token) is not the customer's problem: show nothing.
      if (!state.retryable) return null;
      return (
        <s-banner tone="warning" heading="GreenTee Spin to Win">
          <s-stack direction="block" gap="small">
            <s-paragraph>We couldn't check your spin just now.</s-paragraph>
            <s-button variant="secondary" onClick={reload}>
              Try again
            </s-button>
          </s-stack>
        </s-banner>
      );
  }
}
