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
import { SLICES } from "../../../app/config/campaign";
import { SpinResult, TestBadge } from "./shared/SpinResult";
import { appUrlFromSettings, imageUrlFromSettings, useSpinStatus } from "./shared/useSpinStatus";

declare const shopify: import("@shopify/ui-extensions/purchase.thank-you.block.render").Api;

/** The best discount on the wheel, from the reward table, so the copy cannot drift from it. */
const MAX_DISCOUNT = Math.max(...SLICES.map((s) => s.discount?.percentage ?? 0));

/** One line, reward first. It replaces a heading plus a supporting line that said the same thing. */
const ELIGIBLE_LINE = `You've unlocked a spin. Win up to ${MAX_DISCOUNT}% off or a free GFJ gift.`;

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

    case "eligible":
      // A plain box rather than a banner: a banner draws its own status icon,
      // which sat alone above the wheel. Everything shares the wheel's centre
      // axis, and the line and button are one tight group beneath it.
      return (
        <s-box padding="base" border="base" borderRadius="base" background="subdued">
          <s-stack direction="block" gap="base" alignItems="center">
            {state.testMode ? (
              <s-badge size="small" color="subdued">
                Test spin
              </s-badge>
            ) : null}
            {wheelImage ? (
              <s-image
                src={wheelImage}
                alt=""
                inlineSize="fill"
                aspectRatio="1"
                objectFit="contain"
                loading="eager"
              />
            ) : null}
            <s-stack direction="block" gap="small-200" alignItems="center">
              <s-paragraph textAlign="center">
                <s-text type="strong">{ELIGIBLE_LINE}</s-text>
              </s-paragraph>
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
          </s-stack>
        </s-box>
      );

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
