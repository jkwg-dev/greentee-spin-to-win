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
import { appUrlFromSettings, imageUrlFromSettings, useSpinStatus } from "./shared/useSpinStatus";

declare const shopify: import("@shopify/ui-extensions/purchase.thank-you.block.render").Api;

/** Short, names the reward, not the mechanic. */
const ELIGIBLE_HEADING = "You've unlocked a spin";

export default function extension() {
  render(<Extension />, document.body);
}

function Extension() {
  const orderId = shopify.orderConfirmation.value?.order.id ?? null;
  const settings = shopify.settings.value as Record<string, unknown> | undefined;
  const appUrl = appUrlFromSettings(settings);
  const wheelImage = imageUrlFromSettings(settings);
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

    case "eligible": {
      // Three things, top to bottom: bold heading, the wheel, the button, sitting
      // directly in the page with no container. The outer box carries vertical
      // padding only, so the group does not crowd the blocks above and below.
      const image = wheelImage ? (
        <s-image
          src={wheelImage}
          alt=""
          inlineSize="fill"
          aspectRatio="1"
          objectFit="contain"
          loading="eager"
        />
      ) : null;
      return (
        <s-box paddingBlock="large">
          <s-stack direction="block" gap="base" alignItems="center">
            {state.testMode ? (
              <s-badge size="small" color="subdued">
                Test spin
              </s-badge>
            ) : null}
            <s-heading>{ELIGIBLE_HEADING}</s-heading>
            {image && state.spinUrl ? (
              // Tapping the wheel does what the button does.
              <s-clickable
                href={state.spinUrl}
                inlineSize="100%"
                accessibilityLabel="Spin the wheel"
              >
                {image}
              </s-clickable>
            ) : (
              image
            )}
            {state.spinUrl ? (
              <s-button variant="primary" href={state.spinUrl}>
                Spin the wheel
              </s-button>
            ) : (
              <s-paragraph color="subdued" textAlign="center">
                Your spin link is being prepared. Refresh in a moment.
              </s-paragraph>
            )}
          </s-stack>
        </s-box>
      );
    }

    case "spun":
      return (
        <SpinResult
          result={state.result}
          testMode={state.testMode}
          surface="thank-you"
          spinUrl={state.spinUrl}
        />
      );

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
